import { useCallback, useRef, useState } from 'react';
import { useAppDispatch } from '../../../../app/store/hooks';
import { API_BASE_URL, baseApi } from '../../../../shared/api';
import {
  messagesApi,
  useGetMessagesQuery,
  type Message,
  type MessageFile,
} from '../../../../entities/message';

interface UseSendMessageArgs {
  conversationId: string | undefined;
  refetch: ReturnType<typeof useGetMessagesQuery>['refetch'];
  hasMessages: boolean;
  /** `createdAt` of the newest message in cache when the send begins. The
   * post-stream `pollMessages` call uses this as its `after` filter so we
   * only pull in genuinely new rows. Without it the server returns the
   * full conversation tail (up to 200 rows) and the cache merge silently
   * surfaces messages the user had never loaded — they're real DB content,
   * just older than the initial `GET /message/conversation/:id` page. */
  lastMessageTs?: string;
}

export interface SendMessageState {
  isStreaming: boolean;
  streamingText: string;
  streamingThinking: string;
  streamError: string | null;
  pendingUserText: string;
  pendingFilesPreviews: MessageFile[];
  send: (text: string, files: File[]) => Promise<void>;
  abort: () => void;
  clearError: () => void;
}

/**
 * Owns the fetch/stream lifecycle for sending a chat message.
 * Keeps UI-facing state (streaming text, pending previews) local.
 */
