/* eslint-disable no-console */
import fs from 'fs';
import os from 'os';
import {
  AgentSubagentsConfig,
  AgentSubagentsPatch,
  AgentSubagentsResponse,
  OpenclawAgentEntry,
  OpenclawConfig,
} from '../../@types/openclaw';
import { ocExec } from '../openclawGateway';
import { openclawConfigPath } from './paths';
import { execErrText } from '../../utils/errors';

const CLI_OPTS = {
  cwd: os.homedir(),
  env: { ...process.env, NO_COLOR: '1' },
  timeout: 15000,
};

/* Full OpenClaw thinking-level vocabulary (openclaw/docs/tools/thinking.md).
 * Per-model the daemon may only advertise a subset; we accept any of these
 * here and let the daemon enforce model-specific support at runtime. */
const ALLOWED_THINKING = new Set<string>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'adaptive',
  'max',
  'inherit',
]);

function readConfig(): OpenclawConfig | null {
  try {
    return JSON.parse(fs.readFileSync(openclawConfigPath(), 'utf-8')) as OpenclawConfig;
  } catch {
    return null;
  }
}

function findAgentIndex(config: OpenclawConfig | null, openclawAgentId: string): number {
  const list = config?.agents?.list ?? [];
  return list.findIndex((a) => a?.id === openclawAgentId);
}

function normalizeConfig(entry: OpenclawAgentEntry | undefined): AgentSubagentsConfig {
  const s = entry?.subagents;
  return {
    allowAgents: Array.isArray(s?.allowAgents) ? s!.allowAgents.map(String) : null,
    thinking: typeof s?.thinking === 'string' ? s!.thinking : null,
    requireAgentId: typeof s?.requireAgentId === 'boolean' ? s!.requireAgentId : null,
  };
}

function availableAgents(config: OpenclawConfig | null, selfId: string) {
  const list = config?.agents?.list ?? [];
  return list
    .filter((a) => a?.id && a.id !== selfId)
    .map((a) => ({
      id: String(a.id),
      name: typeof a.name === 'string' && a.name ? a.name : null,
    }));
}

export function getAgentSubagentsConfig(openclawAgentId: string): AgentSubagentsResponse {
  const config = readConfig();
  const agentIndex = findAgentIndex(config, openclawAgentId);
  const entry = agentIndex >= 0 ? config?.agents?.list?.[agentIndex] : undefined;

  return {
    agentId: openclawAgentId,
    known: agentIndex >= 0,
    config: normalizeConfig(entry),
    availableAgents: availableAgents(config, openclawAgentId),
  };
}

export interface SetAgentSubagentsResult {
  ok: boolean;
  error?: string;
  config?: AgentSubagentsResponse;
}

type PatchHandler = (
  basePath: string,
  value: unknown
) => { op: 'set'; value: string } | { op: 'unset' } | { op: 'error'; error: string };

const HANDLERS: Record<keyof AgentSubagentsPatch, PatchHandler> = {
  allowAgents: (_b, v) => {
    if (v === null) return { op: 'unset' };
    if (!Array.isArray(v)) return { op: 'error', error: '"allowAgents" must be an array.' };
    const normalized = Array.from(new Set(v.map((x) => String(x).trim()).filter(Boolean)));
    return { op: 'set', value: JSON.stringify(normalized) };
  },
  thinking: (_b, v) => {
    if (v === null || v === '' || v === 'inherit') return { op: 'unset' };
    if (typeof v !== 'string' || !ALLOWED_THINKING.has(v)) {
      return {
        op: 'error',
        error: `"thinking" must be one of ${Array.from(ALLOWED_THINKING).join(', ')}.`,
      };
    }
    return { op: 'set', value: JSON.stringify(v) };
  },
  requireAgentId: (_b, v) => {
    if (v === null) return { op: 'unset' };
    if (typeof v !== 'boolean')
      return { op: 'error', error: '"requireAgentId" must be a boolean or null.' };
    return { op: 'set', value: v ? 'true' : 'false' };
  },
};

export function setAgentSubagents(
  openclawAgentId: string,
  patch: AgentSubagentsPatch
): SetAgentSubagentsResult {
  const config = readConfig();
  const agentIndex = findAgentIndex(config, openclawAgentId);
  if (agentIndex < 0) {
    return { ok: false, error: `Agent "${openclawAgentId}" not found in openclaw config.` };
  }

  const keys: (keyof AgentSubagentsPatch)[] = ['allowAgents', 'thinking', 'requireAgentId'];

  const pending = keys.filter((k) => k in patch);

  const failure = pending.reduce<{ ok: false; error: string } | null>((acc, key) => {
    if (acc) return acc;
    const handler = HANDLERS[key];
    const outcome = handler('', patch[key] as unknown);

    if (outcome.op === 'error') {
      return { ok: false, error: outcome.error };
    }

    const path = `agents.list[${agentIndex}].subagents.${key}`;
    try {
      if (outcome.op === 'unset') {
        try {
          ocExec(['config', 'unset', path], CLI_OPTS);
        } catch (err) {
          const stderr = execErrText(err);
          if (!/not found|does not exist/i.test(stderr)) throw err;
        }
      } else {
        ocExec(['config', 'set', path, outcome.value, '--strict-json'], CLI_OPTS);
      }
    } catch (err) {
      const stderr = execErrText(err);
      console.error(`[agent-subagents] failed to set ${path}:`, stderr);
      return { ok: false, error: stderr || `Failed to update subagents.${key}.` };
    }
    return null;
  }, null);

  if (failure) return failure;

  return { ok: true, config: getAgentSubagentsConfig(openclawAgentId) };
}
