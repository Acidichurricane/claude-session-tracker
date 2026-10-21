export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type AgentStatusLite = 'running' | 'completed' | 'failed' | 'killed' | 'idle' | 'waiting' | 'pending'

export type TrackedAgent = {
  id: string
  type: string
  description: string
  model?: string
  status: AgentStatusLite
  startedAt: number
  endedAt?: number
  tools: number
  lastTool?: string
  tokens: Tokens
  queryId?: string
  // Per-run tracking (a run is one turn of the agent's loop; teammates take several).
  // Optional so records saved by older versions still load.
  runs?: number
  runStartedAt?: number
  runTools?: number
  activeMs?: number
  lastToolDetail?: string
  lastToolAt?: number
}

/** Past run lengths per agent type, for estimates: durations (ms) and tool counts, newest last. */
export type AgentStats = Record<string, { d: number[]; t: number[] }>

export type Query = {
  id: string
  prompt: string
  startedAt: number
  endedAt?: number
  costAtStart: number
  costUsd?: number
  tokens: Tokens
  status: 'running' | 'answer' | 'aborted' | 'refusal' | 'error'
  tools: number
}

export type FileChange = {
  path: string
  at: number
  kind: 'edit' | 'create' | 'write' | 'notebook'
  adds: number
  dels: number
  patch: string
  agentId?: string
  queryId?: string
}

export type Issue = {
  at: number
  kind: 'tool-error' | 'denied' | 'turn-error' | 'aborted' | 'reported'
  text: string
  tool?: string
  agentId?: string
}

export type Todo = { id: string; text: string; status: 'pending' | 'in_progress' | 'completed'; owner?: string }

export type PendingItem = {
  id: string
  kind: 'config' | 'action' | 'follow-up'
  text: string
  status: 'open' | 'done'
  createdAt: number
  doneAt?: number
  sessionId: string
}

export type ContextCategoryLite = { name: string; tokens: number; kind: string; color: string }

export type WindowUsage = {
  tokens?: number
  window: number
  percent?: number
  categories?: ContextCategoryLite[]
  autoCompactAt?: number
}

export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type SessionRecord = {
  id: string
  cwd: string
  title: string
  startedAt: number
  updatedAt: number
  costUsd: number
  contextPercent?: number
  contextWindow?: number
  window?: WindowUsage
  rateLimits?: RateWindow[]
  tokens: Tokens
  queries: Query[]
  agents: TrackedAgent[]
  files: FileChange[]
  issues: Issue[]
  todos: Todo[]
}

export type SessionSummary = {
  id: string
  cwd: string
  title: string
  startedAt: number
  updatedAt: number
  costUsd: number
  tokens: number
  files: number
  issues: number
  queries: number
}

export type Tab = 'overview' | 'agents' | 'files' | 'pending' | 'issues' | 'history'

declare module 'claude-code' {
  interface PluginState {
    'session-tracker': {
      live: SessionRecord | null
      pending: PendingItem[]
      history: SessionSummary[]
      tab: Tab
      selectedFile: string | null
      historyPick: string | null
      historyDetail: SessionRecord | null
      stats: AgentStats
      tick: number
    }
  }
}