export function useSendMessage({
  conversationId,
  refetch,
  hasMessages,
  lastMessageTs,
}: UseSendMessageArgs): SendMessageState {
  const [streamingText, setStreamingText] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserText, setPendingUserText] = useState('');
  const [pendingFilesPreviews, setPendingFilesPreviews] = useState<MessageFile[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  /* Mirror `lastMessageTs` into a ref so the `send` callback can read the
   * latest value without re-creating itself every time a new message lands
   * (which would otherwise re-trigger the parent's memoized props chain). */
  const lastMessageTsRef = useRef<string | undefined>(lastMessageTs);
  lastMessageTsRef.current = lastMessageTs;
  const dispatch = useAppDispatch();

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const clearError = useCallback(() => setStreamError(null), []);

  const send = useCallback(
    async (text: string, files: File[]) => {
      const trimmed = text.trim();
      if ((!trimmed && files.length === 0) || !conversationId || isStreaming) return;

      const previews: MessageFile[] = files.map((f) => ({
        filename: f.name,
        originalName: f.name,
        mimetype: f.type,
        size: f.size,
        url: URL.createObjectURL(f),
      }));

      setPendingUserText(trimmed);
      setPendingFilesPreviews(previews);
      setStreamingText('');
      setStreamingThinking('');
      setStreamError(null);
      setIsStreaming(true);

      const token = localStorage.getItem('token');
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const form = new FormData();
        form.append('conversationId', conversationId);
        if (trimmed) form.append('text', trimmed);
        files.forEach((f) => form.append('files', f));

        const res = await fetch(`${API_BASE_URL}/message/chat`, {
          method: 'POST',
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: form,
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          console.error('Chat request failed:', res.status);
          let msg = `Chat request failed (${res.status}).`;
          try {
            const body = await res.json();
            if (body?.error) msg = String(body.error);
          } catch {
            /* ignore */
          }
          setStreamError(msg);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let lineBuf = '';
        let accText = '';
        let accThinking = '';

        const processLine = (line: string) => {
          if (!line.startsWith('data: ')) return;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') return;
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'response.output_text.delta' && event.delta) {
              accText += event.delta;
              setStreamingText(accText);
            } else if (event.type === 'response.thinking.delta' && event.delta) {
              accThinking += event.delta;
              setStreamingThinking(accThinking);
            } else if (event.type === 'response.error' && event.delta) {
              setStreamError(String(event.delta));
            }
          } catch {
            /* skip */
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            if (lineBuf.trim()) processLine(lineBuf);
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          lineBuf += chunk;
          const parts = lineBuf.split('\n');
          lineBuf = parts.pop()!;
          parts.forEach(processLine);
        }

        /* Pull the assistant turn into the messages cache BEFORE clearing
         * the streaming bubble.
         *
         * Why not `refetch()` anymore: `GET /message/conversation/:id` reads
         * the DB only, and assistant persistence was moved out of the chat
         * handler into the poll endpoint (dcc4f94) to dedupe gateway-v4
         * multi-pass JSONL writes. So when the SSE stream ends, the DB
         * still has the user row only — `refetch()` returns a list without
         * the assistant, the streaming bubble unmounts in `finally`, and
         * the user sees the message vanish for one full 5 s polling cycle
         * until the next `usePollMessagesQuery` tick re-syncs JSONL → DB.
         *
         * Calling `pollMessages` here does the JSONL → DB sync server-side
         * and returns the new rows in the same round-trip; we merge them
         * into the `getMessages` cache (same _id dedup as `useChat`'s
         * periodic merge) before `finally` clears the streaming UI, so the
         * persisted bubble takes over the exact frame the streaming one
         * leaves.
         *
         * One short retry covers the (rare) case where the gateway hasn't
         * flushed JSONL by the time `[DONE]` reaches us; the periodic 5 s
         * poll remains as the last-resort backstop. */
        const mergePollItems = (items: Message[]) => {
          if (items.length === 0) return 0;
          let added = 0;
          dispatch(
            messagesApi.util.updateQueryData(
              'getMessages',
              { conversationId, before: undefined },
              (draft) => {
                const existing = new Set(draft.items.map((m) => m._id));
                const additions = items.filter((m) => !existing.has(m._id));
                if (additions.length === 0) return;
                draft.items = [...draft.items, ...additions];
                draft.total = draft.items.length;
                added = additions.length;
              }
            )
          );
          return added;
        };

        /* `after = lastMessageTs` keeps the server response bounded to rows
         * the cache hasn't seen yet. `after: undefined` would return up to
         * 200 historical rows; merging them into the cache silently
         * surfaces ancient messages that were below the initial 50-row
         * fold (e.g. legacy NO_REPLY turns), which the user perceives as
         * "previous messages turned into NO_REPLY after sending". */
        const pollAfter = lastMessageTsRef.current;
        const fetchPoll = async () => {
          try {
            const result = await dispatch(
              messagesApi.endpoints.pollMessages.initiate(
                { conversationId, after: pollAfter },
                { forceRefetch: true }
              )
            ).unwrap();
            return result.items;
          } catch {
            return null;
          }
        };

        let assistantSynced = false;
        for (let attempt = 0; attempt < 2 && !assistantSynced; attempt += 1) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
          const items = await fetchPoll();
          if (!items) break;
          const added = mergePollItems(items);
          assistantSynced =
            added > 0 && items.some((m) => m.role === 'assistant');
        }

        if (!assistantSynced) {
          /* JSONL hadn't caught up — fall back to the legacy refetch so the
           * user message at least appears immediately. The next periodic
           * poll (≤ 5 s) will fill in the assistant row. */
          await refetch();
        }

        if (!hasMessages) {
          dispatch(baseApi.util.invalidateTags(['Conversation']));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Stream error:', err);
        setStreamError(err instanceof Error ? err.message : 'Network error while streaming.');
      } finally {
        setIsStreaming(false);
        setStreamingText('');
        setStreamingThinking('');
        setPendingUserText('');
        setPendingFilesPreviews((prev) => {
          prev.forEach((f) => URL.revokeObjectURL(f.url));
          return [];
        });
        abortRef.current = null;
      }
    },
    [conversationId, isStreaming, refetch, dispatch, hasMessages]
  );

  return {
    isStreaming,
    streamingText,
    streamingThinking,
    streamError,
    pendingUserText,
    pendingFilesPreviews,
    send,
    abort,
    clearError,
  };
}
