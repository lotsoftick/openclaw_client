export interface SseEmitter {
  send: (type: string, delta: string) => void;
  done: () => void;
  error: (msg: string) => void;
}

export interface ToolStepOutput {
  text: string;
  isError: boolean;
  status?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  truncated?: boolean;
}

export interface ToolStep {
  id: string;
  name: string;
  input: Record<string, unknown> | null;
  output: ToolStepOutput | null;
}

export interface OpenClawMessage {
  externalId: string;
  role: string;
  text: string;
  thinking: string | null;
  timestamp: string | null;
  toolSteps: ToolStep[] | null;
}

export interface OpenClawSession {
  sessionKey: string;
  sessionId: string;
  updatedAt: number;
  label: string | null;
  firstMessage: string | null;
}

// ── Session file shapes ──

export interface SessionEntry {
  sessionId: string;
  sessionFile?: string;
  updatedAt: number;
  label?: string | null;
  thinkingLevel?: string | null;
  fastMode?: boolean | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
  status?: string;
  abortedLastRun?: boolean;
  abortReason?: string;
  lastInteractionAt?: number;
  endedAt?: number;
}

export interface SessionRunStatus {
  aborted: boolean;
  status: string | null;
  reason: string | null;
  endedAt: number | null;
}

export type SessionsFile = Record<string, SessionEntry>;

// ── JSONL message file shapes ──

export interface JsonlTextPart {
  type: 'text';
  text: string;
}

export interface JsonlThinkingPart {
  type: 'thinking';
  thinking: string;
}

