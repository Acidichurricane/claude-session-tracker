// Pure helpers: no `$`, so the tests exercise them directly.
import type { AgentStats, FileChange, PendingItem, SessionRecord, SessionSummary, Todo, Tokens, TrackedAgent } from '../types'

export const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const MAX_PATCH = 4000 // chars kept per change
export const MAX_SESSION_PATCH = 120_000 // chars of patches kept per stored session
export const MAX_HISTORY = 20

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function addUsage(t: Tokens, u?: Usage | null): Tokens {
  if (!u) return t
  return {
    input: t.input + (u.input_tokens || 0),
    output: t.output + (u.output_tokens || 0),
    cacheRead: t.cacheRead + (u.cache_read_input_tokens || 0),
    cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens || 0),
  }
}

export const totalTokens = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite

export function emptySession(id: string, cwd: string, now: number): SessionRecord {
  return { id, cwd, title: '', startedAt: now, updatedAt: now, costUsd: 0, tokens: { ...ZERO },
    queries: [], agents: [], files: [], issues: [], todos: [] }
}

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

// structuredPatch → unified-diff text the Code element draws, plus +/- counts.
export function patchText(hunks: readonly Hunk[] | undefined, created?: string): { patch: string; adds: number; dels: number } {
  let lines: string[] = []
  let adds = 0
  let dels = 0
  if (hunks && hunks.length) {
    for (const h of hunks) {
      lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
      for (const l of h.lines) {
        lines.push(l)
        if (l.startsWith('+')) adds++
        else if (l.startsWith('-')) dels++
      }
    }
  } else if (created !== undefined) {
    const body = created.split('\n')
    if (body.at(-1) === '') body.pop()
    adds = body.length
    lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)]
  }
  return { patch: clipPatch(lines.join('\n')), adds, dels }
}

// Over the budget, keep only whole hunks: a hunk cut mid-way no longer matches its
// @@ counts and the diff view would fall back to plain text.
export function clipPatch(patch: string, max = MAX_PATCH): string {
  if (patch.length <= max) return patch
  const cut = patch.slice(0, max)
  const lastHunk = cut.lastIndexOf('\n@@ ')
  return lastHunk > 0 ? cut.slice(0, lastHunk) : ''
}

export function dirOf(path: string, cwd: string): string {
  const rel = relPath(path, cwd)
  const i = rel.lastIndexOf('/')
  return i < 0 ? '.' : rel.slice(0, i)
}

