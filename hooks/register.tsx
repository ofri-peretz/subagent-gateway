import { atom, read, update } from 'claude-code'
import type { Color, ElementTable, EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { Activity, Day, Entry, LimitStart, LiveAgent, SpawnedAgent, Tally, Usage } from '../types'
import {
  FAN_OUT_AT,
  HEAVY_AT,
  isCheck,
  isHeavy,
  isPolling,
  MISSED_TOKENS,
  normalizeDay,
  resultTokens,
  workerFor,
  baseName,
  clashesWith,
  MAIN,
  toolLabel,
  WRITE_TOOLS,
  COMPACT_AT,
  HANDOFF_RULE,
  MISSED_AT,
  NO_TALLY,
  SWITCH_WARN_AT,
  WORKERS,
  addTally,
  addToDays,
  checkWorkerCall,
  dateOf,
  durationText,
  isEmptyTally,
  isReadCall,
  isWorker,
  keptOut,
  lastDates,
  modelLabel,
  parallelTime,
  parsePrefix,
  routeAgent,
  runsOutAt,
  sparkline,
  sumDays,
  tokenText,
  tokensRun,
} from './rules'

const PANE = 'subagent-gateway'
const AGENTS_PANE = 'subagent-gateway-agents'
// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const entries = atom({ plugin: 'subagent-gateway', key: 'entries' } as const, [] as Entry[], { shape: 'entries-2' })
// Turns subagent routing and the workers off; the main conversation is never routed.
const isOff = atom({ plugin: 'subagent-gateway', key: 'isOff' } as const, false)
const usage = atom({ plugin: 'subagent-gateway', key: 'usage' } as const, null as Usage | null, { shape: 'usage-1' })
const agents = atom({ plugin: 'subagent-gateway', key: 'agents' } as const, {} as Record<string, SpawnedAgent>, { shape: 'agents-2' })
const isCompacting = atom({ plugin: 'subagent-gateway', key: 'isCompacting' } as const, false)
const days = atom({ plugin: 'subagent-gateway', key: 'days' } as const, [] as Day[], { shape: 'days-2' })
// Every agent the engine lists now, as of the last refresh: subagents, nested ones and teammates.
const live = atom({ plugin: 'subagent-gateway', key: 'live' } as const, [] as LiveAgent[], { shape: 'live-1' })
const activity = atom({ plugin: 'subagent-gateway', key: 'activity' } as const, {} as Record<string, Activity>, { shape: 'activity-1' })
const agentFilter = atom({ plugin: 'subagent-gateway', key: 'agentFilter' } as const, '')
const limitStarts = atom({ plugin: 'subagent-gateway', key: 'limitStarts' } as const, {} as Record<string, LimitStart>, { shape: 'limit-starts-1' })
// The store key that keeps `days` between sessions. days-1 held the 0.5 counting,
// which credited every subagent to the gateway, so 0.6 starts a new history.
const DAYS_KEY = 'days-2'
// How often the agents view refreshes while any agent is still going.
const REFRESH_MS = 2000

const LIMIT_LABELS: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' }
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'Week', spend_limit: 'Spend' }

const levelColor = (percent: number): Color => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success')

