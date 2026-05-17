import { Response } from 'express';
import { SseEmitter } from '../../@types/openclaw';

const GW_TAG = 'final|output|think|thinking|redacted_thinking';
const GW_RE_OPEN = new RegExp(`^<(?:${GW_TAG})\\b[^>]*>`, 'i');
const GW_RE_CLOSE = new RegExp(`</(?:${GW_TAG})\\s*>\\s*$`, 'i');
const GW_RE_PARTIAL_CLOSE = /<\/[a-z]*\s*$/i;
export const GW_RE_PARTIAL_TAG = new RegExp(`^<\\/?\\s*(?:${GW_TAG})\\s*$`, 'i');

export function stripGatewayTags(text: string): string {
  if (!text) return text;
  return text.replace(GW_RE_OPEN, '').replace(GW_RE_CLOSE, '').replace(GW_RE_PARTIAL_CLOSE, '');
}

export function createSseEmitter(res: Response): SseEmitter {
  // Send SSE comment keepalives every 5s to prevent the browser
  // from treating the connection as stale during tool-call silences.
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* connection closed */ }
  }, 5000);
  return {
    send(type, delta) {
      res.write(`data: ${JSON.stringify({ type, delta })}\n\n`);
    },
    done() {
      clearInterval(keepalive);
      res.write('data: [DONE]\n\n');
      res.end();
    },
    error(msg) {
      clearInterval(keepalive);
      const text = msg || 'Agent run failed.';
      if (!res.headersSent) {
        res.status(500).json({ error: text });
        return;
      }
      try {
        res.write(`data: ${JSON.stringify({ type: 'response.error', delta: text })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch {
        /* best effort */
      }
      res.end();
    },
  };
}
