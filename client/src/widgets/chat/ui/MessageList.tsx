import { Box, Typography, CircularProgress } from '@mui/material';
import { MessageBubble } from '../../../entities/message';
import type { ChatState } from '../model/types';

/** Short, single-line copy shown inside the per-bubble error tooltip. */
function describeDeliveryError(status: string | null, reason: string | null): string {
  if (status === 'timeout') {
    return 'The model went idle past its timeout — no reply was committed. Try resending.';
  }
  if (status === 'error') {
    return reason ? `Run failed: ${reason}.` : 'The daemon ended the run with an error.';
  }
  if (status === 'cancelled') {
    return 'The run was cancelled before a reply was committed.';
  }
  return reason
    ? `The daemon aborted the run: ${reason}.`
    : 'The daemon aborted the run before a reply was committed.';
}

interface MessageListProps {
  chat: ChatState;
}

export default function MessageList({ chat }: MessageListProps) {
  const {
    messages,
    isLoading,
    isFetching,
    hasMore,
    isStreaming,
    streamingText,
    streamingThinking,
    streamError,
    pendingUserText,
    pendingFilesPreviews,
    runStatus,
    loadMore,
    loadMoreCursor,
    scrollContainerRef,
    messagesEndRef,
    handleScroll,
  } = chat;

  /* Two error sources can flag a stuck send:
   *   1. `streamError` — the SSE pipeline itself failed (network drop,
   *      gateway 5xx, model timeout surfaced as an error event). Most
   *      immediate; clears automatically when the next send starts.
   *   2. `runStatus.aborted` — the daemon's run ended abnormally on the
   *      previous turn (idle timeout, error, cancelled). Surfaces on the
   *      next poll between runs.
   * Both render as the same inline marker (warning icon + tooltip) on
   * whichever bubble is currently waiting for a reply. The marker clears
   * naturally once an assistant reply arrives after that bubble. */
  const errorTooltip = streamError
    ? streamError
    : runStatus
      ? describeDeliveryError(runStatus.status, runStatus.reason)
      : null;
  const lastInputIdx =
    errorTooltip && !isStreaming
      ? (() => {
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role !== 'assistant') return i;
          }
          return -1;
        })()
      : -1;

  return (
    <Box
      ref={scrollContainerRef}
      onScroll={handleScroll}
      sx={{
        flex: 1,
        minWidth: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        /* Disable browser scroll-anchoring. When the streaming MessageBubble
         * unmounts at end-of-turn and the persisted one mounts in its place
         * the layout height changes (Thought-Process collapses, markdown
         * re-renders, tool-step blocks appear). With anchoring on, the
         * browser shifts scrollTop to keep an upper element pinned, which
         * the user sees as the chat "jumping up". Anchoring off lets our
         * explicit scroll-to-bottom triggers stay authoritative. */
        overflowAnchor: 'none',
        px: { xs: 2, sm: 2, md: 3 },
        py: 2,
      }}
    >
      {isLoading && !loadMoreCursor ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : messages.length === 0 && !isStreaming ? (
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}
        >
          <Typography color="text.secondary">No messages yet. Send the first one!</Typography>
        </Box>
      ) : (
        <>
          {hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}>
              {isFetching && loadMoreCursor ? (
                <CircularProgress size={20} />
              ) : (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ cursor: 'pointer', '&:hover': { color: 'primary.main' } }}
                  onClick={loadMore}
                >
                  Load older messages
                </Typography>
              )}
            </Box>
          )}
          {messages.map((msg, idx) => (
            <MessageBubble
              key={msg._id}
              message={msg}
              messageId={msg._id}
              deliveryError={idx === lastInputIdx ? errorTooltip : null}
            />
          ))}
          {isStreaming && (pendingUserText || pendingFilesPreviews.length > 0) && (
            <MessageBubble
              message={{ text: pendingUserText, role: 'user', files: pendingFilesPreviews }}
            />
          )}
          {isStreaming && (streamingText || streamingThinking) && (
            <MessageBubble
              message={{ text: streamingText, role: 'assistant' }}
              isStreaming
              thinkingText={streamingThinking}
            />
          )}
          {isStreaming && !streamingText && !streamingThinking && (
            <Box sx={{ display: 'flex', gap: 0.8, py: 1.5, px: 1 }}>
              {[0, 1, 2].map((i) => (
                <Box
                  key={i}
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    bgcolor: 'text.secondary',
                    opacity: 0.4,
                    animation: 'dotPulse 1.4s ease-in-out infinite',
                    animationDelay: `${i * 0.2}s`,
                    '@keyframes dotPulse': {
                      '0%, 80%, 100%': { transform: 'scale(0.6)', opacity: 0.4 },
                      '40%': { transform: 'scale(1)', opacity: 1 },
                    },
                  }}
                />
              ))}
            </Box>
          )}
        </>
      )}
      <div ref={messagesEndRef} />
    </Box>
  );
}
