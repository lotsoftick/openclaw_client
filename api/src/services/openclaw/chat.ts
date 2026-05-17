/* eslint-disable no-console */
import crypto from 'crypto';
import os from 'os';
import { Response } from 'express';
import { ChatRunHandle, SseEmitter } from '../../@types/openclaw';
import { GwAgentEventPayload, GwEventMessage, GwInboundMessage } from '../../@types/gateway';
import { gateway, loadGatewayCredentials, ocSpawn } from '../openclawGateway';
import { createSseEmitter, GW_RE_PARTIAL_TAG, stripGatewayTags } from './sseEmitter';
import { extractThinkingFromJsonl, getSessionSettingsInternal } from './sessions';
import { errMsg } from '../../utils/errors';

function isAgentEvent(msg: GwInboundMessage): msg is GwEventMessage<GwAgentEventPayload> {
  return msg.type === 'event' && (msg.event === 'agent' || msg.event === 'chat');
}

function runAgentWithEmitter(
  agentId: string,
  message: string,
  sessionKey: string | null,
  emitter: SseEmitter
): void {
  const sessionSettings = getSessionSettingsInternal(agentId, sessionKey);
  const thinkingArg =
    sessionSettings.thinkingLevel === 'inherit' ? 'medium' : sessionSettings.thinkingLevel;
  const args = ['agent', '--agent', agentId, '-m', message, '--thinking', thinkingArg];
  if (sessionSettings.reasoningLevel && sessionSettings.reasoningLevel !== 'inherit') {
    args.push('--reasoning', sessionSettings.reasoningLevel);
  }
  if (sessionKey) args.push('--session-id', sessionKey);

  console.log(`[chat] CLI fallback: openclaw ${args.join(' ')}`);

  const child = ocSpawn(args, {
    cwd: os.homedir(),
    env: { ...process.env, NO_COLOR: '1' },
  });

  let hasOutput = false;
  let stderrBuf = '';
  let buf = '';
  let mode: 'idle' | 'think' | 'output' = 'idle';

  function emit(text: string, isThinking: boolean) {
    if (!text) return;
    const type = isThinking ? 'response.thinking.delta' : 'response.output_text.delta';
    emitter.send(type, text);
    hasOutput = true;
  }

  function processBuf() {
    while (buf.length > 0) {
      if (mode === 'idle') {
        const thinkIdx = buf.indexOf('<think>');
        const outputIdx = buf.indexOf('<output>');
        if (thinkIdx === -1 && outputIdx === -1) {
          const ltIdx = buf.lastIndexOf('<');
          if (ltIdx !== -1 && buf.length - ltIdx < '<output>'.length) {
            if (ltIdx > 0) emit(buf.slice(0, ltIdx), false);
            buf = buf.slice(ltIdx);
          } else {
            emit(buf, false);
            buf = '';
          }
          break;
        }
        const firstTag =
          thinkIdx !== -1 && (outputIdx === -1 || thinkIdx < outputIdx) ? thinkIdx : -1;
        const tagIdx = firstTag !== -1 ? thinkIdx : outputIdx;
        if (tagIdx > 0) emit(buf.slice(0, tagIdx), false);
        if (firstTag !== -1) {
          buf = buf.slice(thinkIdx + '<think>'.length);
          mode = 'think';
        } else {
          buf = buf.slice(outputIdx + '<output>'.length);
          mode = 'output';
        }
      } else if (mode === 'think') {
        const endIdx = buf.indexOf('</think>');
        if (endIdx !== -1) {
          emit(buf.slice(0, endIdx), true);
          buf = buf.slice(endIdx + '</think>'.length);
          mode = 'idle';
        } else {
          emit(buf, true);
          buf = '';
          break;
        }
      } else {
        const endIdx = buf.indexOf('</output>');
        if (endIdx !== -1) {
          emit(buf.slice(0, endIdx), false);
          buf = buf.slice(endIdx + '</output>'.length);
          mode = 'idle';
        } else {
          emit(buf, false);
          buf = '';
          break;
        }
      }
    }
  }

  child.stdout?.on('data', (data: Buffer) => {
    const cleaned = data.toString();
    if (!cleaned) return;
    buf += cleaned;
    processBuf();
  });

  child.stderr?.on('data', (data: Buffer) => {
    stderrBuf += data.toString();
  });

  child.on('close', () => {
    if (buf.trim()) emit(buf, mode === 'think');

    const isUnknownAgent = stderrBuf.includes('Unknown agent id');
    if (isUnknownAgent && agentId !== 'main') {
      console.warn(`[chat] agent "${agentId}" not found, falling back to "main"`);
      runAgentWithEmitter('main', message, sessionKey, emitter);
      return;
    }

    if (!hasOutput && stderrBuf.trim()) {
      const errorLines = stderrBuf
        .split('\n')
        .filter((l) => {
          const trimmed = l.trim();
          if (!trimmed) return false;
          return (
            trimmed.includes('Error') ||
            trimmed.includes('error') ||
            trimmed.includes('failed') ||
            trimmed.includes('No API key')
          );
        })
        .join(' | ');
      if (errorLines) {
        emitter.send('response.error', errorLines);
      }
    }
    emitter.done();
  });

  child.on('error', (err: Error) => {
    console.error('[openclaw] spawn error:', err);
    emitter.error(err.message);
  });
}

