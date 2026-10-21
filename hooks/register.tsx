// Session tracker: a side pane for subagents, token use and cost, todos, file diffs,
// pending items and difficulties. History and open pending items persist via $.store.
import { atom, read, update } from 'claude-code'
import type { BuiltinToolResults, EngineInterface, Register } from 'claude-code'

import type { AgentStats, FileChange, Issue, PendingItem, RateWindow, SessionRecord, SessionSummary, Todo, TrackedAgent, WindowUsage } from '../types'
import {
  ZERO, addPending, addUsage, emptySession, forStorage, isFinal, isLive, oneLine, patchText, prunePending, recordRun, resolvePending, summarize,
  toolDetail, upsertHistory,
} from './model'
import { drawPane } from './view'
import type { Els } from './view'

const PANE = 'session-tracker'
const TOOL = 'mcp__session-tracker__track'

// Declared in each file that reads them: the engine lists a module's state from its own consts.
const live = atom({ plugin: 'session-tracker', key: 'live' } as const, null)
const pending = atom({ plugin: 'session-tracker', key: 'pending' } as const, [])
const history = atom({ plugin: 'session-tracker', key: 'history' } as const, [])
const tab = atom({ plugin: 'session-tracker', key: 'tab' } as const, 'overview')
const stats = atom({ plugin: 'session-tracker', key: 'stats' } as const, {})
const tick = atom({ plugin: 'session-tracker', key: 'tick' } as const, 0)

type $T = EngineInterface

// ---------- persistence (debounced; module timers reset on reload, state does not) ----------

let saveTimer: { cancel: () => void } | undefined

async function saveNow($: $T) {
  const s = await read($, live)
  if (!s) return
  const pend = prunePending(await read($, pending), await $.clock.now())
  const { list, dropped } = upsertHistory(await read($, history), summarize(s))
  try {
    await $.store.set(`session:${s.id}`, forStorage(s))
    await $.store.set('history', list)
    await $.store.set('pending', pend)
    for (const id of dropped) await $.store.delete(`session:${id}`)
  } catch {
    // Store full (4 MiB): drop the oldest stored session and try once more.
    const oldest = list.at(-1)
    if (oldest && oldest.id !== s.id) {
      await $.store.delete(`session:${oldest.id}`)
      await $.store.set('history', list.slice(0, -1))
    }
  }
  await update($, history, () => list)
}

function scheduleSave($: $T) {
  saveTimer?.cancel()
  saveTimer = $.clock.after(3000, () => void saveNow($))
}

async function edit($: $T, fn: (s: SessionRecord) => SessionRecord) {
  const now = await $.clock.now()
  await update($, live, (s) => (s ? { ...fn(s), updatedAt: now } : s))
  scheduleSave($)
}

const currentQueryId = (s: SessionRecord) => s.queries.findLast((q) => q.status === 'running')?.id

async function addIssue($: $T, issue: Omit<Issue, 'at'>) {
  const at = await $.clock.now()
  await edit($, (s) => ({ ...s, issues: [...s.issues, { ...issue, text: oneLine(issue.text, 400), at }].slice(-300) }))
}

