import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAppDispatch } from '../../../app/store/hooks';
import {
  messagesApi,
  useGetMessagesQuery,
  usePollMessagesQuery,
  type Message,
  type MessagesResponse,
  type SessionRunStatus,
} from '../../../entities/message';
import { useSendMessage } from '../../../features/message/send';
import type { ChatState } from './types';

const POLL_INTERVAL_MS = 5000;

/**
 * Composes message querying, polling, scroll behavior, and send-message state
 * into a single `ChatState` consumed by the chat widget.
 */
export function useChat(conversationId: string | undefined): ChatState {
  const [loadMoreCursor, setLoadMoreCursor] = useState<string | undefined>();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isLoadingMore = useRef(false);
  const prevScrollHeight = useRef(0);
  const initialScrollDone = useRef(false);
  const lastConvId = useRef(conversationId);
  const scrollTickRef = useRef(0);
  const lastMergedPollTs = useRef<string | undefined>(undefined);

  const dispatch = useAppDispatch();

  const { data, isLoading, isFetching, refetch } = useGetMessagesQuery(
    { conversationId: conversationId!, before: loadMoreCursor },
    { skip: !conversationId }
  );

  const messages = useMemo<Message[]>(() => data?.items ?? [], [data?.items]);
  const hasMore = (data as MessagesResponse | undefined)?.hasMore ?? false;

  // Polling: only fetch messages newer than the latest one we have.
  // Skip while streaming so SSE flow owns the update.
  const lastMessageTs = messages.length > 0 ? messages[messages.length - 1].createdAt : undefined;

  const {
    isStreaming,
    streamingText,
    streamingThinking,
    streamError,
    pendingUserText,
    pendingFilesPreviews,
    send,
    abort,
    clearError,
  } = useSendMessage({
    conversationId,
    refetch,
    hasMessages: messages.length > 0,
    lastMessageTs,
  });

  const { data: pollData } = usePollMessagesQuery(
    { conversationId: conversationId!, after: lastMessageTs },
    {
      skip: !conversationId || isStreaming || isLoading,
      pollingInterval: POLL_INTERVAL_MS,
      refetchOnMountOrArgChange: true,
    }
  );

  // Merge new polled items into the messages cache + trigger auto-scroll.
  useEffect(() => {
    if (!conversationId || !pollData || pollData.items.length === 0) return;

    // Dedup by newest polled timestamp: avoids re-merging the same data.
    const newestTs = pollData.items[pollData.items.length - 1].createdAt;
    if (lastMergedPollTs.current === newestTs) return;
    lastMergedPollTs.current = newestTs;

    dispatch(
      messagesApi.util.updateQueryData(
        'getMessages',
        { conversationId, before: undefined },
        (draft) => {
          const existing = new Set(draft.items.map((m) => m._id));
          const additions = pollData.items.filter((m) => !existing.has(m._id));
          if (additions.length === 0) return;
          draft.items = [...draft.items, ...additions];
          draft.total = draft.items.length;
        }
      )
    );

    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 200) {
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  }, [pollData, conversationId, dispatch]);

  useEffect(() => {
    if (lastConvId.current !== conversationId) {
      lastConvId.current = conversationId;
      initialScrollDone.current = false;
      lastMergedPollTs.current = undefined;
    }
    if (isLoadingMore.current) {
      const container = scrollContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight - prevScrollHeight.current;
        prevScrollHeight.current = 0;
      }
      isLoadingMore.current = false;
      return;
    }
    if (!initialScrollDone.current && messages.length > 0) {
      initialScrollDone.current = true;
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
      }, 80);
      return;
    }
    if (pendingUserText || pendingFilesPreviews.length > 0) {
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 150);
    }
  }, [messages, conversationId, pendingUserText, pendingFilesPreviews]);

  useEffect(() => {
    if (!streamingText && !streamingThinking) return;
    const now = Date.now();
    if (now - scrollTickRef.current < 200) return;
    scrollTickRef.current = now;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streamingText, streamingThinking]);

  /* Snap to the bottom when streaming transitions true → false.
   *
   * Background: with the post-stream `pollMessages` merge in
   * `useSendMessage`, the `dispatch(updateQueryData(...))` that appends the
   * assistant row is synchronous and gets auto-batched by React 18 with the
   * `set*('')` clears in `useSendMessage`'s `finally`. The messages effect
   * above therefore runs exactly once, with `pendingUserText` already
   * cleared, and its scroll-to-bottom branch never fires. Worse, the
   * persisted bubble's height usually differs from the streaming bubble's
   * (Thought-Process collapses, markdown re-renders, tool blocks appear),
   * so the viewport visibly shifts.
   *
   * Two layout phases to handle:
   *   1. SYNCHRONOUS swap. The streaming bubble unmounts and the persisted
   *      bubble mounts in the same React commit. `useLayoutEffect` lets us
   *      adjust scrollTop in that same commit, BEFORE the browser paints —
   *      so the user never sees the intermediate "shorter content at the
   *      bottom" frame. `behavior: 'auto'` is mandatory here (smooth would
   *      reintroduce the visible animation we are trying to hide).
   *   2. ASYNC reflows after first mount. On the FIRST send after a hard
   *      refresh, the persisted bubble's deps (markdown renderer, syntax
   *      highlighter, image decoders) resolve a frame or two later and
   *      grow the bubble. Subsequent sends in the same session never hit
   *      this because those deps are cached — which is exactly the
   *      "happens once after refresh, then stops" symptom. Re-scrolling at
   *      0 / 120 / 400 ms catches all three reflow generations we have
   *      observed; the cleanup tears them down if the user navigates away
   *      mid-window. */
  const prevIsStreaming = useRef(isStreaming);
  useLayoutEffect(() => {
    const wasStreaming = prevIsStreaming.current;
    prevIsStreaming.current = isStreaming;
    if (!wasStreaming || isStreaming) return undefined;
    const snap = () => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    };
    snap();
    const t1 = window.setTimeout(snap, 120);
    const t2 = window.setTimeout(snap, 400);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [isStreaming]);

  const [prevConvId, setPrevConvId] = useState(conversationId);
  if (prevConvId !== conversationId) {
    setPrevConvId(conversationId);
    abort();
    clearError();
    if (loadMoreCursor !== undefined) setLoadMoreCursor(undefined);
  }

  /* Run state is derived directly from the latest poll. Polling is paused
   * while streaming, so by definition this only updates between runs.
   * The MessageList consumes it to flag the last "stuck" message inline
   * (exclamation icon + tooltip) — no banner state, no dismissal needed,
   * because the indicator clears naturally when a new assistant reply
   * arrives after the affected message. */
  const runStatus: SessionRunStatus | null =
    pollData?.runStatus?.aborted ? pollData.runStatus : null;

  useEffect(() => {
    return () => {
      abort();
    };
  }, [abort]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || isLoadingMore.current || isFetching || !hasMore || isStreaming) return;
    if (container.scrollTop < 150 && messages.length > 0) {
      isLoadingMore.current = true;
      prevScrollHeight.current = container.scrollHeight;
      setLoadMoreCursor(messages[0].createdAt);
    }
  }, [isFetching, hasMore, isStreaming, messages]);

  const loadMore = useCallback(() => {
    if (messages.length > 0) {
      isLoadingMore.current = true;
      prevScrollHeight.current = scrollContainerRef.current?.scrollHeight ?? 0;
      setLoadMoreCursor(messages[0].createdAt);
    }
  }, [messages]);

  return {
    messages,
    isLoading,
    isFetching,
    hasMore,
    loadMoreCursor,
    isStreaming,
    streamingText,
    streamingThinking,
    streamError,
    pendingUserText,
    pendingFilesPreviews,
    runStatus,
    send,
    loadMore,
    handleScroll,
    clearError,
    scrollContainerRef,
    messagesEndRef,
  };
}
