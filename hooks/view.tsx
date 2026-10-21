// The tracker pane, drawn as a HUD. Trade-off for a narrow docked pane: borders cost two rows
// each, so only the header and the live-workers panel are framed; other sections use a title rule.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AgentStats, Issue, PendingItem, SessionRecord, Tab, TrackedAgent } from '../types'
import { NEON, SPINNER, avatarColor, avatarWords, callsign, contextBarWords, encodeCells, fmtReset, gauge, levelColor, windowLabel } from './art'
import type { AvatarMood } from './art'
import { bar, baseName, estimate, fmtDur, fmtEta, fmtTokens, fmtUsd, fmtWhen, groupFiles, isFinal, isLive, oneLine, relPath, toolEmoji, totalTokens } from './model'
import type { Estimate } from './model'

// Declared here as well as in register.tsx: the engine lists a module's state from its own consts.
const pending = atom({ plugin: 'session-tracker', key: 'pending' } as const, [])
const history = atom({ plugin: 'session-tracker', key: 'history' } as const, [])
const tab = atom({ plugin: 'session-tracker', key: 'tab' } as const, 'overview')
const selectedFile = atom({ plugin: 'session-tracker', key: 'selectedFile' } as const, null)
const historyPick = atom({ plugin: 'session-tracker', key: 'historyPick' } as const, null)
const historyDetail = atom({ plugin: 'session-tracker', key: 'historyDetail' } as const, null)

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Els = { Box: any; Text: any; Button: any; Code: any; Raster?: any }

export type ViewCtx = {
  els: Els
  s: SessionRecord
  pend: PendingItem[]
  t: Tab
  now: number
  cols: number
  save: () => void
  stats: AgentStats
  frame: number
}

const mood = (st: string): AvatarMood =>
  isLive(st) ? 'live' : st === 'idle' ? 'idle' : st === 'failed' ? 'fail' : st === 'killed' ? 'stop' : 'done'

const STATUS: Record<AvatarMood, { label: string; color: string }> = {
  live: { label: '● LIVE', color: NEON.lime },
  idle: { label: '◌ STANDBY', color: NEON.cyan },
  done: { label: '✓ DONE', color: NEON.cyan },
  fail: { label: '✗ FAIL', color: NEON.red },
  stop: { label: '■ STOP', color: NEON.amber },
  core: { label: '◆ CORE', color: NEON.magenta },
}

