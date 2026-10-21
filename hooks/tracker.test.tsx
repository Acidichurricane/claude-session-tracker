import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { AgentInfo, SessionContextBreakdown } from 'claude-code'

import { clipPatch, forStorage, groupFiles, patchText, resolvePending, addPending, emptySession } from './model'
import { avatarWords, callsign, contextBarWords, encodeCells, gauge, hash } from './art'
import { estimate, fmtEta, recordRun, toolEmoji, toolDetail, median } from './model'
import type { TrackedAgent } from '../types'

const PANE = {
  plugin: 'session-tracker',
  component: 'Pane',
  requestId: 'session-tracker',
  props: { title: 'Tracker', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// Stand in for the engine beneath the plugin: an in-memory store and fixed session facts.
function engine(on: Parameters<TestBody>[1], cost = { usd: 0 }, agents: () => AgentInfo[] = () => []) {
  const store = new Map<string, unknown>()
  let t = T0
  on('clock.now', () => ({ value: (t += 1000) }))
  on('clock.after', () => ({ value: undefined })) // fires at once
  on('clock.every', () => ({ deny: 'no intervals in tests' }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('store.delete', (_, e) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/home/me/proj' }))
  on('session.usage', (_, e) => ({ value: { startedAt: 0, cost,
    context: { window: 200000, percent: 12, tokens: 24000, ...(e.breakdown ? { breakdown: BREAKDOWN } : {}) },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: new Date(T0 + 95 * 60000).toISOString() }, { kind: 'seven_day', percentUsed: 8 }] } }))
  on('agent.list', () => ({ value: agents() }))
  on('command.register', () => ({ value: { command: 'tracker' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__session-tracker__track' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'sess-1' }))
  return store
}

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 9000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 15000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 176000, color: 'inactive', isDeferred: false, kind: 'free' },
  ],
  totalTokens: 24000, maxTokens: 200000, rawMaxTokens: 200000, autocompactSource: 'model', percentage: 12, gridRows: [],
  model: 'm', memoryFiles: [], mcpTools: [], agents: [], autoCompactThreshold: 160000, isAutoCompactEnabled: true, apiUsage: null,
} as unknown as SessionContextBreakdown

const T0 = 1_792_600_000_000 // the fake clock's start

const EDIT_RESULT = {
  filePath: '/home/me/proj/src/app.ts', oldString: 'a', newString: 'b', originalFile: 'a\n', userModified: false, replaceAll: false,
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
}

test('an Edit shows under its folder, and its diff opens on press', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: EDIT_RESULT }))
  await $.session.start({ cwd: '/home/me/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/home/me/proj/src/app.ts', old_string: 'a', new_string: 'b' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-files' })
    expect(await ui.find({ type: 'Text', text: /src\// })).toBeDefined()
    await ui.press({ key: 'f-/home/me/proj/src/app.ts' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.press({ key: 'files-back' })
    await ui.press({ key: 'tab-overview' })
    await ui.unmount()
  }
})

test('Claude records a pending item; marking it done persists', async ($, on) => {
  const store = engine(on)
  await $.session.start({ cwd: '/home/me/proj', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'mcp__session-tracker__track', kind: 'pending', category: 'config', text: 'Add the API token to the config file' } as never)
  expect(typeof (r as { result: unknown }).result).toBe('string')
  expect(String((r as { result: unknown }).result)).toMatch(/^Recorded pending item/)
  await $.tool.call({ tool: 'mcp__session-tracker__track', kind: 'difficulty', text: 'The first approach was blocked' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-pending' })
  expect(await ui.find({ type: 'Text', text: /Add the API token/ })).toBeDefined()
  const button = await ui.find({ type: 'Button', text: /mark done/ })
  expect(button).toBeDefined()
  await ui.press({ key: String(button?.key) })
  expect(await ui.find({ type: 'Text', text: /Nothing pending/ })).toBeDefined()
  await ui.press({ key: 'tab-issues' })
  expect(await ui.find({ type: 'Text', text: /The first approach was blocked/ })).toBeDefined()
  await ui.unmount()

  await $.session.end({ reason: 'other' } as never)
  const saved = store.get('pending') as { status: string }[]
  expect(saved[0]?.status).toBe('done')
  expect((store.get('history') as unknown[]).length).toBe(1)
})

test('a query records its cost as the change in session cost', async ($, on) => {
  const cost = { usd: 1.0 }
  engine(on, cost)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  await $.session.start({ cwd: '/home/me/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'build the thing', turnId: 't1' } as never)
  cost.usd = 1.25
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, model: 'm' } } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '$0.25' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /build the thing/ })).toBeDefined()
  await ui.unmount()
})

test('the HUD shows the context window, usage limits and avatars', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-haiku', agentId: 'ag-1' }))
  await $.session.start({ cwd: '/home/me/proj', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'look around', description: 'Scout the repo', subagentType: 'Explore' } as never)
  // The refresh timer is refused in tests; a session end runs one refresh.
  await $.session.end({ reason: 'other' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '12%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /24k \/ 200k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '42.5%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /resets in 1h 3\dm/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacts at 160k/ })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'ctxbar' })).toBeDefined()
  await ui.press({ key: 'tab-agents' })
  expect(await ui.find({ type: 'Raster', key: 'av-c-ag-1' })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'av-core-card' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Scout the repo' })).toBeDefined()
  await ui.unmount()

  // Off the terminal there is no Raster: avatars fall back to glyphs and the pane still draws.
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab-overview' }) // the tab is session state: still Agents from above
  expect(await desk.find({ type: 'Text', text: '42.5%' })).toBeDefined()
  await desk.unmount()
})

test('a teammate goes back to work: HUD shows it with progress, standby in between, and runs feed the estimate', async ($, on) => {
  let listed: AgentInfo['status'] = 'running'
  engine(on, { usd: 0 }, () => [{ id: 'ag-7', description: 'Build the backend', type: 'general-purpose', status: listed } as AgentInfo])
  on('agent.spawn', () => ({ model: 'claude-opus', agentId: 'ag-7' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/home/me/proj', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: 'Build the backend', subagentType: 'general-purpose' } as never)
  await $.turn.start({ text: 'go', turnId: 'r1', agentId: 'ag-7' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'def sync', agentId: 'ag-7' } as never)

  const name = callsign('ag-7')
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-overview' })
  expect(await ui.find({ type: 'Text', text: 'ACTIVE WORKERS' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: name })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /left|finishing|estimating/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Grep def sync/ })).toBeDefined()
  await ui.unmount()

  // The run ends: the agent is on standby, not "done", and the run is on record.
  listed = 'idle'
  await $.turn.complete({ answer: 'ok', durationMs: 120_000, isAborted: false, turnId: 'r1', reason: 'answer', agentId: 'ag-7' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'STANDING BY' })).toBeDefined()
  await ui.unmount()

  // It picks up a new message: working again, back at the top of the HUD.
  listed = 'running'
  await $.turn.start({ text: 'more', turnId: 'r2', agentId: 'ag-7' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'ACTIVE WORKERS' })).toBeDefined()
  await ui.press({ key: 'tab-agents' })
  expect(await ui.find({ type: 'Text', text: /WORKING/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 runs/ })).toBeDefined()
  await ui.unmount()
})

test('estimates', async () => {
  const base: TrackedAgent = { id: 'a', type: 'Explore', description: '', status: 'running', startedAt: 0, runStartedAt: 0, tools: 0, runTools: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  // First guess: Explore ~3 min; 90 s in with 10 tools → about half way, dim "≈".
  const prior = estimate({ ...base, runTools: 10 }, 90_000, {}, [])
  expect(prior.basis).toBe('prior')
  expect(prior.pct!).toBeGreaterThan(0.4)
  expect(prior.pct!).toBeLessThan(0.6)
  expect(fmtEta(prior)).toMatch(/^≈/)
  // History beats the guess once two runs are on record.
  let st = recordRun({}, 'Explore', 60_000, 10)
  st = recordRun(st, 'Explore', 120_000, 20)
  st = recordRun(st, 'Explore', 1_000, 1) // under 5 s: ignored
  expect(st.Explore?.d).toEqual([60_000, 120_000])
  const hist = estimate({ ...base, runTools: 15 }, 45_000, st, [])
  expect(hist.basis).toBe('history')
  expect(median([60_000, 120_000])).toBe(90_000)
  // Way past the typical length: capped, flagged as over, no fake ETA.
  const over = estimate({ ...base, runTools: 5 }, 400_000, st, [])
  expect(over.pct).toBe(0.95)
  expect(over.etaMs).toBeNull()
  expect(fmtEta(over)).toMatch(/over$/)
  // Its own todo list wins.
  const todos = [{ id: '1', text: 'a', status: 'completed' as const, owner: 'a' }, { id: '2', text: 'b', status: 'completed' as const, owner: 'a' },
    { id: '3', text: 'c', status: 'pending' as const, owner: 'a' }, { id: '4', text: 'd', status: 'pending' as const, owner: 'a' }]
  const td = estimate(base, 60_000, st, todos)
  expect(td.basis).toBe('todos')
  expect(td.pct).toBe(0.5)
  expect(td.etaMs).toBe(60_000)
  // Standby and finished agents.
  expect(estimate({ ...base, status: 'idle' }, 1, {}, []).basis).toBe('idle')
  expect(estimate({ ...base, status: 'completed' }, 1, {}, []).pct).toBe(1)
  // Activity emoji and detail.
  expect(toolEmoji('Bash', 'python3 -m unittest discover')).toBe('🧪')
  expect(toolEmoji('Edit')).toBe('✏️')
  expect(toolEmoji(undefined)).toBe('💭')
  expect(toolDetail('Edit', { file_path: '/a/b/c.ts' })).toBe('c.ts')
  // A working avatar blinks on every fifth frame; a finished one never does.
  expect(avatarWords('x', 'live', 4)).not.toEqual(avatarWords('x', 'live', 0))
  expect(avatarWords('x', 'done', 4)).toEqual(avatarWords('x', 'done', 0))
})

test('model helpers', async () => {
  const p = patchText([{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' x', '-y', '+y2', '+z'] }])
  expect(p).toEqual({ patch: '@@ -3,2 +3,3 @@\n x\n-y\n+y2\n+z', adds: 2, dels: 1 })
  const created = patchText([], 'one\ntwo\n')
  expect(created.adds).toBe(2)
  expect(created.patch.startsWith('@@ -0,0 +1,2 @@')).toBe(true)

  const long = ['@@ -1,1 +1,1 @@', '-a', '+b', '@@ -9,1 +9,1 @@', '-c', '+' + 'x'.repeat(5000)].join('\n')
  expect(clipPatch(long)).toBe('@@ -1,1 +1,1 @@\n-a\n+b')

  const groups = groupFiles([
    { path: '/p/a/x.ts', at: 1, kind: 'edit', adds: 1, dels: 0, patch: '' },
    { path: '/p/a/x.ts', at: 3, kind: 'edit', adds: 2, dels: 1, patch: '' },
    { path: '/p/b.ts', at: 2, kind: 'create', adds: 5, dels: 0, patch: '' },
  ], '/p')
  expect(groups.map((g) => g.dir)).toEqual(['a', '.'])
  expect(groups[0]?.files[0]).toEqual({ path: '/p/a/x.ts', adds: 3, dels: 1, edits: 2, last: 3 })

  const s = emptySession('s', '/p', 0)
  s.files = Array.from({ length: 50 }, (_, i) => ({ path: `/p/${i}`, at: i, kind: 'edit' as const, adds: 0, dels: 0, patch: 'y'.repeat(4000) }))
  const stored = forStorage(s)
  expect(stored.files.at(-1)?.patch.length).toBe(4000)
  expect(stored.files[0]?.patch).toBe('')

  let list = addPending([], { id: '1', kind: 'config', text: 'Do X', status: 'open', createdAt: 0, sessionId: 's' })
  list = addPending(list, { id: '2', kind: 'config', text: 'do x ', status: 'open', createdAt: 0, sessionId: 's' })
  expect(list.length).toBe(1)
  expect(resolvePending(list, 'do x', 5).hit?.id).toBe('1')

  // Art: stable, mirrored avatars; base64 that decodes back; proportional bar.
  expect(hash('a')).toBe(hash('a'))
  const w = avatarWords('agent-xyz', 'live')
  expect(w.length).toBe(8 * 4 * 3)
  expect(avatarWords('agent-xyz', 'live')).toEqual(w)
  for (let row = 0; row < 4; row++) for (let x = 0; x < 4; x++) {
    expect(w[(row * 8 + x) * 3 + 1]).toBe(w[(row * 8 + 7 - x) * 3 + 1])
  }
  expect(callsign('agent-xyz')).toMatch(/^[A-Z]+-[0-9A-F]{3}$/)
  expect(encodeCells([0x2588, 0xff8800, 0x01000000])).toBe(btoa(String.fromCharCode(0x88, 0x25, 0, 0, 0, 0x88, 0xff, 0, 0, 0, 0, 1)))
  const barCells = contextBarWords([{ name: 'a', tokens: 25, kind: 'used', color: 'claude' }, { name: 'f', tokens: 75, kind: 'free', color: 'inactive' }], 8)
  expect(barCells.length).toBe(24)
  expect(barCells[1]).toBe(0xf97316)
  expect(barCells[3 * 2 + 1]).toBe(0x1e293b)
  expect(gauge(50, 10)).toBe('▰▰▰▰▰▱▱▱▱▱')
})
