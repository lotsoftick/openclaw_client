/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  OpenClawMessage,
  OpenClawSession,
  SessionEntry,
  SessionRunStatus,
  SessionSettings,
  SessionSettingsPatchBody,
  SessionsFile,
} from '../../@types/openclaw';
import { gateway } from '../openclawGateway';
import { errMsg } from '../../utils/errors';
import { sessionsFilePath, agentDir } from './paths';
import {
  findLastAssistantThinking,
  parseMessagesFromJsonl,
  readFirstUserMessage,
} from './jsonlParser';

function readSessions(agentId: string): SessionsFile | null {
  const file = sessionsFilePath(agentId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionsFile;
  } catch {
    return null;
  }
}

function writeSessions(agentId: string, data: SessionsFile): void {
  const file = sessionsFilePath(agentId);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function findSessionEntry(
  sessions: SessionsFile,
  agentId: string,
  sessionKey: string
): SessionEntry | null {
  return (
    sessions[`agent:${agentId}:${sessionKey}`] ||
    Object.values(sessions).find((v) => v.sessionId === sessionKey) ||
    null
  );
}

function defaultSettings(): SessionSettings {
  return {
    /* `inherit` lets the daemon pick the model's profile-managed default
     * instead of forcing `medium` (which several newer models — Gemini
     * 3.1 Pro, Z.AI, MiniMax — reject as unsupported). */
    thinkingLevel: 'inherit',
    fastMode: null,
    verboseLevel: 'inherit',
    reasoningLevel: 'inherit',
  };
}

export function getSessionSettingsInternal(
  agentId: string,
  sessionKey: string | null
): SessionSettings {
  const defaults = defaultSettings();
  if (!sessionKey) return defaults;
  try {
    const sessions = readSessions(agentId);
    if (!sessions) return defaults;
    const entry = sessions[`agent:${agentId}:${sessionKey}`];
    if (!entry) return defaults;
    return {
      thinkingLevel: entry.thinkingLevel || defaults.thinkingLevel,
      fastMode: entry.fastMode ?? defaults.fastMode,
      verboseLevel: entry.verboseLevel || defaults.verboseLevel,
      reasoningLevel: entry.reasoningLevel || defaults.reasoningLevel,
    };
  } catch {
    return defaults;
  }
}

/**
 * Inspect `sessions.json` for the run state of one session.
 *
 * The OpenClaw daemon writes `status`, `abortedLastRun`, `abortReason`, and
 * `endedAt` after each run. When `status === 'timeout'` (model idle timeout)
 * or `abortedLastRun === true` (any other abnormal end) the assistant's
 * partial reply was streamed to whatever client was connected but never
 * committed to the JSONL — so we surface this so the chat UI can explain
 * the gap to the user instead of silently showing a missing message.
 */
export function getSessionRunStatus(
  agentId: string,
  sessionKey: string
): SessionRunStatus {
  const empty: SessionRunStatus = { aborted: false, status: null, reason: null, endedAt: null };
  try {
    const sessions = readSessions(agentId);
    if (!sessions) return empty;
    const entry = findSessionEntry(sessions, agentId, sessionKey);
    if (!entry) return empty;
    const status = typeof entry.status === 'string' ? entry.status : null;
    const aborted = entry.abortedLastRun === true || status === 'timeout' || status === 'error';
    const reason =
      (typeof entry.abortReason === 'string' && entry.abortReason) ||
      (status && status !== 'ok' ? status : null) ||
      null;
    const endedAt = typeof entry.endedAt === 'number' ? entry.endedAt : null;
    return { aborted, status, reason, endedAt };
  } catch {
    return empty;
  }
}

export function extractThinkingFromJsonl(agentId: string, sessionKey: string): string | null {
  try {
    const sessions = readSessions(agentId);
    if (!sessions) return null;
    const entry = sessions[`agent:${agentId}:${sessionKey}`];
    if (!entry?.sessionFile) return null;
    return findLastAssistantThinking(entry.sessionFile);
  } catch {
    return null;
  }
}

export function listSessions(agentId: string, skipFirstMessage = false): OpenClawSession[] {
  const sessions = readSessions(agentId);
  if (!sessions) return [];
  try {
    const prefix = `agent:${agentId}:`;
    return Object.entries(sessions)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, val]) => {
        const customKey = key.slice(prefix.length);
        const firstMessage =
          skipFirstMessage || !val.sessionFile ? null : readFirstUserMessage(val.sessionFile);
        return {
          sessionKey: customKey,
          sessionId: val.sessionId,
          updatedAt: val.updatedAt,
          label: val.label || null,
          firstMessage,
        };
      });
  } catch {
    return [];
  }
}

