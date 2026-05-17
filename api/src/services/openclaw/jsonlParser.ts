import fs from 'fs';
import {
  JsonlContentPart,
  JsonlEntry,
  JsonlTextPart,
  JsonlThinkingPart,
  JsonlToolCallPart,
  OpenClawMessage,
  ToolStep,
  ToolStepOutput,
} from '../../@types/openclaw';

/** Hard limits to keep tool step JSON small enough to live alongside chat
 *  messages in SQLite without blowing up message payloads. Real tool I/O
 *  (e.g. file dumps, large model outputs) routinely runs past these caps;
 *  the UI shows a "(truncated)" hint when that happens. */
const MAX_TOOL_INPUT_VALUE_CHARS = 8_000;
const MAX_TOOL_OUTPUT_TEXT_CHARS = 16_000;
/** Provider-specific noise we never want to surface to the UI. */
const HIDDEN_TOOL_INPUT_KEYS = new Set(['thoughtSignature']);

function isTextPart(p: JsonlContentPart): p is JsonlTextPart {
  return p.type === 'text' && typeof (p as JsonlTextPart).text === 'string';
}

function isThinkingPart(p: JsonlContentPart): p is JsonlThinkingPart {
  return p.type === 'thinking' && typeof (p as JsonlThinkingPart).thinking === 'string';
}