// "2h 14m", "3d 4h" or "<1m" until a time.
function untilText(at: number, now: number) {
  if (Number.isNaN(at)) return null
  const minutes = Math.max(0, Math.round((at - now) / 60000))
  if (minutes < 1) return '<1m'
  const daysLeft = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  return daysLeft > 0 ? `${daysLeft}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)

// Theme keys, so each model keeps its colour in light and dark themes.
const MODEL_COLORS: Record<string, Color> = { Opus: 'claude', Sonnet: 'suggestion', Haiku: 'success', Fable: 'merged' }
const ICONS: Record<string, string> = { Opus: '◆', Sonnet: '●', Haiku: '▲', Fable: '★' }
const colorOf = (model: string): Color => MODEL_COLORS[modelLabel(model)] ?? 'subtle'
const iconOf = (model: string) => ICONS[modelLabel(model)] ?? '○'

// An agent type without the mod's own prefix: "subagent-gateway:log-reader" reads "log-reader".
const agentName = (type: string) => type.replace(/^subagent-gateway:/, '')

// Statuses of an agent still at work, and of one that ended.
const BUSY = new Set(['pending', 'running', 'waiting'])
const ENDED = new Set(['completed', 'failed', 'killed'])
const busyOf = (agents: readonly LiveAgent[]) => agents.filter(one => BUSY.has(one.status))

const STATUS_COLORS: Record<string, Color> = { running: 'success', pending: 'warning', waiting: 'warning', idle: 'subtle', completed: 'subtle', failed: 'error', killed: 'error' }
const STATUS_MARKS: Record<string, string> = { completed: '✓', failed: '✗', killed: '✗' }

/** The agents as a tree, depth first: each one after its parent, children oldest first. */
function treeOf(agents: readonly LiveAgent[]): { agent: LiveAgent; depth: number }[] {
  const ids = new Set(agents.map(one => one.id))
  const children = new Map<string | null, LiveAgent[]>()
  for (const one of agents) {
    const parent = one.parentId !== null && ids.has(one.parentId) ? one.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), one])
  }
  const walk = (parent: string | null, depth: number): { agent: LiveAgent; depth: number }[] =>
    [...(children.get(parent) ?? [])]
      .sort((a, b) => a.since - b.since)
      .flatMap(agent => [{ agent, depth }, ...walk(agent.id, depth + 1)])

  return walk(null, 0)
}

// The band's compact button: the same compaction /compact runs, between turns only.
async function compactNow($: EngineInterface) {
  if (await read($, isCompacting)) return
  await update($, isCompacting, () => true)
  try {
    const result = await $.session.compact()
    $.ui.toast(result.skip ? `Compact skipped: ${result.skip}` : 'Conversation compacted.')
  } catch {
    // The desktop app runs Claude Code as an SDK host, where compaction runs
    // inside a turn: send /compact as the person's own prompt; failing that, put
    // it in the prompt box for them to send.
    const sent = await $.prompt.submit({ text: '/compact', asUser: true }).catch(() => null)
    if (sent && !sent.drop) {
      $.ui.toast('Compacting the conversation…')
    } else {
      const filled = await $.prompt.fill({ text: '/compact' }).catch(() => null)
      $.ui.toast(
        filled?.isFilled ? '/compact is in the prompt box: press Enter to compact.' : 'This app does not let mods compact yet: type /compact to compact.',
      )
    }
  } finally {
    await update($, isCompacting, () => false)
  }
}

// A bar `percent` full, drawn in cells on the terminal and as a box elsewhere,
// where a proportional font made a row of block characters wrap.
function bar({ Box, Text }: Pick<ElementTable, 'Box' | 'Text'>, surface: RenderSurface, percent: number, color: Color, cells: number) {
  const share = Math.round(Math.max(0, Math.min(100, percent)))
  if (surface === 'terminal') {
    const filled = Math.round((share / 100) * cells)

    return (
      <Text wrap="truncate-end">
        <Text color={color}>{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(cells - filled)}</Text>
      </Text>
    )
  }

  return (
    <Box flexDirection="row" width="100%" height={1} backgroundColor="subtle">
      <Box width={`${share}%`} height={1} backgroundColor={color} />
    </Box>
  )
}

let ticker: Timer | null = null

// Takes the engine's agent list into `live`, keeping when each was first seen,
// and refreshes every REFRESH_MS while any agent is still going.
async function refresh($: EngineInterface) {
  const listed = await $.agent.list().catch(() => null)
  if (!listed) return
  const now = await $.clock.now()
  const known = await read($, agents)
  const before = new Map((await read($, live)).map(one => [one.id, one]))
  const next: LiveAgent[] = listed.map(one => ({
    id: one.id,
    parentId: one.parentId ?? null,
    type: one.type,
    label: one.name ?? one.teammateId ?? one.description,
    status: one.status,
    model: known[one.id]?.model ?? before.get(one.id)?.model ?? null,
    since: known[one.id]?.at ?? before.get(one.id)?.since ?? now,
  }))
  await update($, live, () => next)

  const isGoing = next.some(one => !ENDED.has(one.status))
  if (isGoing && !ticker) {
    try {
      ticker = $.clock.every(REFRESH_MS, () => void refresh($))
    } catch {
      ticker = null
    }
  } else if (!isGoing && ticker) {
    ticker.cancel()
    ticker = null
  }
}

const NO_ACTIVITY: Activity = { tokens: 0, context: 0, tool: null, files: {}, clashes: [] }
// Collisions already announced, so each file and pair gets one toast.
const announced = new Set<string>()

// Records an agent's (or the main conversation's) tool call; an edit to a file
// another live party edited while both ran marks a collision on both and toasts once.
async function track($: EngineInterface, id: string, tool: string, path: string | undefined, command: string | undefined) {
  const now = await $.clock.now()
  const known = await read($, agents)
  const status = new Map((await read($, live)).map(one => [one.id, one.status]))
  const isAlive = (one: string) => one === MAIN || !ENDED.has(status.get(one) ?? 'running')
  const nameOf = (one: string) => (one === MAIN ? 'the main conversation' : agentName(known[one]?.type ?? one))
  const isWrite = WRITE_TOOLS.has(tool) && path !== undefined
  let clashes: string[] = []
  await update($, activity, all => {
    const own = all[id] ?? NO_ACTIVITY
    if (isWrite) clashes = clashesWith(all, id, path, id === MAIN ? 0 : (known[id]?.at ?? 0), isAlive)
    const next: Record<string, Activity> = { ...all, [id]: { ...own, tool: toolLabel(tool, path, command), files: isWrite ? { ...own.files, [path]: now } : own.files } }
    for (const one of clashes.length > 0 ? [id, ...clashes] : []) {
      const act = next[one] ?? NO_ACTIVITY
      next[one] = { ...act, clashes: [...new Set([...act.clashes, path!])] }
    }
    return next
  })
  for (const other of clashes) {
    const key = [path, ...[id, other].sort()].join('|')
    if (announced.has(key)) continue
    announced.add(key)
    $.ui.toast(`⚠ ${baseName(path!)}: ${nameOf(id)} and ${nameOf(other)} both edited it while running. Check one did not undo the other.`)
  }
}

// Reads in a row in the main conversation, and the tips this prompt already showed.
let readStreak = 0
let tipped = new Set<string>()
// Files edited and whether any test, lint or type check ran, since the prompt.
let editCount = 0
let hasChecked = false
// Test suites and installs running right now, in any agent.
let heavyRunning = 0

// Shows a tip once per prompt.
function tip($: EngineInterface, key: string, text: string) {
  if (tipped.has(key)) return
  tipped.add(key)
  $.ui.toast(text)
}

function noteWork(tool: string, path: string | undefined, command: string | undefined) {
  if (WRITE_TOOLS.has(tool) && path !== undefined) editCount += 1
  if (command !== undefined && isCheck(command)) hasChecked = true
}

// Runs a tool call, counting it among the heavy ones while it runs.
async function runHeavy<T>($: EngineInterface, command: string | undefined, run: () => Promise<T>): Promise<T> {
  if (command === undefined || !isHeavy(command)) return run()
  heavyRunning += 1
  if (heavyRunning >= HEAVY_AT) tip($, 'heavy', `${heavyRunning} test runs or installs at once: each slows the others. Let one finish before starting the next.`)
  try {
    return await run()
  } finally {
    heavyRunning -= 1
  }
}

export const register: Register = on => {
  // The model an o/s/h prefix chose for the current prompt; cleared when its turn
  // ends, so a prefix never carries into a command, a notification or the next prompt.
  let turnModel: string | null = null
  // What the subagents of the current prompt did so far.
  let turnTally: Tally = NO_TALLY
  let turnRuns: { start: number; end: number }[] = []
  let turnByAgent: Record<string, number> = {}
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gateway',
      description: 'Gateway: `/gateway` opens savings, `/gateway agents [word]` the agents (only those matching the word), `/gateway off` or `on` toggles the workers and routing',
    })
    const stored = await $.store.get(DAYS_KEY).catch(() => undefined)
    if (Array.isArray(stored)) await update($, days, () => (stored as Day[]).map(normalizeDay))
    await refresh($)
    const now = await $.session.usage().catch(() => null)
    if (now) {
      await update($, usage, () => ({
        limits: now.rateLimits.map(one => ({ kind: one.kind, percentUsed: one.percentUsed, resetsAt: one.resetsAt ?? null })),
        contextPercent: now.context.percent ?? null,
        contextTokens: now.context.tokens ?? null,
      }))
    }

    return next(e)
  })

  // With routing off, the workers drop out of the model's list of agent types.
  for (const worker of WORKERS) {
    on('agent.offer', { agent: `subagent-gateway:${worker.name}` }, async ($, e, next) =>
      (await read($, isOff)) ? { isOffered: false } : next(e),
    )
  }

  // Workers are read-only: every call one makes passes checkWorkerCall first. In the
  // main conversation, a run of reads is work a worker could have taken: a missed hand-off.
  on('tool.call', async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : 'notebook_path' in e && typeof e.notebook_path === 'string' ? e.notebook_path : undefined

    if (e.agentId === undefined) {
      const off = await read($, isOff)
      const isRead = isReadCall(e.tool, command)
      readStreak = isRead ? readStreak + 1 : 0
      if (command !== undefined && isPolling(command)) {
        tip($, 'poll', 'Waiting with sleep: run the command in the background and let its notification say when it ends.')
      }
      noteWork(e.tool, path, command)
      await track($, MAIN, e.tool, path, command).catch(() => null)

      const result = await runHeavy($, command, () => next(e))
      // After the tool ran nothing may throw: the catch below would run it again.
      try {
        const size = 'result' in result ? resultTokens(result.result) : 0
        if (isRead && !off && (readStreak === MISSED_AT || size >= MISSED_TOKENS)) {
          turnTally = { ...turnTally, missed: turnTally.missed + 1 }
          tip(
            $,
            'missed',
            readStreak === MISSED_AT
              ? `${MISSED_AT} reads in a row here: repo-searcher could do this and keep the files out of this conversation.`
              : `That read put about ${tokenText(size)} tokens into this conversation: ${workerFor(e.tool)} could have kept it out.`,
          )
        }
      } catch {}

      return result
    }

    const id = e.agentId
    const info = (await read($, agents))[id]
    const reason = info && isWorker(info.type) ? checkWorkerCall(info.type, e.tool, command) : null
    if (reason) {
      // A worker that tried to step outside read-only is not counted as a hand-off.
      await update($, agents, all => {
        const own = all[id]
        return own ? { ...all, [id]: { ...own, isCounted: false } } : all
      })
      return { deny: reason }
    }
    noteWork(e.tool, path, command)
    await track($, id, e.tool, path, command).catch(() => null)

    return runHeavy($, command, () => next(e))
  }).catch(($, e, next) =>
    // Counting never blocks the main conversation; a worker's call fails closed.
    next.called || e.agentId === undefined ? next(e) : { deny: `${$.plugin.name}: its read-only guard failed, so the call was refused.` },
  )

  on('agent.spawn', async ($, e, next) => {
    const route =
      e.model || e.fork || e.workflow || e.resume || e.isTeammate || (await read($, isOff)) ? null : routeAgent(e.subagentType, `${e.description} ${e.prompt}`)
    const result = await next(route ? { ...e, model: route.model } : e)
    if (!result.agentId) return result

    const now = await $.clock.now()
    const worker = WORKERS.find(one => `subagent-gateway:${one.name}` === e.subagentType)
    const id = result.agentId
    // A resumed agent keeps its entry: it is the same run, routed as it was, and its new turn starts now.
    if (e.resume) {
      const known = (await read($, agents))[id]
      if (known) {
        await update($, agents, all => (all[id] ? { ...all, [id]: { ...all[id], at: now, base: null } } : all))
        await refresh($)
        return result
      }
    }
    await update($, agents, all => ({
      ...all,
      [id]: {
        type: e.subagentType,
        model: result.model ?? route?.model ?? e.parentModel,
        at: now,
        effort: route?.effort ?? worker?.effort ?? null,
        // A fork carries the whole conversation and a nested agent saves its own parent's context: neither counts.
        isCounted: !e.fork && e.parentAgentId === undefined,
        isRouted: route !== null,
        base: null,
      },
    }))
    await refresh($)
    if (e.subagentType === 'subagent-gateway:test-runner') hasChecked = true
    const running = busyOf(await read($, live)).length
    if (running >= FAN_OUT_AT) tip($, 'fan-out', `${running} agents running at once: check each one is needed, they all draw on your usage limit.`)

    return result
  }).catch((_$, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const info = (await read($, agents))[id]
      // A routed subagent runs at the effort its route chose; the spawn cannot carry it.
      const start = await $.clock.now()
      const result = yield* next(info?.effort ? { ...e, effort: info.effort } : e)
      // What the first request held is the agent's starting context, not something it kept out.
      // A continued agent starts a new turn: time it from here, not from its spawn.
      if (result.usage) {
        const used = result.usage
        await update($, activity, all => {
          const own = all[id] ?? NO_ACTIVITY
          return {
            ...all,
            [id]: {
              ...own,
              tokens: own.tokens + used.input_tokens + used.output_tokens + used.cache_creation_input_tokens,
              context: used.input_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens,
            },
          }
        })
      }
      if (e.index === 0 && info && result.usage) {
        const base = result.usage.input_tokens + result.usage.cache_creation_input_tokens
        await update($, agents, all => {
          const own = all[id]
          return own ? { ...all, [id]: { ...own, base, ...(own.hasRun ? { at: start } : {}) } } : all
        })
      }

      return result
    }

    const step = turnModel ? { ...e, model: turnModel } : e
    if (e.index === 0) {
      const entry: Entry = { at: await $.clock.now(), model: step.model, routed: turnModel !== null, saved: null }
      await update($, entries, all => [...all, entry].slice(-200))
    }

    return yield* next(step)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()

    if (e.agentId !== undefined) {
      const id = e.agentId
      const info = (await read($, agents))[id]
      if (!info) return next(e)
      if (info.isCounted) {
        const kept = keptOut(e.usage, e.answer, info.base ?? 0)
        const name = agentName(info.type)
        const worker = isWorker(info.type)
        turnTally = addTally(turnTally, {
          ...NO_TALLY,
          gateway: worker ? kept : 0,
          subagents: kept,
          moved: !worker && info.isRouted ? tokensRun(e.usage) : 0,
          workerRuns: worker && !info.hasRun ? 1 : 0,
          builtinRuns: worker || info.hasRun ? 0 : 1,
        })
        await update($, agents, all => (all[id] ? { ...all, [id]: { ...all[id], hasRun: true } } : all))
        turnRuns = [...turnRuns, { start: info.at, end: now }]
        turnByAgent = { ...turnByAgent, [name]: (turnByAgent[name] ?? 0) + kept }
      }
      const result = await next(e)
      await refresh($)

      return result
    }

    if (editCount > 0 && !hasChecked) {
      tip($, 'unchecked', `${editCount === 1 ? '1 edit' : `${editCount} edits`} and no test, lint or type check since the prompt: run them before calling it done.`)
    }
    editCount = 0
    hasChecked = false

    const tally: Tally = { ...turnTally, parallelMs: parallelTime(turnRuns) }
    const byAgent = turnByAgent
    turnModel = null
    turnTally = NO_TALLY
    turnRuns = []
    turnByAgent = {}

    if (!isEmptyTally(tally)) {
      await update($, entries, list => {
        const last = list.length - 1

        return last < 0 ? list : list.map((one, i) => (i === last ? { ...one, saved: addTally(one.saved ?? NO_TALLY, tally) } : one))
      })
      // Other sessions write the same store: merge into what it holds now, not this session's copy.
      const stored = await $.store.get(DAYS_KEY).catch(() => undefined)
      const base = Array.isArray(stored) ? (stored as Day[]).map(normalizeDay) : await read($, days)
      const updated = addToDays(base, dateOf(now), tally, byAgent)
      await update($, days, () => updated)
      await $.store.set(DAYS_KEY, updated).catch(() => null)
    }

    return next(e)
  })

  // Pushed after each turn and whenever a limit window moves a whole point.
  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const before = (await read($, usage))?.contextTokens ?? 0
    const tokens = e.context.tokens ?? 0
    await update($, usage, () => ({
      limits: e.rateLimits.map(one => ({ kind: one.kind, percentUsed: one.percentUsed, resetsAt: one.resetsAt ?? null })),
      contextPercent: e.context.percent ?? null,
      contextTokens: e.context.tokens ?? null,
    }))

    // A window's pace starts at its first reading, and again when it resets.
    await update($, limitStarts, starts =>
      Object.fromEntries(
        e.rateLimits.map(one => {
          const start = starts[one.kind]
          const isNewWindow = !start || start.resetsAt !== (one.resetsAt ?? null) || one.percentUsed < start.percent

          return [one.kind, isNewWindow ? { percent: one.percentUsed, at: now, resetsAt: one.resetsAt ?? null } : start]
        }),
      ),
    )

    if (before < COMPACT_AT && tokens >= COMPACT_AT) {
      $.ui.toast(`Context passed ${tokenText(tokens)} tokens: every reply re-reads all of it. /compact at the next natural break.`)
    }

    return next(e)
  })

  on('command.run', { command: 'gateway' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()

    if (arg === 'off' || arg === 'on') {
      await update($, isOff, () => arg === 'off')

      return { text: `Workers and subagent routing ${arg}.` }
    }

    if (arg === 'agents' || arg.startsWith('agents ')) {
      await update($, agentFilter, () => arg.slice('agents'.length).trim())
      await refresh($)
      await $.ui.open({ id: AGENTS_PANE, title: 'Agents' })

      return { text: 'Agents pane opened.' }
    }

    await $.ui.open({ id: PANE, title: 'Savings' })

    return { text: 'Savings pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    turnModel = null
    readStreak = 0
    tipped = new Set()
    if (!e.command && !e.isMeta) {
      editCount = 0
      hasChecked = false
    }
    if (e.command || e.isMeta) return next(e)

    // Only a prefix moves the main conversation off the session model.
    const picked = parsePrefix(e.text)
    turnModel = picked?.model ?? null

    const tokens = (await read($, usage))?.contextTokens ?? 0
    if (picked && tokens >= SWITCH_WARN_AT) {
      $.ui.toast(`${modelLabel(picked.model)} re-reads all ${tokenText(tokens)} tokens of this conversation. /compact first, or start a new session.`)
    }

    // The hand-off rule rides beside each prompt (about 70 tokens): a plugin that
    // composes first can stop a system-prompt section or a context block from arriving.
    const context = (await read($, isOff)) ? e.context : [...(e.context ?? []), HANDOFF_RULE]

    return next({ ...e, ...(picked ? { text: picked.text } : {}), ...(context ? { context } : {}) })
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, entries)
    const allDays = await read($, days)
    const measured = await read($, usage)
    const now = await $.clock.now()
    const busy = busyOf(await read($, live))
    if (e.props.hasSurvey || (list.length === 0 && allDays.length === 0 && !measured && busy.length === 0)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 100
    const off = await read($, isOff)
    const starts = await read($, limitStarts)
    const lastTurn = list[list.length - 1]
    const lastSaved = [...list].reverse().find(one => one.saved)?.saved ?? null
    const today = allDays.find(one => one.date === dateOf(now)) ?? null
    const newest = [...busy].sort((a, b) => a.since - b.since)[busy.length - 1]
    const acts = await read($, activity)
    const clashCount = busy.filter(one => (acts[one.id]?.clashes.length ?? 0) > 0).length
    const compacting = await read($, isCompacting)
    const contextTokens = measured?.contextTokens ?? null
    const contextColor: Color =
      contextTokens === null
        ? levelColor(measured?.contextPercent ?? 0)
        : contextTokens >= COMPACT_AT ? 'error' : contextTokens >= COMPACT_AT / 2 ? 'warning' : 'success'

    // One usage figure: a dim label, the percent in its level colour, and when it
    // runs out at this pace, or else (on a wide band) when it resets.
    const figure = (one: Usage['limits'][number]) => {
      const start = starts[one.kind]
      const out = start ? runsOutAt(start, { percent: one.percentUsed, at: now }, one.resetsAt) : null
      const reset = columns >= 110 && one.resetsAt ? untilText(Date.parse(one.resetsAt), now) : null

      return (
        <Text key={one.kind} wrap="truncate-end">
          <Text dimColor>{`${SHORT[one.kind] ?? one.kind} `}</Text>
          <Text bold tabular color={levelColor(one.percentUsed)}>{`${Math.round(one.percentUsed)}%`}</Text>
          {out !== null ? <Text color="warning">{` → out ${clock(out)}`}</Text> : reset && <Text dimColor>{` ↻ ${reset}`}</Text>}
        </Text>
      )
    }

    return (
      <Box
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
        gap="md"
        borderStyle={e.props.maxRows >= 3 ? 'round' : undefined}
        borderColor="subtle"
        paddingX={e.props.maxRows >= 3 ? 'sm' : undefined}
      >
        <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={1} overflow="hidden">
          {off && <Text color="warning" wrap="truncate-end">workers off</Text>}
          {lastTurn?.routed && (
            <Text backgroundColor={colorOf(lastTurn.model)} color="inverseText" bold wrap="truncate-end">
              {` ${iconOf(lastTurn.model)} ${modelLabel(lastTurn.model)} · prefix `}
            </Text>
          )}
          {newest && (
            <Button key="agents" onPress={() => void $.ui.open({ id: AGENTS_PANE, title: 'Agents' })}>
              <Text backgroundColor={newest.model ? colorOf(newest.model) : 'subtle'} color="inverseText" bold wrap="truncate-end">
                {` ⬡ ${agentName(newest.type)}${newest.model ? ` ${iconOf(newest.model)}` : ''} ${durationText(now - newest.since)}${busy.length > 1 ? ` +${busy.length - 1}` : ''}${clashCount > 0 ? ` ⚠${clashCount}` : ''} `}
              </Text>
            </Button>
          )}
          {lastSaved && lastSaved.gateway > 0 && (
            <Text wrap="truncate-end">
              <Text dimColor>prompt </Text>
              <Text bold color="success">{tokenText(lastSaved.gateway)}</Text>
            </Text>
          )}
          {today && today.subagents > 0 && columns >= 80 && (
            <Text wrap="truncate-end">
              <Text dimColor>today </Text>
              <Text bold color="success">{tokenText(today.gateway)}</Text>
              <Text dimColor>{` by gateway · ${tokenText(today.subagents)} by all subagents`}</Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="row" alignItems="center" gap="md" flexShrink={0}>
          {measured?.limits.map(figure)}
          {measured?.contextPercent != null && columns >= 70 && (
            <Button key="compact" onPress={() => compactNow($)}>
              <Text bold tabular color={contextColor} dimColor={compacting}>
                {compacting ? '⟲ Compacting…' : `⟲ Ctx ${Math.round(measured.contextPercent)}%`}
              </Text>
            </Button>
          )}
          <Button key="savings" label="Savings" onPress={() => void $.ui.open({ id: PANE, title: 'Savings' })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const off = await read($, isOff)
    const list = await read($, entries)
    const allDays = await read($, days)
    const measured = await read($, usage)
    const starts = await read($, limitStarts)
    const cells = Math.max(8, Math.min(30, (e.props.bodyColumns ?? 40) - 20))

    const recent = lastDates(now, 7)
    const byDate = new Map(allDays.map(one => [one.date, one]))
    const periods: [string, Tally][] = [
      ['Today', byDate.get(dateOf(now)) ?? NO_TALLY],
      ['Last 7 days', sumDays(allDays.filter(one => recent.includes(one.date)))],
      ['All time', sumDays(allDays)],
    ]
    const workers = new Map<string, number>()
    for (const day of allDays) {
      for (const [name, kept] of Object.entries(day.byAgent)) workers.set(name, (workers.get(name) ?? 0) + kept)
    }
    const workerNames = new Set<string>(WORKERS.map(one => one.name))
    const allKept = [...workers.values()].reduce((sum, kept) => sum + kept, 0)
    const prompts = list.filter(one => one.saved).slice(-8).reverse()

    const row = (texts: string[], key: string, isHeader = false) => (
      <Box key={key} flexDirection="row">
        {texts.map((text, i) => (
          <Box key={`${key}-${i}`} width={i === 0 ? '28%' : `${Math.floor(72 / (texts.length - 1))}%`}>
            <Text tabular bold={isHeader || i === 0} dimColor={isHeader} wrap="truncate-end">{text}</Text>
          </Box>
        ))}
      </Box>
    )
    const section = (title: string, key: string, body: JSX.Element | JSX.Element[]) => (
      <Box key={key} flexDirection="column" gap="sm" borderStyle="round" borderColor="subtle" paddingX="sm">
        <Text bold color="claude">{title}</Text>
        {body}
      </Box>
    )

    return (
      <Box flexDirection="column" gap="sm">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold size="heading" color="claude">Savings</Text>
          <Button key="toggle" label={off ? 'Turn workers on' : 'Turn workers off'} onPress={() => update($, isOff, value => !value)} />
        </Box>

        {section(
          'Tokens kept out of your main conversation',
          'totals',
          allDays.length === 0 ? (
            <Text dimColor>Nothing yet. Numbers show once a subagent finishes.</Text>
          ) : (
            <Box flexDirection="column">
              {row(['', 'By gateway', 'All subagents', 'Cheaper model'], 'head', true)}
              {periods.map(([label, one]) => row([label, tokenText(one.gateway), tokenText(one.subagents), tokenText(one.moved)], label))}
              <Text tabular color="success">{sparkline(lastDates(now, 14).map(date => byDate.get(date)?.gateway ?? 0))}</Text>
              <Text dimColor size="caption">By gateway, last 14 days</Text>
            </Box>
          ),
        )}

        {allDays.length > 0 &&
          section(
            'Hand-offs',
            'handoffs',
            <Box flexDirection="column">
              {row(['', 'Workers', 'Other agents', 'Missed'], 'hhead', true)}
              {periods.map(([label, one]) => row([label, String(one.workerRuns), String(one.builtinRuns), String(one.missed)], `h${label}`))}
              <Text dimColor size="caption">{`Missed: ${MISSED_AT}+ reads in a row in the main conversation. ≈${durationText(sumDays(allDays).parallelMs)} of agents running side by side in all.`}</Text>
            </Box>,
          )}

        {prompts.length > 0 &&
          section(
            'This session, per prompt',
            'prompts',
            <Box flexDirection="column">
              {row(['Prompt at', 'By gateway', 'All subagents'], 'phead', true)}
              {prompts.map(one => row([clock(one.at), tokenText(one.saved?.gateway ?? 0), tokenText(one.saved?.subagents ?? 0)], `p${one.at}`))}
            </Box>,
          )}

        {workers.size > 0 &&
          section(
            'Kept out per agent type',
            'workers',
            [...workers]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([name, kept]) => (
                <Box key={name} flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text>{workerNames.has(name) ? `${name} · gateway` : name}</Text>
                    <Text tabular>{`${tokenText(kept)} · ${Math.round((kept / Math.max(1, allKept)) * 100)}%`}</Text>
                  </Box>
                  {bar({ Box, Text }, e.surface, (kept / Math.max(1, allKept)) * 100, 'success', cells)}
                </Box>
              )),
          )}

        {measured &&
          measured.limits.length > 0 &&
          section(
            'Usage limits',
            'limits',
            measured.limits.map(one => {
              const start = starts[one.kind]
              const out = start ? runsOutAt(start, { percent: one.percentUsed, at: now }, one.resetsAt) : null
              const reset = one.resetsAt ? untilText(Date.parse(one.resetsAt), now) : null

              return (
                <Box key={one.kind} flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text bold>{LIMIT_LABELS[one.kind] ?? one.kind}</Text>
                    <Text bold tabular color={levelColor(one.percentUsed)}>{`${Math.round(one.percentUsed)}%`}</Text>
                  </Box>
                  {bar({ Box, Text }, e.surface, one.percentUsed, levelColor(one.percentUsed), cells)}
                  {out !== null ? (
                    <Text color="warning" size="caption">{`At this pace it runs out at ${clock(out)}`}</Text>
                  ) : (
                    reset && <Text dimColor size="caption">{`Resets in ${reset}`}</Text>
                  )}
                </Box>
              )
            }),
          )}

        <Text dimColor size="caption">
          Kept out: what a subagent read beyond its starting context, less the report it returned. By gateway counts the workers only; other subagents keep their reading out with or without the gateway, which only moves them to a cheaper model. Kept on this machine only.
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: AGENTS_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const all = await read($, live)
    const busy = busyOf(all)
    const acts = await read($, activity)
    const filter = (await read($, agentFilter)).toLowerCase()
    // Filtered, the tree goes flat: a match's parent may not match.
    const matches = (one: LiveAgent) =>
      [one.type, one.label, ...Object.keys(acts[one.id]?.files ?? {})].some(text => text.toLowerCase().includes(filter))
    const rows = filter ? all.filter(matches).map(agent => ({ agent, depth: 0 })) : treeOf(all)

    return (
      <Box flexDirection="column" gap="sm">
        <Text bold size="heading" color="claude">Agents</Text>
        <Text dimColor>
          {all.length === 0
            ? 'No agents in this session yet.'
            : filter
              ? `${rows.length} of ${all.length} agents match "${filter}" · /gateway agents shows all`
              : `${busy.length} running · ${all.length - busy.length} idle or done`}
        </Text>
        {rows.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX="sm">
            {rows.map(({ agent, depth }) => {
              const act = acts[agent.id]
              const pad = '  '.repeat(depth)
              const files = act ? Object.keys(act.files).map(baseName) : []

              return (
                <Box key={agent.id} flexDirection="column">
                  <Text wrap="truncate-end" dimColor={ENDED.has(agent.status)}>
                    <Text dimColor>{depth > 0 ? `${'  '.repeat(depth - 1)}└ ` : ''}</Text>
                    {agent.model && <Text color={colorOf(agent.model)} bold>{`${iconOf(agent.model)} `}</Text>}
                    <Text bold>{agentName(agent.type)}</Text>
                    <Text color={STATUS_COLORS[agent.status] ?? 'subtle'}>{` · ${STATUS_MARKS[agent.status] ?? agent.status}`}</Text>
                    <Text dimColor>{` · ${durationText(now - agent.since)}`}</Text>
                    {act && act.tokens > 0 && <Text dimColor>{` · ${tokenText(act.tokens)} new · ctx ${tokenText(act.context)}`}</Text>}
                  </Text>
                  <Text dimColor size="caption" wrap="truncate-end">{`${pad}${agent.label}`}</Text>
                  {act?.tool && BUSY.has(agent.status) && <Text size="caption" wrap="truncate-end">{`${pad}→ ${act.tool}`}</Text>}
                  {files.length > 0 && <Text dimColor size="caption" wrap="truncate-end">{`${pad}edited ${files.join(', ')}`}</Text>}
                  {act?.clashes.map(file => (
                    <Text key={file} color="warning" size="caption" wrap="truncate-end">{`${pad}⚠ ${baseName(file)}: another agent edited it too`}</Text>
                  ))}
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })
}