export function getSessionMessages(agentId: string, sessionKey: string): OpenClawMessage[] {
  const sessions = readSessions(agentId);
  if (!sessions) return [];
  const entry = findSessionEntry(sessions, agentId, sessionKey);
  if (!entry) return [];
  const jsonlPath =
    entry.sessionFile || path.join(agentDir(agentId), 'sessions', `${entry.sessionId}.jsonl`);
  return parseMessagesFromJsonl(jsonlPath);
}

export function deleteSessionMessage(
  agentId: string,
  sessionKey: string,
  externalId: string
): boolean {
  try {
    const sessions = readSessions(agentId);
    if (!sessions) return true;
    const entry = findSessionEntry(sessions, agentId, sessionKey);
    if (!entry?.sessionFile || !fs.existsSync(entry.sessionFile)) return true;

    const lines = fs.readFileSync(entry.sessionFile, 'utf-8').trimEnd().split('\n');
    const filtered = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line) as { id?: string };
        return parsed.id !== externalId;
      } catch {
        return true;
      }
    });

    if (filtered.length < lines.length) {
      fs.writeFileSync(entry.sessionFile, `${filtered.join('\n')}\n`);
    }
    return true;
  } catch {
    return false;
  }
}

export function getSessionSettings(agentId: string, sessionKey: string): Partial<SessionSettings> {
  const sessions = readSessions(agentId);
  if (!sessions) return {};
  try {
    const entry = sessions[`agent:${agentId}:${sessionKey}`];
    if (!entry) return {};
    return {
      thinkingLevel: entry.thinkingLevel || 'inherit',
      fastMode: entry.fastMode ?? null,
      verboseLevel: entry.verboseLevel || 'inherit',
      reasoningLevel: entry.reasoningLevel || 'inherit',
    };
  } catch {
    return {};
  }
}

export async function patchSessionSettings(
  agentId: string,
  sessionKey: string,
  body: SessionSettingsPatchBody
): Promise<{ ok: boolean; error?: string }> {
  const fullKey = `agent:${agentId}:${sessionKey}`;
  const patch: Record<string, unknown> = { key: fullKey };

  if (body.thinkingLevel !== undefined)
    patch.thinkingLevel = body.thinkingLevel === 'inherit' ? null : body.thinkingLevel;
  if (body.fastMode !== undefined) patch.fastMode = body.fastMode === null ? null : !!body.fastMode;
  if (body.verboseLevel !== undefined)
    patch.verboseLevel = body.verboseLevel === 'inherit' ? null : body.verboseLevel;
  if (body.reasoningLevel !== undefined)
    patch.reasoningLevel = body.reasoningLevel === 'inherit' ? null : body.reasoningLevel;
  if (body.label !== undefined) patch.label = body.label || null;

  // Always persist to sessions.json so subsequent GETs read fresh values.
  // The gateway (if available) is notified best-effort so the daemon's
  // in-memory state stays consistent for the next run.
  try {
    const sessions = readSessions(agentId) ?? ({} as SessionsFile);
    const entry: SessionEntry = sessions[fullKey] || {
      sessionId: crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    if (patch.thinkingLevel !== undefined)
      entry.thinkingLevel = patch.thinkingLevel as string | null;
    if (patch.fastMode !== undefined) entry.fastMode = patch.fastMode as boolean | null;
    if (patch.verboseLevel !== undefined) entry.verboseLevel = patch.verboseLevel as string | null;
    if (patch.reasoningLevel !== undefined)
      entry.reasoningLevel = patch.reasoningLevel as string | null;
    if (patch.label !== undefined) entry.label = patch.label as string | null;
    entry.updatedAt = Date.now();
    sessions[fullKey] = entry;
    writeSessions(agentId, sessions);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }

  const gwReady = await gateway.ensureConnected();
  if (gwReady) {
    try {
      await gateway.request('sessions.patch', patch, { timeoutMs: 5000 });
    } catch (err) {
      console.error('[sessions.patch] gateway error (disk write succeeded):', errMsg(err));
    }
  }

  return { ok: true };
}

export async function deleteSession(agentId: string, sessionKey: string): Promise<{ ok: boolean }> {
  const fullKey = `agent:${agentId}:${sessionKey}`;

  const gwReady = await gateway.ensureConnected();
  if (gwReady) {
    try {
      await gateway.request('sessions.delete', { key: fullKey }, { timeoutMs: 5000 });
      return { ok: true };
    } catch (err) {
      console.error('[sessions.delete] gateway error:', errMsg(err));
    }
  }

  try {
    const sessions = readSessions(agentId);
    if (sessions) {
      const entry = sessions[fullKey];
      if (entry?.sessionFile && fs.existsSync(entry.sessionFile)) {
        fs.unlinkSync(entry.sessionFile);
      }
      delete sessions[fullKey];
      writeSessions(agentId, sessions);
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}