// ---------- hooks ----------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const now = await $.clock.now()
    const cur = await read($, live)
    if (!cur || cur.id !== id) {
      // A resumed session finds its own record again.
      const stored = (await $.store.get(`session:${id}`)) as SessionRecord | undefined
      const cwd = await $.session.cwd()
      await update($, live, () => stored ?? emptySession(id, cwd, now))
      const savedPending = ((await $.store.get('pending')) as PendingItem[] | undefined) ?? []
      await update($, pending, () => prunePending(savedPending, now))
      const savedHistory = ((await $.store.get('history')) as SessionSummary[] | undefined) ?? []
      await update($, history, () => savedHistory)
      const savedStats = ((await $.store.get('agentStats')) as AgentStats | undefined) ?? {}
      await update($, stats, () => savedStats)
    }

    await $.command.register({ name: 'tracker', description: 'Open the session tracker pane (agents, cost, files, pending items)' })
    await $.tool.register({
      name: 'track',
      description:
        "Record an item in the user's session tracker panel. kind='pending': something the user must do or configure, or work left undone (set category to config, action or follow-up). kind='difficulty': a notable problem you hit (a failed approach, a blocker, a workaround). kind='resolve': mark a pending item done, by id or by part of its text. Keep text to one sentence.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['pending', 'difficulty', 'resolve'] },
          text: { type: 'string', description: 'One sentence; for resolve, the item id or part of its text' },
          category: { type: 'string', enum: ['config', 'action', 'follow-up'] },
        },
        required: ['kind', 'text'],
      },
      isDeferred: false,
    })

    // Live cost/context and agent statuses, every few seconds.
    $.clock.every(4000, () => void refresh($))
    // Spinner frames, blinking avatars and live timers: only while something is working.
    $.clock.every(1500, () => void tickOnce($))
    void $.ui.open({ id: PANE, title: 'Tracker' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    saveTimer?.cancel()
    await refresh($)
    await saveNow($)
    return next(e)
  })

  on('command.run', { command: 'tracker' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Tracker', focus: true })
    return { text: 'Session tracker opened.' }
  })

  // A short standing instruction so Claude feeds the pending/difficulty lists.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!e.tools.includes(TOOL)) return r
    return {
      sections: [...r.sections, {
        id: 'session-tracker:guide',
        scope: 'session',
        text: `The user has a session tracker panel. Use ${TOOL} to record: (kind "pending") each configuration step, credential, decision or manual action the user still has to take, and work you leave unfinished; (kind "difficulty") real problems you hit, such as a failed approach, an unexpected error or a workaround; (kind "resolve") pending items that are now done. Record items when they arise, not as a summary at the end, and never duplicate the list in your reply text.`,
      }],
    }
  })

  // Main-loop queries and subagent runs.
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      const usage = await $.session.usage()
      const cost = usage.cost?.usd ?? 0
      await edit($, (s) => ({
        ...s,
        title: s.title || oneLine(e.text, 80),
        queries: [...s.queries, { id: e.turnId, prompt: oneLine(e.text, 200), startedAt: now, costAtStart: cost,
          tokens: { ...ZERO }, status: 'running' as const, tools: 0 }].slice(-200),
      }))
    } else {
      // Each turn of an agent's loop is a run; a teammate goes back to work this way.
      const id = e.agentId
      await ensureAgent($, id, now)
      await edit($, (s) => ({ ...s, agents: s.agents.map((a) => (a.id === id
        ? { ...a, status: 'running' as const, runs: (a.runs ?? 0) + 1, runStartedAt: now, runTools: 0, endedAt: undefined }
        : a)) }))
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const cost = usage.cost?.usd
    await edit($, (s) => {
      const tokens = addUsage(s.tokens, e.usage)
      if (e.agentId === undefined) {
        return { ...s, tokens, costUsd: cost ?? s.costUsd,
          queries: s.queries.map((q) => (q.id === e.turnId
            ? { ...q, endedAt: now, status: e.reason, tokens: addUsage(q.tokens, e.usage),
                costUsd: cost !== undefined ? cost - q.costAtStart : undefined }
            : q)) }
      }
      // An answer ends this run, not necessarily the agent: `refresh` settles idle vs completed from agent.list.
      return { ...s, tokens, costUsd: cost ?? s.costUsd,
        agents: s.agents.map((a) => (a.id === e.agentId ? { ...a, tokens: addUsage(a.tokens, e.usage), endedAt: now,
          activeMs: (a.activeMs ?? 0) + (a.runStartedAt ? now - a.runStartedAt : 0), runStartedAt: undefined,
          status: e.reason === 'answer' ? 'idle' as const : e.reason === 'aborted' ? 'killed' as const : 'failed' as const } : a)) }
    })
    if (e.agentId !== undefined && e.reason === 'answer') {
      const a = (await read($, live))?.agents.find((x) => x.id === e.agentId)
      if (a) {
        await update($, stats, (st) => recordRun(st, a.type, e.durationMs, a.runTools ?? 0))
        await $.store.set('agentStats', await read($, stats))
      }
      void refresh($)
    }
    if (e.reason === 'error' || e.reason === 'refusal') {
      await addIssue($, { kind: 'turn-error', text: e.reason === 'refusal' ? `Model refused: ${e.refusal.explanation ?? e.refusal.category ?? ''}` : 'Turn ended on an API error', agentId: e.agentId })
    } else if (e.reason === 'aborted' && e.agentId === undefined) {
      await addIssue($, { kind: 'aborted', text: 'Query interrupted' })
    }
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const now = await $.clock.now()
      const id = r.agentId
      await edit($, (s) => (s.agents.some((a) => a.id === id) ? s : {
        ...s,
        agents: [...s.agents, { id, type: e.subagentType, description: e.description, model: r.model, status: 'running' as const,
          startedAt: now, tools: 0, tokens: { ...ZERO }, queryId: currentQueryId(s), runs: 0, runTools: 0, activeMs: 0 }].slice(-100),
      }))
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL) return answerTrack($, e as unknown as { kind: string; text: string; category?: string })

    const r = await next(e)
    const now = await $.clock.now()

    // Counters for the agent or query that ran it.
    await edit($, (s) => {
      if (e.agentId) {
        const detail = toolDetail(String(e.tool), e as unknown as Record<string, unknown>)
        return { ...s, agents: s.agents.map((a) => (a.id === e.agentId
          ? { ...a, tools: a.tools + 1, runTools: (a.runTools ?? 0) + 1, lastTool: String(e.tool), lastToolDetail: detail, lastToolAt: now }
          : a)) }
      }
      const qid = currentQueryId(s)
      return { ...s, queries: s.queries.map((q) => (q.id === qid ? { ...q, tools: q.tools + 1 } : q)) }
    })

    if ('deny' in r && r.deny !== undefined) {
      await addIssue($, { kind: 'denied', text: r.deny, tool: String(e.tool), agentId: e.agentId })
      return r
    }
    if (r.isError) {
      await addIssue($, { kind: 'tool-error', text: r.text ?? 'error', tool: String(e.tool), agentId: e.agentId })
      return r
    }

    // File changes with their diffs. `r` is typed loosely (the tool was not narrowed
    // before `next`), so read each built-in's record by its declared shape.
    const res = r.result as unknown
    let change: FileChange | undefined
    if (e.tool === 'Edit' && res) {
      const x = res as BuiltinToolResults['Edit']
      if (!x.staged) change = { path: x.filePath, kind: 'edit', at: now, ...patchText(x.structuredPatch) }
    } else if (e.tool === 'Write' && res) {
      const x = res as BuiltinToolResults['Write']
      const created = x.type === 'create'
      if (!x.staged) {
        change = { path: x.filePath, kind: created ? 'create' : 'write', at: now,
          ...patchText(x.structuredPatch, created || !x.structuredPatch.length ? x.content : undefined) }
      }
    } else if (e.tool === 'NotebookEdit') {
      change = { path: String((e as { notebook_path?: string }).notebook_path ?? ''), kind: 'notebook', at: now, adds: 0, dels: 0, patch: '' }
    }
    if (change && change.path) {
      const c = change
      await edit($, (s) => ({ ...s, files: [...s.files, { ...c, agentId: e.agentId, queryId: currentQueryId(s) }].slice(-500) }))
    }

    // Todo list / tasks.
    if (e.tool === 'TodoWrite' && res) {
      const x = res as BuiltinToolResults['TodoWrite']
      const todos: Todo[] = x.newTodos.map((t, i) => ({ id: `todo-${i}`, text: t.content, status: t.status, owner: e.agentId }))
      await edit($, (s) => ({ ...s, todos: [...s.todos.filter((t) => !t.id.startsWith('todo-') || t.owner !== e.agentId), ...todos] }))
    } else if (e.tool === 'TaskCreate' && res) {
      const t = (res as BuiltinToolResults['TaskCreate']).task
      await edit($, (s) => ({ ...s, todos: [...s.todos, { id: `task-${t.id}`, text: t.subject, status: 'pending', owner: e.agentId }] }))
    } else if (e.tool === 'TaskUpdate' && res && (res as BuiltinToolResults['TaskUpdate']).success) {
      const input = e as unknown as { taskId: string; status?: string; subject?: string }
      await edit($, (s) => ({
        ...s,
        todos: input.status === 'deleted'
          ? s.todos.filter((t) => t.id !== `task-${input.taskId}`)
          : s.todos.map((t) => (t.id === `task-${input.taskId}`
            ? { ...t, status: (input.status as Todo['status']) ?? t.status, text: input.subject ?? t.text }
            : t)),
      }))
    }
    return r
  })

  // ---------- pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const base = $.ui.resolve(e)
    const s = await read($, live)
    if (!s) return <base.Text dimColor>Starting…</base.Text>
    // Pixel avatars and the context bar need Raster, which only the terminal draws.
    const els: Els = e.surface === 'terminal'
      ? { ...$.ui.resolve(e), Raster: $.ui.resolve(e).Raster }
      : { Box: base.Box, Text: base.Text, Button: base.Button, Code: base.Code }
    return drawPane($, {
      els, s,
      pend: await read($, pending),
      t: await read($, tab),
      stats: await read($, stats),
      frame: await read($, tick),
      now: await $.clock.now(),
      cols: Math.max(24, e.props.bodyColumns),
      save: () => scheduleSave($),
    }) as never
  })
}