function truncateString(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`, truncated: true };
}

function sanitizeToolInput(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const out: Record<string, unknown> = {};
  Object.entries(args as Record<string, unknown>).forEach(([k, v]) => {
    if (HIDDEN_TOOL_INPUT_KEYS.has(k)) return;
    if (typeof v === 'string') {
      out[k] = truncateString(v, MAX_TOOL_INPUT_VALUE_CHARS).value;
    } else {
      /* For nested objects we serialize once + truncate, avoiding deep
       * recursion through arbitrary tool schemas. */
      try {
        const json = JSON.stringify(v);
        if (json && json.length > MAX_TOOL_INPUT_VALUE_CHARS) {
          out[k] = `${json.slice(0, MAX_TOOL_INPUT_VALUE_CHARS)}…[truncated]`;
        } else {
          out[k] = v;
        }
      } catch {
        out[k] = '[unserialisable]';
      }
    }
  });
  return Object.keys(out).length === 0 ? null : out;
}

function isToolCallPart(p: JsonlContentPart): p is JsonlToolCallPart {
  return (
    Boolean(p) && typeof p === 'object' && (p as { type?: unknown }).type === 'toolCall'
  );
}

/**
 * Walk all JSONL entries once and index `toolResult` rows by their
 * `toolCallId`. The map gives us O(1) lookup when assembling assistant
 * messages so the parser stays O(N) overall.
 */
function indexToolResults(entries: JsonlEntry[]): Map<string, ToolStepOutput> {
  const out = new Map<string, ToolStepOutput>();
  entries.forEach((entry) => {
    if (entry.type !== 'message') return;
    const msg = entry.message as
      | {
          role?: string;
          toolCallId?: string;
          content?: JsonlContentPart[] | string;
          isError?: boolean;
          details?: Record<string, unknown>;
        }
      | undefined;
    if (!msg || msg.role !== 'toolResult' || !msg.toolCallId) return;

    /* The result's primary text lives either as a single string in
     * `content` or as a list of text parts. Joining is the safe default. */
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(isTextPart)
        .map((c) => c.text)
        .join('\n');
    }
    const { value: clipped, truncated } = truncateString(text, MAX_TOOL_OUTPUT_TEXT_CHARS);

    const details = (msg.details ?? {}) as {
      status?: unknown;
      exitCode?: unknown;
      durationMs?: unknown;
    };
    out.set(msg.toolCallId, {
      text: clipped,
      isError: msg.isError === true,
      status: typeof details.status === 'string' ? details.status : null,
      exitCode: typeof details.exitCode === 'number' ? details.exitCode : null,
      durationMs: typeof details.durationMs === 'number' ? details.durationMs : null,
      truncated,
    });
  });
  return out;
}

function extractToolSteps(
  content: JsonlContentPart[] | string,
  results: Map<string, ToolStepOutput>
): ToolStep[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isToolCallPart).map((part) => {
    const id = typeof part.id === 'string' ? part.id : '';
    const name = typeof part.name === 'string' ? part.name : 'tool';
    return {
      id,
      name,
      input: sanitizeToolInput(part.arguments),
      output: id ? results.get(id) ?? null : null,
    };
  });
}

export function extractUserText(raw: string): string {
  const trimmed = raw.trim();
  // Preserve scheduled-task headers so the frontend can render them specially
  if (/^\[cron:/i.test(trimmed)) return trimmed;

  const match = raw
    .split('\n')
    .reverse()
    .map((l) => l.trim().match(/^\[.+?\]\s+(.+)/))
    .find((m) => m !== null);
  return match ? match[1].trim() : trimmed;
}

/**
 * Detect and remove self-repeated text. Gateway v4 can write the same
 * assistant text 2-4x concatenated within a single JSONL entry.
 * Only deduplicates exact N-copy repeats to avoid false positives.
 */
function deduplicateSelfRepeat(text: string): string {
  if (!text || text.length < 40) return text;
  // Normalize: collapse runs of newlines to single newline for matching,
  // but return the original first segment (untouched) on match.
  const normalized = text.replace(/\n{2,}/g, '\n');
  for (let n = 2; n <= 6; n++) {
    // Try exact division on normalized text
    if (normalized.length % n === 0) {
      const segLen = normalized.length / n;
      const seg = normalized.slice(0, segLen);
      let isRepeat = true;
      for (let i = 1; i < n; i++) {
        if (normalized.slice(i * segLen, (i + 1) * segLen) !== seg) {
          isRepeat = false;
          break;
        }
      }
      if (isRepeat) {
        // Return the original (un-normalized) first segment
        // Find where the first copy ends in the original text
        const firstCopyEnd = text.indexOf(seg.slice(-20)) + 20;
        // Safer: just split by the segment and return first match
        return text.slice(0, text.length / n).trim();
      }
    }
    // Also try with flexible boundaries: check if the first ~1/n of the
    // text repeats by searching for it later in the string
    const approxLen = Math.floor(text.length / n);
    for (let fuzz = -2; fuzz <= 2; fuzz++) {
      const tryLen = approxLen + fuzz;
      if (tryLen < 20 || tryLen >= text.length) continue;
      const candidate = text.slice(0, tryLen).trim();
      if (!candidate) continue;
      // Check if the rest of the text is just repeats of candidate (with whitespace flex)
      let pos = tryLen;
      let copies = 1;
      while (pos < text.length) {
        // Skip whitespace between copies
        while (pos < text.length && /\s/.test(text[pos])) pos++;
        if (pos >= text.length) break;
        if (text.startsWith(candidate, pos)) {
          copies++;
          pos += candidate.length;
        } else {
          break;
        }
      }
      // Allow trailing whitespace
      const remaining = text.slice(pos).trim();
      if (copies === n && remaining.length === 0) {
        return candidate;
      }
    }
  }
  return text;
}

export function extractAssistantText(raw: string): string {
  const cleaned = raw
    .replace(/<\/?final>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, '')
    .trim();
  return deduplicateSelfRepeat(cleaned);
}

function readJsonlLines(jsonlPath: string): JsonlEntry[] {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return [];
  return fs
    .readFileSync(jsonlPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as JsonlEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is JsonlEntry => e !== null);
}

export function readFirstUserMessage(jsonlPath: string): string | null {
  try {
    const entries = readJsonlLines(jsonlPath);
    const userMsg = entries.find(
      (entry) => entry.type === 'message' && entry.message?.role === 'user'
    );
    if (!userMsg?.message) return null;
    const content = userMsg.message.content ?? [];
    const textPart = Array.isArray(content) ? content.find(isTextPart) : null;
    const rawText = textPart?.text || (typeof content === 'string' ? content : null);
    return rawText ? extractUserText(rawText).slice(0, 200) : null;
  } catch {
    return null;
  }
}

export function parseMessagesFromJsonl(jsonlPath: string): OpenClawMessage[] {
  try {
    const entries = readJsonlLines(jsonlPath);
    /* One pre-pass to index toolResult rows by toolCallId — assistant entries
     * reference these by id rather than positionally, so a Map is the only
     * reliable way to pair them. */
    const resultsByCallId = indexToolResults(entries);

    const raw = entries
      .filter((entry) => {
        if (entry.type !== 'message') return false;
        const role = entry.message?.role;
        return role === 'user' || role === 'assistant';
      })
      .map((entry): OpenClawMessage | null => {
        const message = entry.message!;
        const { role } = message;
        // `message.content` may arrive as a bare string (plain user prompts)
        // or a ContentPart[]. Without the string branch, those user entries
        // were filtered to empty by the `!text && !thinking && !toolSteps`
        // guard below, leaving consecutive assistant entries with no user
        // separator. The reduce at the bottom of this function then
        // coalesced every assistant turn into one cumulative bubble.
        // Mirrors the same handling in `readFirstUserMessage` above.
        const content = Array.isArray(message.content) ? message.content : [];
        const rawText =
          typeof message.content === 'string'
            ? message.content.trim()
            : content
                .filter(isTextPart)
                .map((c) => c.text)
                .join('\n')
                .trim();
        const text = role === 'user' ? extractUserText(rawText) : extractAssistantText(rawText);
        const inlineThinkMatch = rawText.match(
          /<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i
        );
        const inlineThink = inlineThinkMatch ? inlineThinkMatch[1].trim() : '';
        const structuredThink = content
          .filter(isThinkingPart)
          .map((c) => c.thinking)
          .join('\n')
          .trim();
        const thinking = [structuredThink, inlineThink].filter(Boolean).join('\n').trim() || null;
        const toolSteps = role === 'assistant' ? extractToolSteps(message.content, resultsByCallId) : [];
        /* Keep the entry if it has ANY meaningful signal: text, thinking, or
         * tool calls. Tool-only assistant turns used to be dropped here,
         * which made tool-using runs look like silent gaps in the chat. */
        if (!text && !thinking && toolSteps.length === 0) return null;
        return {
          externalId: entry.id || '',
          role,
          text,
          thinking,
          timestamp: entry.timestamp || null,
          toolSteps: toolSteps.length > 0 ? toolSteps : null,
        };
      })
      .filter((m): m is OpenClawMessage => m !== null);

    return raw.reduce<OpenClawMessage[]>((messages, msg) => {
      const prev = messages[messages.length - 1];
      if (msg.role === 'assistant' && prev?.role === 'assistant') {
        /* OpenClaw 2026.5.12 (#80725, gateway v4) writes each assistant
         * turn TWICE to the JSONL: one entry with the raw `<final>…</final>`
         * wrapper plus toolCall parts, then a second post-processed entry
         * with the wrapper stripped and no toolCalls. `extractAssistantText`
         * normalises both to the same string, so the old "always append"
         * rule doubled every v4 reply (`Test 4 received!…post!Test 4
         * received!…post!`). The four cases below cover the new shape
         * without regressing legitimate split turns (older daemons would
         * stream multiple disjoint text chunks). */
        if (msg.text && prev.text === msg.text) {
          // identical text — second pass of same turn, no-op on text
        } else if (msg.text && prev.text && prev.text.includes(msg.text)) {
          // prev already covers the new text — drop it
        } else if (msg.text && prev.text && msg.text.includes(prev.text)) {
          // new entry is a superset (e.g. post-processed full reply) — replace
          prev.text = msg.text;
        } else if (msg.text) {
          prev.text += msg.text;
        }
        if (msg.thinking) {
          if (!prev.thinking) prev.thinking = msg.thinking;
          else if (!prev.thinking.includes(msg.thinking)) prev.thinking += msg.thinking;
        }
        if (msg.toolSteps && msg.toolSteps.length > 0) {
          const seen = new Set((prev.toolSteps ?? []).map((s) => s.id).filter(Boolean));
          const fresh = msg.toolSteps.filter((s) => !s.id || !seen.has(s.id));
          if (fresh.length > 0) {
            prev.toolSteps = [...(prev.toolSteps ?? []), ...fresh];
          }
        }
        prev.externalId = msg.externalId;
        prev.timestamp = msg.timestamp || prev.timestamp;
      } else {
        messages.push({ ...msg });
      }
      return messages;
    }, []);
  } catch {
    return [];
  }
}

export function findLastAssistantThinking(jsonlPath: string): string | null {
  try {
    if (!fs.existsSync(jsonlPath)) return null;
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').reverse();
    const assistantLine = lines.find((l) => {
      try {
        const parsed = JSON.parse(l) as JsonlEntry;
        return parsed.type === 'message' && parsed.message?.role === 'assistant';
      } catch {
        return false;
      }
    });
    if (!assistantLine) return null;
    const parsed = JSON.parse(assistantLine) as JsonlEntry;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return null;
    const thinkingPart = content.find(isThinkingPart);
    return thinkingPart?.thinking || null;
  } catch {
    return null;
  }
}