export async function drawPane($: EngineInterface, c: ViewCtx) {
  const { els, s, pend, t, now, cols, stats, frame } = c
  const { Box, Text, Button } = els

  const openPending = pend.filter((p) => p.status === 'open')
  const running = s.agents.filter((a) => isLive(a.status))
  const standby = s.agents.filter((a) => a.status === 'idle')
  const est = (a: TrackedAgent): Estimate => estimate(a, now, stats, s.todos)
  const spin = SPINNER[frame % SPINNER.length]
  const fileCount = new Set(s.files.map((f) => f.path)).size
  const ctxPct = s.window?.percent ?? s.contextPercent

  // Avatar: pixel face on the terminal, a coloured glyph elsewhere.
  const avatar = (seed: string, m: AvatarMood, key: string) =>
    els.Raster
      ? <els.Raster key={`av-${key}`} columns={8} rows={4} cells={encodeCells(avatarWords(seed, m, frame))} />
      : <Text color={avatarColor(seed, m)} bold>◢◣</Text>

  const panel = (title: string, accent: string, children: unknown, extra?: string) => (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={accent}>▍{title}</Text>
        {extra ? <Text color={NEON.dim}>{extra}</Text> : null}
      </Box>
      {children}
    </Box>
  )

  const tabs: [Tab, string][] = [
    ['overview', 'HUD'],
    ['agents', `SQUAD ${s.agents.length}`],
    ['files', `FILES ${fileCount}`],
    ['pending', `TODO ${openPending.length}`],
    ['issues', `ISSUES ${s.issues.length}`],
    ['history', 'LOG'],
  ]

  const header = (
    <Box flexDirection="column" borderStyle="double" borderColor={NEON.cyan} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={NEON.cyan}>◈ AGENT OPS</Text>
        <Text>
          <Text color={NEON.lime} bold>{fmtUsd(s.costUsd)}</Text>
          <Text color={NEON.dim}>  ctx </Text>
          <Text color={ctxPct !== undefined ? levelColor(ctxPct) : NEON.dim} bold>{ctxPct !== undefined ? `${ctxPct}%` : '—'}</Text>
          {running.length
            ? <Text color={NEON.lime} bold>  {spin} {running.length} working</Text>
            : <Text color={NEON.dim}>  {standby.length ? `${standby.length} standby` : 'idle'}</Text>}
        </Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {tabs.map(([k, label], i) => (
          <Button key={`tab-${k}`} plain hotkey={String(i + 1)} label={t === k ? `▸${label}` : label}
            variant={t === k ? 'primary' : undefined} onPress={() => update($, tab, () => k)} />
        ))}
      </Box>
    </Box>
  )

  // A titled section without a frame: one row instead of two.
  const section = (title: string, accent: string, children: unknown, extra?: string) => (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={accent}>▍{title}</Text>
        {extra ? <Text color={NEON.dim}>{extra}</Text> : null}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>{children}</Box>
    </Box>
  )

  // Segmented progress for a worker: lit/unlit cells, dim while it is only a first guess.
  const progress = (e: Estimate, width: number) => e.pct === null
    ? <Text color={NEON.dim}>{'·'.repeat(width)}</Text>
    : <Text color={e.basis === 'prior' ? NEON.dim : e.overtimeMs ? NEON.amber : NEON.lime}>{gauge(e.pct * 100, width)}</Text>

  const agentName = (id?: string) => {
    if (!id) return 'CORE'
    const a = s.agents.find((x) => x.id === id)
    return a ? callsign(a.id) : 'agent'
  }
  const queryLabel = (id?: string) => {
    const q = s.queries.find((x) => x.id === id)
    return q ? oneLine(q.prompt, 40) : ''
  }
  const gw = Math.max(6, Math.min(20, cols - 30))

  let body: unknown
  if (t === 'overview') body = overview()
  else if (t === 'agents') body = squad()
  else if (t === 'files') body = await files()
  else if (t === 'pending') body = todo()
  else if (t === 'issues') body = issues()
  else body = await log()

  return (
    <Box flexDirection="column" gap={1}>
      {header}
      {body}
    </Box>
  )

  // ---------- tabs ----------

  function windowPanel() {
    const w = s.window
    const cats = (w?.categories ?? []).filter((x) => x.kind === 'used' && x.tokens > 0).sort((a, b) => b.tokens - a.tokens)
    const barWidth = Math.max(8, Math.min(48, cols - 8))
    const limits = s.rateLimits ?? []
    return section('WINDOW', NEON.cyan, (
      <Box flexDirection="column">
        <Text>
          <Text color={NEON.dim}>{'context'.padEnd(9)}</Text>
          <Text color={ctxPct !== undefined ? levelColor(ctxPct) : NEON.dim}>{gauge(ctxPct ?? 0, gw)}</Text>
          <Text bold> {ctxPct !== undefined ? `${ctxPct}%` : '—'}</Text>
          <Text color={NEON.dim}>  {w?.tokens !== undefined ? fmtTokens(w.tokens) : '—'} / {fmtTokens(w?.window ?? s.contextWindow ?? 0)}</Text>
        </Text>
        {w?.categories && els.Raster
          ? <els.Raster key="ctxbar" columns={barWidth} rows={1} cells={encodeCells(contextBarWords(w.categories, barWidth))} />
          : null}
        {cats.length > 0 && (
          <Text color={NEON.dim} wrap="truncate-end">
            {cats.slice(0, 3).map((x, i) => (
              <Text key={`cat-${x.name}`}><Text color={['#94a3b8', NEON.magenta, NEON.lime][i] ?? NEON.dim}>■</Text> {x.name} {fmtTokens(x.tokens)}{'  '}</Text>
            ))}
            {w?.autoCompactAt ? `compacts at ${fmtTokens(w.autoCompactAt)}` : ''}
          </Text>
        )}
        {limits.length
          ? limits.map((l) => (
            <Text key={`rl-${l.kind}`} wrap="truncate-end">
              <Text color={NEON.dim}>{windowLabel(l.kind).padEnd(9)}</Text>
              <Text color={levelColor(l.percentUsed)}>{gauge(l.percentUsed, gw)}</Text>
              <Text bold> {l.percentUsed}%</Text>
              <Text color={NEON.dim}>  {fmtReset(l.resetsAt, now)}</Text>
            </Text>
          ))
          : <Text color={NEON.dim}>usage limits: waiting for the next API response</Text>}
      </Box>
    ))
  }

  // One worker as two rows: what it is and how far along, then what it is doing right now.
  function workerRow(a: TrackedAgent) {
    const e = est(a)
    const m = mood(a.status)
    const live = m === 'live'
    const pw = Math.max(5, Math.min(10, cols - 46))
    const ago = a.lastToolAt ? fmtDur(now - a.lastToolAt) : ''
    return (
      <Box key={`w-${a.id}`} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={live ? NEON.lime : STATUS[m].color}>{live ? spin : m === 'idle' ? '◌' : '✓'}</Text>
            {' '}{live ? toolEmoji(a.lastTool, a.lastToolDetail) : '💤'}{' '}
            <Text bold color={avatarColor(a.id, m)}>{callsign(a.id)}</Text>
            <Text color={NEON.dim}> {a.type}</Text>
          </Text>
          <Text>
            {progress(e, pw)}
            <Text bold> {e.pct === null ? '' : `${Math.round(e.pct * 100)}%`}</Text>
            <Text color={e.overtimeMs ? NEON.amber : NEON.dim}> {fmtEta(e)}</Text>
          </Text>
        </Box>
        <Text color={NEON.dim} wrap="truncate-end">
          {'   '}{oneLine(a.description || '(no description)', 40)}
          {live && a.lastTool ? `  ▸ ${a.lastTool}${a.lastToolDetail ? ` ${a.lastToolDetail}` : ''}${ago ? ` · ${ago} ago` : ''}` : ''}
          {live ? `  ⏱ ${fmtDur(now - (a.runStartedAt ?? a.startedAt))}` : ''}
        </Text>
      </Box>
    )
  }

  function overview() {
    const q = s.queries.at(-1)
    const qCost = q && q.status === 'running' ? s.costUsd - q.costAtStart : q?.costUsd
    const done = s.todos.filter((x) => x.status === 'completed').length
    const doing = s.todos.find((x) => x.status === 'in_progress')
    const dirs = groupFiles(s.files, s.cwd)
    const adds = s.files.reduce((n, f) => n + f.adds, 0)
    const dels = s.files.reduce((n, f) => n + f.dels, 0)
    const finished = s.agents.filter((a) => isFinal(a.status))
    const shown = [...running, ...standby.slice(-3)]
    // Overall progress across live workers, weighted equally; unknowns left out.
    const pcts = running.map((a) => est(a).pct).filter((p): p is number => p !== null)
    const overall = pcts.length ? pcts.reduce((x, y) => x + y, 0) / pcts.length : null
    return (
      <Box flexDirection="column" gap={1}>
        {shown.length > 0
          ? (
            <Box flexDirection="column" borderStyle="round" borderColor={running.length ? NEON.lime : NEON.frame} paddingX={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold color={running.length ? NEON.lime : NEON.cyan}>▍{running.length ? 'ACTIVE WORKERS' : 'STANDING BY'}</Text>
                <Text color={NEON.dim}>
                  {overall !== null ? <Text><Text color={NEON.lime}>{gauge(overall * 100, 8)}</Text> {Math.round(overall * 100)}% overall  </Text> : null}
                  {finished.length ? `${finished.length} done` : ''}
                </Text>
              </Box>
              {shown.map(workerRow)}
            </Box>
          )
          : <Text color={NEON.dim}>◌ No workers running{finished.length ? `  ·  ${finished.length} finished this session` : ''}</Text>}
        {windowPanel()}
        {section('SESSION', NEON.magenta, (
          <Box flexDirection="column">
            <Text><Text bold color={NEON.lime}>{fmtUsd(s.costUsd)}</Text><Text color={NEON.dim}>  ·  </Text><Text bold>{fmtTokens(totalTokens(s.tokens))}</Text><Text color={NEON.dim}> tokens  (in {fmtTokens(s.tokens.input)} · out {fmtTokens(s.tokens.output)} · cache {fmtTokens(s.tokens.cacheRead + s.tokens.cacheWrite)})</Text></Text>
            {q && (
              <Text wrap="truncate-end">
                <Text color={q.status === 'running' ? NEON.lime : NEON.dim}>{q.status === 'running' ? `${spin} ${fmtDur(now - q.startedAt)}` : '◆ last'}</Text>
                <Text color={NEON.lime}> {fmtUsd(qCost)}</Text><Text color={NEON.dim}> · {q.tools} tools · </Text>{q.prompt || '(continuation)'}
              </Text>
            )}
          </Box>
        ), fmtWhen(s.startedAt, now))}
        {s.todos.length > 0 && section('PROGRESS', NEON.cyan, (
          <Box flexDirection="column">
            <Text><Text color={NEON.cyan}>{bar(done, s.todos.length, Math.min(24, cols - 14))}</Text> {done}/{s.todos.length}</Text>
            {doing && <Text color={NEON.lime} wrap="truncate-end">▸ {doing.text}</Text>}
          </Box>
        ))}
        <Text wrap="truncate-end">
          <Text color={NEON.dim}>✎ </Text><Text bold>{fileCount}</Text><Text color={NEON.dim}> files/{dirs.length} dirs </Text><Text color={NEON.lime}>+{adds}</Text> <Text color={NEON.red}>−{dels}</Text>
          <Text color={NEON.dim}>   ☐ </Text><Text bold color={openPending.length ? NEON.amber : undefined}>{openPending.length}</Text><Text color={NEON.dim}> todo</Text>
          <Text color={NEON.dim}>   ⚠ </Text><Text bold color={s.issues.length ? NEON.red : undefined}>{s.issues.length}</Text><Text color={NEON.dim}> issues</Text>
        </Text>
        {s.queries.length > 1 && section('RECENT', NEON.frame, (
          <Box flexDirection="column">
            {s.queries.slice(-4).reverse().map((x) => (
              <Text key={x.id} wrap="truncate-end"><Text color={NEON.dim}>{fmtWhen(x.startedAt, now)} </Text><Text color={NEON.lime}>{fmtUsd(x.status === 'running' ? s.costUsd - x.costAtStart : x.costUsd).padStart(6)}</Text> {x.prompt || '(continuation)'}</Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  }

  function agentCard(a: TrackedAgent) {
    const m = mood(a.status)
    const st = STATUS[m]
    const e = est(a)
    const live = m === 'live'
    return (
      <Box key={`card-${a.id}`} flexDirection="row" columnGap={1} borderStyle="round" borderColor={live ? NEON.lime : m === 'idle' ? NEON.cyan : NEON.frame} paddingX={1}>
        {avatar(a.id, m, `c-${a.id}`)}
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text bold color={avatarColor(a.id, m)}>{callsign(a.id)}</Text>{' '}
            <Text color={st.color}>{live ? `${spin} WORKING` : st.label}</Text>
            <Text color={NEON.dim}> {a.type}</Text>
          </Text>
          <Text wrap="truncate-end">{a.description || '(no description)'}</Text>
          <Text wrap="truncate-end">
            {progress(e, Math.max(6, Math.min(16, cols - 40)))}
            <Text bold> {e.pct === null ? '' : `${Math.round(e.pct * 100)}%`}</Text>
            <Text color={e.overtimeMs ? NEON.amber : NEON.dim}> {fmtEta(e)}</Text>
          </Text>
          {(live || m === 'idle') && <Text color={NEON.dim} wrap="truncate-end">{e.detail}</Text>}
          {live && a.lastTool && (
            <Text wrap="truncate-end">{toolEmoji(a.lastTool, a.lastToolDetail)} <Text color={NEON.dim}>{a.lastTool}{a.lastToolDetail ? ` ${a.lastToolDetail}` : ''}{a.lastToolAt ? ` · ${fmtDur(now - a.lastToolAt)} ago` : ''}</Text></Text>
          )}
          <Text color={NEON.dim} wrap="truncate-end">
            ⏱ {fmtDur(live ? now - (a.runStartedAt ?? a.startedAt) : (a.activeMs ?? ((a.endedAt ?? now) - a.startedAt)))}{(a.runs ?? 0) > 1 ? ` · ${a.runs} runs` : ''}  ⚙ {a.tools}  ◇ {fmtTokens(totalTokens(a.tokens))}{a.model ? `  ${a.model}` : ''}
          </Text>
          {a.queryId && <Text color={NEON.dim} wrap="truncate-end">for: {queryLabel(a.queryId)}</Text>}
        </Box>
      </Box>
    )
  }

  function squad() {
    const mainTools = s.queries.reduce((n, q) => n + q.tools, 0)
    // Working first, then standby, then finished; newest first within each.
    const rank = (a: TrackedAgent) => (isLive(a.status) ? 0 : a.status === 'idle' ? 1 : 2)
    const ordered = [...s.agents].reverse().sort((x, y) => rank(x) - rank(y))
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" columnGap={1} borderStyle="round" borderColor={NEON.magenta} paddingX={1}>
          {avatar(s.id, 'core', 'core-card')}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text><Text bold color={NEON.magenta}>CORE</Text> <Text color={NEON.magenta}>◆ MAIN LOOP</Text></Text>
            <Text color={NEON.dim}>{s.queries.length} queries  ⚙ {mainTools} tools  {fmtUsd(s.costUsd)}</Text>
            <Text color={NEON.dim}>{running.length} working · {standby.length} standby · {s.agents.length - running.length - standby.length} finished</Text>
          </Box>
        </Box>
        {s.agents.length === 0 && <Text color={NEON.dim}>No subagents deployed in this session yet.</Text>}
        {ordered.map(agentCard)}
        {s.todos.length > 0 && section('MISSION', NEON.cyan, (
          <Box flexDirection="column">
            {s.todos.map((x) => (
              <Text key={x.id} color={x.status === 'completed' ? NEON.dim : undefined} wrap="truncate-end">
                <Text color={x.status === 'completed' ? NEON.cyan : x.status === 'in_progress' ? NEON.lime : NEON.dim}>{x.status === 'completed' ? '◉' : x.status === 'in_progress' ? '◎' : '○'}</Text> {x.text}{x.owner ? <Text color={NEON.dim}> ({agentName(x.owner)})</Text> : null}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  }

  async function files() {
    const sel = await read($, selectedFile)
    if (sel) {
      const changes = s.files.filter((f) => f.path === sel)
      return (
        <Box flexDirection="column" gap={1}>
          <Button key="files-back" plain hotkey="b" label="◂ all files" onPress={() => update($, selectedFile, () => null)} />
          <Text bold color={NEON.cyan} wrap="truncate-end">{relPath(sel, s.cwd)}</Text>
          {changes.slice(-8).reverse().map((ch, i) => panel(`${ch.kind.toUpperCase()} +${ch.adds} −${ch.dels}`, NEON.frame, (
            <Box flexDirection="column">
              <Text color={NEON.dim} wrap="truncate-end">by {agentName(ch.agentId)}{ch.queryId ? `  for: ${queryLabel(ch.queryId)}` : ''}</Text>
              {ch.patch ? <els.Code source={ch.patch} format="diff" path={ch.path} wrap="truncate-end" /> : <Text color={NEON.dim}>(no diff kept)</Text>}
            </Box>
          ), fmtWhen(ch.at, now) + (i === 0 ? ' latest' : '')))}
          {changes.length > 8 && <Text color={NEON.dim}>{changes.length - 8} earlier changes not shown.</Text>}
        </Box>
      )
    }
    const groups = groupFiles(s.files, s.cwd)
    return (
      <Box flexDirection="column" gap={1}>
        {groups.length === 0 && <Text color={NEON.dim}>No files edited in this session yet. Edits made through Bash are not tracked.</Text>}
        {groups.map((g) => panel(`${g.dir}/`, NEON.frame, (
          <Box flexDirection="column">
            {g.files.map((f) => (
              <Button key={`f-${f.path}`} plain onPress={() => update($, selectedFile, () => f.path)}>
                {baseName(f.path)} <Text color={NEON.lime}>+{f.adds}</Text> <Text color={NEON.red}>−{f.dels}</Text>
                <Text color={NEON.dim}> {f.edits > 1 ? `×${f.edits} ` : ''}{fmtWhen(f.last, now)}</Text>
              </Button>
            ))}
          </Box>
        ), `${g.files.length} files`))}
      </Box>
    )
  }

  function todo() {
    const done = pend.filter((p) => p.status === 'done').slice(-10).reverse()
    const tagColor = (k: string) => (k === 'config' ? NEON.amber : k === 'action' ? NEON.magenta : NEON.cyan)
    return (
      <Box flexDirection="column" gap={1}>
        {openPending.length === 0 && <Text color={NEON.dim}>Nothing pending. Claude adds items here when something needs your action or is left undone.</Text>}
        {openPending.map((p) => (
          <Box key={p.id} flexDirection="column" borderStyle="round" borderColor={tagColor(p.kind)} paddingX={1}>
            <Text wrap="wrap"><Text bold color={tagColor(p.kind)}>[{p.kind}]</Text> {p.text}</Text>
            <Box flexDirection="row" justifyContent="space-between">
              <Text color={NEON.dim}>{fmtWhen(p.createdAt, now)}{p.sessionId !== s.id ? '  earlier session' : ''}</Text>
              <Button key={`done-${p.id}`} plain label="✓ mark done" onPress={async () => {
                const at = await $.clock.now()
                await update($, pending, (l) => l.map((x) => (x.id === p.id ? { ...x, status: 'done' as const, doneAt: at } : x)))
                c.save()
              }} />
            </Box>
          </Box>
        ))}
        {done.length > 0 && panel('CLEARED', NEON.frame, (
          <Box flexDirection="column">
            {done.map((p) => <Text key={p.id} color={NEON.dim} strikethrough wrap="truncate-end">{p.text}</Text>)}
          </Box>
        ))}
      </Box>
    )
  }

  function issues() {
    const label: Record<Issue['kind'], string> = { 'tool-error': 'TOOL ERROR', denied: 'DENIED', 'turn-error': 'TURN FAILED', aborted: 'INTERRUPTED', reported: 'DIFFICULTY' }
    return (
      <Box flexDirection="column" gap={1}>
        {s.issues.length === 0 && <Text color={NEON.dim}>No difficulties recorded yet.</Text>}
        {[...s.issues].reverse().slice(0, 60).map((x, i) => (
          <Box key={`is-${x.at}-${i}`} flexDirection="column" borderStyle="round" borderColor={x.kind === 'reported' ? NEON.amber : NEON.red} paddingX={1}>
            <Text wrap="truncate-end"><Text bold color={x.kind === 'reported' ? NEON.amber : NEON.red}>{label[x.kind]}</Text>{x.tool ? <Text color={NEON.dim}> {x.tool}</Text> : null}<Text color={NEON.dim}>  {fmtWhen(x.at, now)}  {agentName(x.agentId)}</Text></Text>
            <Text wrap="wrap">{x.text}</Text>
          </Box>
        ))}
      </Box>
    )
  }

  async function log() {
    const hist = await read($, history)
    const pick = await read($, historyPick)
    const detail = await read($, historyDetail)
    if (pick && detail && detail.id === pick) {
      const groups = groupFiles(detail.files, detail.cwd)
      return (
        <Box flexDirection="column" gap={1}>
          <Button key="hist-back" plain hotkey="b" label="◂ all sessions" onPress={() => update($, historyPick, () => null)} />
          {panel(oneLine(detail.title || '(untitled)', Math.max(10, cols - 8)), NEON.cyan, (
            <Box flexDirection="column">
              <Text color={NEON.dim} wrap="truncate-end">{fmtWhen(detail.startedAt, now)}  {detail.cwd}</Text>
              <Text><Text color={NEON.lime} bold>{fmtUsd(detail.costUsd)}</Text><Text color={NEON.dim}>  {fmtTokens(totalTokens(detail.tokens))} tok  {detail.queries.length} queries  {detail.agents.length} agents</Text></Text>
            </Box>
          ))}
          {panel('QUERIES', NEON.frame, (
            <Box flexDirection="column">
              {detail.queries.slice(-12).map((q) => <Text key={q.id} wrap="truncate-end"><Text color={NEON.lime}>{fmtUsd(q.costUsd).padStart(6)}</Text> {q.prompt || '(continuation)'}</Text>)}
            </Box>
          ))}
          {panel('FILES', NEON.frame, (
            <Box flexDirection="column">
              {groups.length === 0 && <Text color={NEON.dim}>None.</Text>}
              {groups.map((g) => (
                <Box key={g.dir} flexDirection="column">
                  <Text bold>{g.dir}/</Text>
                  {g.files.map((f) => <Text key={f.path}>  {baseName(f.path)} <Text color={NEON.lime}>+{f.adds}</Text> <Text color={NEON.red}>−{f.dels}</Text></Text>)}
                </Box>
              ))}
            </Box>
          ))}
          {detail.issues.length > 0 && panel('ISSUES', NEON.red, (
            <Box flexDirection="column">
              {detail.issues.slice(-15).map((x, i) => <Text key={String(i)} wrap="truncate-end"><Text color={NEON.red}>•</Text> {x.text}</Text>)}
            </Box>
          ))}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {hist.length === 0 && <Text color={NEON.dim}>Sessions appear here once they have been saved.</Text>}
        {hist.map((h) => (
          <Button key={`h-${h.id}`} plain onPress={async () => {
            const rec = h.id === s.id ? s : ((await $.store.get(`session:${h.id}`)) as SessionRecord | undefined)
            await update($, historyDetail, () => rec ?? null)
            await update($, historyPick, () => (rec ? h.id : null))
          }}>
            <Text color={NEON.dim}>{fmtWhen(h.startedAt, now)}</Text> {oneLine(h.title || '(untitled)', Math.max(10, cols - 34))}
            <Text color={NEON.lime}> {fmtUsd(h.costUsd)}</Text><Text color={NEON.dim}> {h.files}f {h.issues}!{h.id === s.id ? ' ◂ now' : ''}</Text>
          </Button>
        ))}
      </Box>
    )
  }
}