function runAgentViaGateway(
  agentId: string,
  message: string,
  sessionKey: string | null,
  emitter: SseEmitter
): ChatRunHandle {
  const runId = crypto.randomUUID();
  const listenerKey = `agent-${runId}`;
  let assistantSent = '';
  let reasoningSent = '';

  gateway.onEvent(listenerKey, (msg: GwInboundMessage) => {
    if (!isAgentEvent(msg)) return;
    const p = msg.payload;
    if (p.runId !== runId) return;

    if (msg.event !== 'agent' || !p.data?.delta) return;

    const { stream } = p;
    if (stream !== 'assistant' && stream !== 'reasoning') return;

    const fullText = p.data.text;
    if (fullText == null) return;

    const clean = stripGatewayTags(fullText);
    if (!clean || GW_RE_PARTIAL_TAG.test(clean)) return;

    const alreadySent = stream === 'assistant' ? assistantSent : reasoningSent;
    const sseType =
      stream === 'assistant' ? 'response.output_text.delta' : 'response.thinking.delta';

    /* OpenClaw 2026.5.12 (#80725) bumped the gateway to v4 and now emits the
     * assistant turn *twice* on the `agent` channel: once with the raw
     * `<final>…</final>` wrapping during streaming, then again post-processed
     * with the wrapper stripped. Our `stripGatewayTags` reduces both passes
     * to the same `clean` text, so the second pass arrives as `clean = "T",
     * "Te", "Tes", …` while `alreadySent` already holds the full first pass.
     * The old logic treated this as a "rewrite" and re-emitted the full
     * content, causing the assistant bubble to render the same reply twice
     * concatenated (UI shows `…Still 249 and 153!Test 4 received!…`).
     *
     * Three cases now:
     *   1. `clean` strictly extends `alreadySent` → emit the new tail.
     *   2. `clean` is a prefix of `alreadySent` (daemon restarted the same
     *      content) → drop; the client already shows at least this much.
     *   3. Otherwise (genuine rewrite of different content) → fall back to
     *      emitting the whole `clean`. The SSE consumer appends, which is
     *      imperfect for true rewrites but matches pre-v4 behaviour and
     *      doesn't trigger on the duplicate-turn pattern.
     */
    if (clean.length > alreadySent.length && clean.startsWith(alreadySent)) {
      const newContent = clean.substring(alreadySent.length);
      if (stream === 'assistant') assistantSent = clean;
      else reasoningSent = clean;
      emitter.send(sseType, newContent);
    } else if (alreadySent.startsWith(clean)) {
      /* Daemon-side restart of identical content (v4 post-process pass).
       * Skip — nothing new to surface to the client. */
    } else {
      if (stream === 'assistant') assistantSent = clean;
      else reasoningSent = clean;
      emitter.send(sseType, clean);
    }
  });

  const sessionSettings = getSessionSettingsInternal(agentId, sessionKey);
  const params: Record<string, unknown> = {
    message,
    agentId,
    idempotencyKey: runId,
    thinking: sessionSettings.thinkingLevel || 'medium',
  };
  if (sessionKey) {
    const fullKey = `agent:${agentId}:${sessionKey}`;
    params.sessionId = sessionKey;
    params.sessionKey = fullKey;
  }

  gateway
    .request('agent', params, { expectFinal: true, timeoutMs: 120000 })
    .then(() => {
      gateway.offEvent(listenerKey);
      if (sessionKey) {
        const thinking = extractThinkingFromJsonl(agentId, sessionKey);
        if (thinking) emitter.send('response.thinking.delta', thinking);
      }
      emitter.done();
    })
    .catch((err: Error) => {
      console.error('[gateway] agent error:', err.message);
      gateway.offEvent(listenerKey);
      const msg = err.message || '';
      if (agentId !== 'main' && /unknown agent|agent .* not found|no such agent/i.test(msg)) {
        console.warn(`[gateway] agent "${agentId}" unknown, retrying via CLI.`);
        runAgentWithEmitter(agentId, message, sessionKey, emitter);
        return;
      }

      emitter.error(msg);
    });

  return { kill: () => gateway.offEvent(listenerKey) };
}

// eslint-disable-next-line import/prefer-default-export
export async function runChat(
  agentId: string,
  message: string,
  sessionKey: string | null,
  filePaths: string[],
  res: Response
): Promise<void> {
  let fullMessage = message || '';
  if (filePaths.length) {
    const fileList = filePaths.map((p) => `- ${p}`).join('\n');
    const fileNote = `\n\nThe user attached file(s) saved to your workspace:\n${fileList}\nYou can read them directly.`;
    fullMessage = fullMessage ? fullMessage + fileNote : fileNote.trim();
  }

  if (!fullMessage.trim()) {
    res.status(400).json({ error: 'message or files required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.socket?.setNoDelay(true);
  res.flushHeaders();

  const emitter = createSseEmitter(res);

  try {
    const gwReady = await gateway.ensureConnected();
    const creds = gwReady ? loadGatewayCredentials() : null;
    /* Shared-token / shared-password auth on the daemon implies full
     * gateway authorization, so the device-scope check is moot in that
     * mode (and would always fail because device tokens carry no scopes
     * when shared auth is configured). Fall back to the device-auth
     * scope gate only on hosts that don't have a shared secret. */
    const canUseGateway = creds
      ? Boolean(creds.sharedAuth) ||
        (creds.auth.tokens?.operator?.scopes || []).includes('operator.write')
      : false;

    if (gwReady && canUseGateway) {
      console.log('[chat] using gateway direct connection');
      runAgentViaGateway(agentId, fullMessage, sessionKey, emitter);
    } else {
      if (gwReady && !canUseGateway) {
        console.log(
          '[chat] gateway connected but device-auth lacks operator.write — using CLI fallback. ' +
            'Fix: openclaw devices list → openclaw devices approve <id>'
        );
      } else {
        console.log('[chat] gateway unavailable, using CLI fallback');
      }
      runAgentWithEmitter(agentId, fullMessage, sessionKey, emitter);
    }
  } catch (err) {
    emitter.error(errMsg(err));
  }
}