export function relPath(path: string, cwd: string): string {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  if (path.startsWith(base)) return path.slice(base.length)
  const home = path.match(/^\/home\/[^/]+\//)
  return home ? `~/${path.slice(home[0].length)}` : path
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export type FileGroup = { dir: string; files: { path: string; adds: number; dels: number; edits: number; last: number }[] }

// Aggregate changes per file, grouped by directory, most recently touched first.
export function groupFiles(changes: readonly FileChange[], cwd: string): FileGroup[] {
  const byPath = new Map<string, { path: string; adds: number; dels: number; edits: number; last: number }>()
  for (const c of changes) {
    const f = byPath.get(c.path) ?? { path: c.path, adds: 0, dels: 0, edits: 0, last: 0 }
    f.adds += c.adds
    f.dels += c.dels
    f.edits++
    f.last = Math.max(f.last, c.at)
    byPath.set(c.path, f)
  }
  const groups = new Map<string, FileGroup>()
  for (const f of byPath.values()) {
    const dir = dirOf(f.path, cwd)
    const g = groups.get(dir) ?? { dir, files: [] }
    g.files.push(f)
    groups.set(dir, g)
  }
  const list = [...groups.values()]
  for (const g of list) g.files.sort((a, b) => b.last - a.last)
  return list.sort((a, b) => (b.files[0]?.last ?? 0) - (a.files[0]?.last ?? 0))
}

export function summarize(s: SessionRecord): SessionSummary {
  return { id: s.id, cwd: s.cwd, title: s.title, startedAt: s.startedAt, updatedAt: s.updatedAt,
    costUsd: s.costUsd, tokens: totalTokens(s.tokens), files: new Set(s.files.map((f) => f.path)).size,
    issues: s.issues.length, queries: s.queries.length }
}

// What goes to $.store: newest patches kept up to a budget, older ones dropped
// (path and counts stay), so 20 sessions fit the store's 4 MiB.
export function forStorage(s: SessionRecord): SessionRecord {
  let budget = MAX_SESSION_PATCH
  const files = [...s.files].reverse().map((f) => {
    if (budget <= 0) return { ...f, patch: '' }
    budget -= f.patch.length
    return f
  }).reverse()
  return { ...s, files: files.slice(-300), issues: s.issues.slice(-200), queries: s.queries.slice(-200) }
}

export function upsertHistory(list: readonly SessionSummary[], sum: SessionSummary): { list: SessionSummary[]; dropped: string[] } {
  const next = [sum, ...list.filter((x) => x.id !== sum.id)].sort((a, b) => b.updatedAt - a.updatedAt)
  return { list: next.slice(0, MAX_HISTORY), dropped: next.slice(MAX_HISTORY).map((x) => x.id) }
}

export function addPending(list: readonly PendingItem[], item: PendingItem): PendingItem[] {
  // Same open text twice (Claude re-reporting it) is one item.
  if (list.some((p) => p.status === 'open' && p.text.trim().toLowerCase() === item.text.trim().toLowerCase())) return [...list]
  return [...list, item]
}

export function resolvePending(list: readonly PendingItem[], idOrText: string, now: number): { list: PendingItem[]; hit?: PendingItem } {
  const key = idOrText.trim().toLowerCase()
  const hit = list.find((p) => p.status === 'open' && (p.id === idOrText || p.text.toLowerCase().includes(key)))
  if (!hit) return { list: [...list] }
  return { list: list.map((p) => (p === hit ? { ...p, status: 'done', doneAt: now } : p)), hit }
}

// Keep done items for a week so the list doesn't grow forever.
export function prunePending(list: readonly PendingItem[], now: number): PendingItem[] {
  return list.filter((p) => p.status === 'open' || (p.doneAt ?? 0) > now - 7 * 86400_000)
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function fmtUsd(n: number | undefined): string {
  if (n === undefined) return '—'
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtWhen(ms: number, now: number): string {
  const d = new Date(ms)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${hm}`
}

export function bar(done: number, total: number, width: number): string {
  if (total <= 0) return ''
  const w = Math.max(4, width)
  const n = Math.round((done / total) * w)
  return '█'.repeat(n) + '░'.repeat(w - n)
}

export function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ---------- workers: activity, run history, estimates ----------

export const isLive = (status: string) => status === 'running' || status === 'pending' || status === 'waiting'
export const isFinal = (status: string) => status === 'completed' || status === 'failed' || status === 'killed'

/** What the worker is doing, as one emoji, from the tool it last called. */
export function toolEmoji(tool?: string, detail?: string): string {
  if (!tool) return '💭'
  if (tool === 'Bash') return /\b(test|pytest|unittest|jest|vitest|node --test)\b/.test(detail ?? '') ? '🧪' : '⚙️'
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return '🔎'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return '✏️'
  if (tool === 'WebFetch' || tool === 'WebSearch') return '🌐'
  if (tool === 'Agent' || tool === 'SendMessage') return '🤖'
  if (tool === 'TodoWrite' || tool.startsWith('Task')) return '📋'
  if (tool.includes('chrome') || tool.includes('playwright') || tool.includes('Browser')) return '🖥️'
  if (tool.startsWith('mcp__')) return '🔌'
  return '🛠️'
}

/** A short phrase for the call: the file, pattern, command, host or query. */
export function toolDetail(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') return baseName(str('file_path'))
  if (tool === 'NotebookEdit') return baseName(str('notebook_path'))
  if (tool === 'Grep' || tool === 'Glob') return oneLine(str('pattern'), 40)
  if (tool === 'Bash') return oneLine(str('description') || str('command'), 48)
  if (tool === 'WebFetch') return str('url').replace(/^https?:\/\//, '').split('/')[0] ?? ''
  if (tool === 'WebSearch') return oneLine(str('query'), 40)
  if (tool === 'Agent') return oneLine(str('description'), 40)
  return ''
}

export function median(xs: readonly number[]): number {
  const v = [...xs].sort((a, b) => a - b)
  if (!v.length) return 0
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2
}

/** First guesses per agent type until two real runs are on record. */
export const PRIORS: Record<string, { d: number; t: number }> = {
  Explore: { d: 3 * 60_000, t: 25 },
  Plan: { d: 4 * 60_000, t: 20 },
  'general-purpose': { d: 10 * 60_000, t: 60 },
  'claude-code-guide': { d: 2 * 60_000, t: 10 },
  fork: { d: 5 * 60_000, t: 30 },
}
const DEFAULT_PRIOR = { d: 7 * 60_000, t: 40 }

export function recordRun(stats: AgentStats, type: string, durMs: number, tools: number): AgentStats {
  if (durMs < 5_000) return stats // a wake-up that did nothing says little about real runs
  const cur = stats[type] ?? { d: [], t: [] }
  return { ...stats, [type]: { d: [...cur.d, Math.round(durMs)].slice(-20), t: [...cur.t, tools].slice(-20) } }
}

export type Estimate = {
  pct: number | null // 0..1, null when unknown
  etaMs: number | null // time left, null when unknown or overdue
  overtimeMs: number // how far past the expected length, 0 when not
  basis: 'todos' | 'history' | 'prior' | 'done' | 'idle'
  detail: string // what the estimate rests on, in words
}

/**
 * Progress for one worker's current run. Its own todo list wins when it has one;
 * otherwise elapsed time and tool calls against the median of past runs of its type
 * (or a first guess), capped at 95% so an estimate never claims to be finished.
 */
export function estimate(a: TrackedAgent, now: number, stats: AgentStats, todos: readonly Todo[]): Estimate {
  if (isFinal(a.status)) return { pct: a.status === 'completed' ? 1 : null, etaMs: null, overtimeMs: 0, basis: 'done', detail: a.status }
  if (!isLive(a.status)) return { pct: null, etaMs: null, overtimeMs: 0, basis: 'idle', detail: 'waiting for its next task' }
  const elapsed = Math.max(0, now - (a.runStartedAt ?? a.startedAt))
  const own = todos.filter((t) => t.owner === a.id)
  if (own.length >= 2) {
    const done = own.filter((t) => t.status === 'completed').length
    const doing = own.filter((t) => t.status === 'in_progress').length
    const pct = Math.min(0.98, (done + 0.5 * doing) / own.length)
    const etaMs = done > 0 ? (elapsed / done) * (own.length - done) : null
    return { pct, etaMs, overtimeMs: 0, basis: 'todos', detail: `${done}/${own.length} of its todos done` }
  }
  const hist = stats[a.type]
  const fromHistory = !!hist && hist.d.length >= 2
  const base = fromHistory ? { d: median(hist.d), t: median(hist.t) } : (PRIORS[a.type] ?? DEFAULT_PRIOR)
  const raw = 0.6 * (elapsed / base.d) + 0.4 * ((a.runTools ?? 0) / Math.max(1, base.t))
  const overtimeMs = elapsed > base.d * 1.25 ? elapsed - base.d : 0
  const pct = Math.min(0.95, raw)
  return {
    pct,
    etaMs: overtimeMs ? null : Math.max(0, base.d * (1 - pct)),
    overtimeMs,
    basis: fromHistory ? 'history' : 'prior',
    detail: fromHistory ? `typical ${a.type} run: ${fmtDur(base.d)} (${hist.d.length} on record)` : `first guess for ${a.type}: ~${fmtDur(base.d)}`,
  }
}

export function fmtEta(est: Estimate): string {
  if (est.basis === 'done') return est.detail
  if (est.basis === 'idle') return 'standby'
  if (est.overtimeMs) return `+${fmtDur(est.overtimeMs)} over`
  if (est.etaMs === null) return 'estimating'
  const approx = est.basis === 'prior' ? '≈' : '~'
  return est.etaMs < 30_000 ? 'finishing' : `${approx}${fmtDur(est.etaMs)} left`
}