export interface JsonlToolCallPart {
  type: 'toolCall';
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface JsonlOtherPart {
  type: string;
  [key: string]: unknown;
}

export type JsonlContentPart =
  | JsonlTextPart
  | JsonlThinkingPart
  | JsonlToolCallPart
  | JsonlOtherPart;

export interface JsonlMessageEntry {
  type: 'message';
  id: string;
  timestamp?: string | null;
  message: {
    role: 'user' | 'assistant' | string;
    content: JsonlContentPart[] | string;
  };
}

export interface JsonlEntry {
  type: string;
  id?: string;
  timestamp?: string | null;
  message?: {
    role: 'user' | 'assistant' | string;
    content: JsonlContentPart[] | string;
  };
  [key: string]: unknown;
}

// ── Session settings ──

/* OpenClaw thinking-level vocabulary as of 2026.5.x.
 * `off | minimal | low | medium | high | xhigh | adaptive | max` plus our
 * `inherit` sentinel. Per-model the daemon may only advertise a subset
 * (e.g. Gemini 3.1 Pro Preview only accepts `off | low | adaptive | high`);
 * the picker UI reflects the active model's profile, but the type carries
 * the full vocabulary so older stored values keep round-tripping.
 * See openclaw/docs/tools/thinking.md. */
export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'adaptive'
  | 'max'
  | 'inherit';
export type VerboseLevel = 'low' | 'medium' | 'high' | 'inherit';
export type ReasoningLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'adaptive'
  | 'max'
  | 'inherit';

export interface SessionSettings {
  thinkingLevel: string;
  fastMode: boolean | null;
  verboseLevel: string;
  reasoningLevel: string;
}

export interface SessionSettingsPatchBody {
  thinkingLevel?: string;
  fastMode?: boolean | null;
  verboseLevel?: string;
  reasoningLevel?: string;
  label?: string | null;
}

// ── OpenClaw config (openclaw.json) ──

export interface OpenclawContextLimits {
  memoryGetMaxChars?: number;
  memoryGetDefaultLines?: number;
  toolResultMaxChars?: number;
  postCompactionMaxChars?: number;
}

export interface OpenclawSkillsLimits {
  maxSkillsPromptChars?: number;
}

export interface OpenclawSubagentsSection {
  allowAgents?: string[];
  thinking?: string;
  requireAgentId?: boolean;
}

export interface OpenclawAgentEntry {
  id?: string;
  name?: string;
  model?: string | { primary?: string } | null;
  contextLimits?: OpenclawContextLimits;
  skillsLimits?: OpenclawSkillsLimits;
  skills?: string[];
  subagents?: OpenclawSubagentsSection;
  [key: string]: unknown;
}

export interface OpenclawModelEntry {
  alias?: string;
  [key: string]: unknown;
}

export interface OpenclawAgentsSection {
  list?: OpenclawAgentEntry[];
  defaults?: {
    model?: { primary?: string } | null;
    models?: Record<string, OpenclawModelEntry>;
    contextLimits?: OpenclawContextLimits;
    skillsLimits?: OpenclawSkillsLimits;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ── Agent budgets (context/skills limits) ──

export type AgentBudgetKey =
  | 'memoryGetMaxChars'
  | 'memoryGetDefaultLines'
  | 'toolResultMaxChars'
  | 'postCompactionMaxChars'
  | 'maxSkillsPromptChars';

export interface AgentBudgetField {
  key: AgentBudgetKey;
  label: string;
  description: string;
  min: number;
  max: number;
  override: number | null;
  default: number | null;
  effective: number | null;
}

export interface AgentBudgetResponse {
  agentId: string;
  known: boolean;
  fields: AgentBudgetField[];
}

export type AgentBudgetPatch = Partial<Record<AgentBudgetKey, number | null>>;

export interface AgentProviderModel {
  key: string;
  name: string;
  contextWindow: number | null;
  local: boolean;
  available: boolean;
  missing: boolean;
  tags: string[];
}

export interface AgentProviderModelsResponse {
  agentId: string;
  known: boolean;
  currentModel: string | null;
  provider: string | null;
  models: AgentProviderModel[];
}

// ── Agent skills (per-agent allowlist) ──

export interface AgentSkillSummary {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  blockedByAllowlist: boolean;
  source: string;
  bundled: boolean;
}

export interface AgentSkillsResponse {
  agentId: string;
  known: boolean;
  override: string[] | null;
  available: AgentSkillSummary[];
}

export interface AgentSkillsPatch {
  skills: string[] | null;
}

// ── Agent subagents ──

export type AgentSubagentsThinking =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'adaptive'
  | 'max'
  | 'inherit'
  | string;

export interface AgentSubagentsConfig {
  allowAgents: string[] | null;
  thinking: string | null;
  requireAgentId: boolean | null;
}

export interface AgentSubagentsResponse {
  agentId: string;
  known: boolean;
  config: AgentSubagentsConfig;
  availableAgents: { id: string; name: string | null }[];
}

export interface AgentSubagentsPatch {
  allowAgents?: string[] | null;
  thinking?: string | null;
  requireAgentId?: boolean | null;
}

// ── Agent usage (token / cost / activity stats) ──

export interface AgentUsageDailyPoint {
  date: string;
  tokens: number;
  cost: number;
}

export interface AgentUsageModelRow {
  provider: string;
  model: string;
  count: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
}

export interface AgentUsageToolRow {
  name: string;
  count: number;
}

export interface AgentUsageSessionRow {
  key: string;
  label: string | null;
  channel: string | null;
  updatedAt: number | null;
  totalTokens: number;
  totalCost: number;
  modelProvider: string | null;
  model: string | null;
}

export interface AgentUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
}

export interface AgentUsageMessageCounts {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  errors: number;
}

export interface AgentUsageLatency {
  count: number;
  avgMs: number;
  p95Ms: number;
}

export interface AgentUsageResponse {
  agentId: string;
  known: boolean;
  range: { startDate: string | null; endDate: string | null };
  sessionCount: number;
  firstActivity: number | null;
  lastActivity: number | null;
  totals: AgentUsageTotals;
  messageCounts: AgentUsageMessageCounts;
  latency: AgentUsageLatency;
  daily: AgentUsageDailyPoint[];
  models: AgentUsageModelRow[];
  tools: AgentUsageToolRow[];
  sessions: AgentUsageSessionRow[];
}

// ── Agent cost limits (per-agent USD spend caps) ──

export type AgentLimitWindow = 'daily' | 'monthly' | 'total';

export interface AgentLimitWindowState {
  limit: number | null;
  spent: number;
  ratio: number | null;
  exceeded: boolean;
  nearLimit: boolean;
}

export interface AgentLimitsResponse {
  agentId: string;
  today: string;
  thisMonth: string;
  windows: Record<AgentLimitWindow, AgentLimitWindowState>;
}

export interface AgentLimitsPatch {
  costLimitDaily?: number | null;
  costLimitMonthly?: number | null;
  costLimitTotal?: number | null;
}

export interface OpenclawConfig {
  agents?: OpenclawAgentsSection;
  gateway?: {
    port?: number;
    auth?: {
      mode?: 'none' | 'token' | 'password' | 'trusted-proxy';
      token?: string;
      password?: string;
    };
  };
  [key: string]: unknown;
}

// ── Chat runner ──

export interface ChatRunHandle {
  kill: () => void;
}