// ---------- helpers that need $ ----------

// Registered tools answer with text: the engine checks the result against string | blocks.
async function answerTrack($: $T, input: { kind: string; text: string; category?: string }) {
  const s = await read($, live)
  const now = await $.clock.now()
  const text = oneLine(input.text ?? '', 300)
  if (!text) return { result: 'Not recorded: text is required.' }
  if (input.kind === 'difficulty') {
    await addIssue($, { kind: 'reported', text })
    return { result: 'Recorded as a difficulty in the tracker.' }
  }
  if (input.kind === 'resolve') {
    let hit: PendingItem | undefined
    await update($, pending, (l) => {
      const r = resolvePending(l, input.text, now)
      hit = r.hit
      return r.list
    })
    scheduleSave($)
    return { result: hit ? `Marked done: ${hit.text}` : 'No open pending item matches that.' }
  }
  const kind = input.category === 'config' || input.category === 'action' ? input.category : 'follow-up'
  const item: PendingItem = { id: `p${now.toString(36)}`, kind, text, status: 'open', createdAt: now, sessionId: s?.id ?? '' }
  await update($, pending, (l) => addPending(l, item))
  scheduleSave($)
  return { result: `Recorded pending item ${item.id}.` }
}

async function ensureAgent($: $T, id: string, now: number) {
  const s = await read($, live)
  if (!s || s.agents.some((a) => a.id === id)) return
  const info = (await $.agent.list()).find((a) => a.id === id)
  const agent: TrackedAgent = { id, type: info?.type ?? 'agent', description: info?.description ?? '', status: 'running',
    startedAt: now, tools: 0, tokens: { ...ZERO }, queryId: currentQueryId(s) }
  await edit($, (x) => (x.agents.some((a) => a.id === id) ? x : { ...x, agents: [...x.agents, agent].slice(-100) }))
}

let refreshCount = 0

async function refresh($: $T) {
  const s = await read($, live)
  if (!s) return
  const now = await $.clock.now()
  // The /context-style breakdown is a local estimate (no request); take it every 5th tick.
  const withBreakdown = refreshCount++ % 5 === 0
  const usage = await $.session.usage(withBreakdown ? { breakdown: 'summary' } : {})
  const cost = usage.cost?.usd ?? s.costUsd
  const ctx = usage.context
  const bd = ctx.breakdown
  const window: WindowUsage = {
    tokens: ctx.tokens,
    window: ctx.window,
    percent: ctx.percent,
    categories: bd ? bd.categories.map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind, color: c.color })) : s.window?.categories,
    autoCompactAt: bd ? bd.autoCompactThreshold : s.window?.autoCompactAt,
  }
  const rateLimits: RateWindow[] = usage.rateLimits.map((r) => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  let agents = s.agents
  // Poll while any agent can still change: a teammate flips between running and idle.
  if (s.agents.some((a) => !isFinal(a.status))) {
    const list = await $.agent.list()
    agents = s.agents.map((a) => {
      const info = list.find((x) => x.id === a.id)
      if (!info || info.status === a.status) return a
      // agent.list says running before our turn.start hook may have opened the run.
      return isLive(info.status) && !a.runStartedAt
        ? { ...a, status: info.status, runStartedAt: now, runTools: 0 }
        : { ...a, status: info.status }
    })
    if (agents.every((a, i) => a === s.agents[i])) agents = s.agents
  }
  const changed = Math.abs(cost - s.costUsd) >= 0.005 || agents !== s.agents
    || JSON.stringify(window) !== JSON.stringify(s.window) || JSON.stringify(rateLimits) !== JSON.stringify(s.rateLimits ?? [])
  if (changed) {
    await update($, live, (x) => (x ? { ...x, costUsd: cost, contextPercent: ctx.percent, contextWindow: ctx.window, window, rateLimits, agents } : x))
  }
}

async function tickOnce($: $T) {
  const s = await read($, live)
  if (!s) return
  if (s.agents.some((a) => isLive(a.status)) || s.queries.at(-1)?.status === 'running') {
    await update($, tick, (n) => (n + 1) % 1_000_000)
  }
}
