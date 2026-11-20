import { atom, read, update } from 'claude-code'
import type { Color, ElementTable, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Day, Entry, LimitStart, Saving, SpawnedAgent, Usage } from '../types'
import {
  COMPACT_AT,
  NO_SAVING,
  SWITCH_WARN_AT,
  WORKERS,
  addSaving,
  addToDays,
  checkWorkerCall,
  dateOf,
  durationText,
  isWorker,
  keptOut,
  lastDates,
  modelLabel,
  parsePrefix,
  routeAgent,
  runsOutAt,
  sparkline,
  sumDays,
  timeSaved,
  tokenText,
} from './rules'

const PANE = 'subagent-gateway'
// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const entries = atom({ plugin: 'subagent-gateway', key: 'entries' } as const, [] as Entry[], { shape: 'entries-1' })
// Turns subagent routing and the workers off; the main conversation is never routed.
const isOff = atom({ plugin: 'subagent-gateway', key: 'isOff' } as const, false)
const usage = atom({ plugin: 'subagent-gateway', key: 'usage' } as const, null as Usage | null, { shape: 'usage-1' })
const agents = atom({ plugin: 'subagent-gateway', key: 'agents' } as const, {} as Record<string, SpawnedAgent>, { shape: 'agents-1' })
const isCompacting = atom({ plugin: 'subagent-gateway', key: 'isCompacting' } as const, false)
const days = atom({ plugin: 'subagent-gateway', key: 'days' } as const, [] as Day[], { shape: 'days-1' })
const limitStarts = atom({ plugin: 'subagent-gateway', key: 'limitStarts' } as const, {} as Record<string, LimitStart>, { shape: 'limit-starts-1' })
// The store key that keeps `days` between sessions.
const DAYS_KEY = 'days-1'
// A subagent not seen to finish in this long is no longer shown as running.
const RUNNING_STALE_MS = 30 * 60 * 1000

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

// Subagents started and not yet finished, oldest first.
function runningOf(all: Record<string, SpawnedAgent>, now: number) {
  return Object.entries(all)
    .filter(([, one]) => one.endedAt === null && now - one.at < RUNNING_STALE_MS)
    .map(([id, one]) => ({ id, ...one }))
    .sort((a, b) => a.at - b.at)
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

export const register: Register = on => {
  // The model an o/s/h prefix chose for the current prompt; cleared when its turn
  // ends, so a prefix never carries into a command, a notification or the next prompt.
  let turnModel: string | null = null
  // What the subagents of the current prompt saved so far.
  let turnKept = 0
  let turnRuns: { start: number; end: number; isHaiku: boolean }[] = []
  let turnByWorker: Record<string, number> = {}

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gateway',
      description: 'Gateway: `/gateway` opens the savings pane, `/gateway off` or `/gateway on` toggles the workers and subagent routing',
    })
    for (const worker of WORKERS) {
      await $.agent.register(worker).catch(() => null)
    }
    const stored = await $.store.get(DAYS_KEY).catch(() => undefined)
    if (Array.isArray(stored)) await update($, days, () => stored as Day[])
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

  // Workers are read-only: every call one makes passes checkWorkerCall first.
  on('tool.call', async ($, e, next) => {
    const info = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
    if (!info || !isWorker(info.type)) return next(e)
    const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
    const reason = checkWorkerCall(info.type, e.tool, command)

    return reason ? { deny: reason } : next(e)
  }).catch(($, _e, next) =>
    next.called ? next(_e) : { deny: `${$.plugin.name}: its read-only guard failed, so the call was refused.` },
  )

  on('agent.spawn', async ($, e, next) => {
    const route = e.model || e.fork || e.workflow || e.resume || e.isTeammate || (await read($, isOff)) ? null : routeAgent(e.subagentType)
    const result = await next(route ? { ...e, model: route.model } : e)
    if (!result.agentId) return result

    const now = await $.clock.now()
    const worker = WORKERS.find(one => `subagent-gateway:${one.name}` === e.subagentType)
    const id = result.agentId
    await update($, agents, all => ({
      ...all,
      [id]: {
        type: e.subagentType,
        model: result.model ?? route?.model ?? e.parentModel,
        at: now,
        endedAt: null,
        effort: route?.effort ?? worker?.effort ?? null,
        // A fork carries the whole conversation and a nested agent saves its own parent's context: neither counts.
        isCounted: !e.fork && e.parentAgentId === undefined,
      },
    }))

    return result
  }).catch((_$, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      // A routed subagent runs at the effort its route chose; the spawn cannot carry it.
      const effort = (await read($, agents))[e.agentId]?.effort

      return yield* next(effort ? { ...e, effort } : e)
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
      await update($, agents, all => ({ ...all, [id]: { ...info, endedAt: now } }))
      if (info.isCounted) {
        const kept = keptOut(e.usage, e.answer)
        const name = agentName(info.type)
        turnKept += kept
        turnRuns = [...turnRuns, { start: info.at, end: now, isHaiku: modelLabel(info.model) === 'Haiku' }]
        turnByWorker = { ...turnByWorker, [name]: (turnByWorker[name] ?? 0) + kept }
      }

      return next(e)
    }

    const saving: Saving = { kept: turnKept, ms: timeSaved(turnRuns) }
    const byWorker = turnByWorker
    turnModel = null
    turnKept = 0
    turnRuns = []
    turnByWorker = {}

    if (saving.kept > 0 || saving.ms > 0) {
      await update($, entries, list => {
        const last = list.length - 1

        return last < 0 ? list : list.map((one, i) => (i === last ? { ...one, saved: addSaving(one.saved ?? NO_SAVING, saving) } : one))
      })
      const updated = addToDays(await read($, days), dateOf(now), saving, byWorker)
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

    await $.ui.open({ id: PANE, title: 'Savings' })

    return { text: 'Savings pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    turnModel = null
    if (e.command || e.isMeta) return next(e)

    // Only a prefix moves the main conversation off the session model.
    const picked = parsePrefix(e.text)
    turnModel = picked?.model ?? null

    const tokens = (await read($, usage))?.contextTokens ?? 0
    if (picked && tokens >= SWITCH_WARN_AT) {
      $.ui.toast(`${modelLabel(picked.model)} re-reads all ${tokenText(tokens)} tokens of this conversation. /compact first, or start a new session.`)
    }

    return next(picked ? { ...e, text: picked.text } : e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, entries)
    const allDays = await read($, days)
    const measured = await read($, usage)
    const now = await $.clock.now()
    const live = runningOf(await read($, agents), now)
    if (e.props.hasSurvey || (list.length === 0 && allDays.length === 0 && !measured && live.length === 0)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 100
    const off = await read($, isOff)
    const starts = await read($, limitStarts)
    const lastTurn = list[list.length - 1]
    const lastSaved = [...list].reverse().find(one => one.saved)?.saved ?? null
    const today = allDays.find(one => one.date === dateOf(now)) ?? null
    const newest = live[live.length - 1]
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
            <Text backgroundColor={colorOf(newest.model)} color="inverseText" bold wrap="truncate-end">
              {` ⬡ ${agentName(newest.type)} ${iconOf(newest.model)} ${durationText(now - newest.at)}${live.length > 1 ? ` +${live.length - 1}` : ''} `}
            </Text>
          )}
          {lastSaved && lastSaved.kept > 0 && (
            <Text wrap="truncate-end">
              <Text dimColor>prompt </Text>
              <Text bold color="success">{tokenText(lastSaved.kept)}</Text>
            </Text>
          )}
          {today && today.kept > 0 && columns >= 80 && (
            <Text wrap="truncate-end">
              <Text dimColor>today </Text>
              <Text bold color="success">{tokenText(today.kept)}</Text>
              <Text dimColor>{` saved · ≈${durationText(today.ms)}`}</Text>
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
    const live = runningOf(await read($, agents), now)
    const cells = Math.max(8, Math.min(30, (e.props.bodyColumns ?? 40) - 20))

    const recent = lastDates(now, 7)
    const byDate = new Map(allDays.map(one => [one.date, one]))
    const periods: [string, Saving][] = [
      ['Today', byDate.get(dateOf(now)) ?? NO_SAVING],
      ['Last 7 days', sumDays(allDays.filter(one => recent.includes(one.date)))],
      ['All time', sumDays(allDays)],
    ]
    const workers = new Map<string, number>()
    for (const day of allDays) {
      for (const [name, kept] of Object.entries(day.byWorker)) workers.set(name, (workers.get(name) ?? 0) + kept)
    }
    const allKept = [...workers.values()].reduce((sum, kept) => sum + kept, 0)
    const prompts = list.filter(one => one.saved).slice(-8).reverse()

    const row = (texts: string[], key: string, isHeader = false) => (
      <Box key={key} flexDirection="row">
        {texts.map((text, i) => (
          <Box key={`${key}-${i}`} width={i === 0 ? '40%' : '30%'}>
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

        {live.length > 0 &&
          section(
            `Running now · ${live.length}`,
            'running',
            live.map(one => (
              <Text key={one.id} wrap="truncate-end">
                <Text color={colorOf(one.model)} bold>{`${iconOf(one.model)} ${modelLabel(one.model)} `}</Text>
                <Text>{agentName(one.type)}</Text>
                <Text dimColor>{` · ${durationText(now - one.at)}`}</Text>
              </Text>
            )),
          )}

        {section(
          'Tokens kept out of your main conversation',
          'totals',
          allDays.length === 0 ? (
            <Text dimColor>Nothing saved yet. Savings show once a subagent finishes.</Text>
          ) : (
            <Box flexDirection="column">
              {row(['', 'Kept out', '≈ Time'], 'head', true)}
              {periods.map(([label, saving]) => row([label, tokenText(saving.kept), durationText(saving.ms)], label))}
              <Text tabular color="success">{sparkline(lastDates(now, 14).map(date => byDate.get(date)?.kept ?? 0))}</Text>
              <Text dimColor size="caption">Last 14 days</Text>
            </Box>
          ),
        )}

        {prompts.length > 0 &&
          section(
            'This session, per prompt',
            'prompts',
            <Box flexDirection="column">
              {row(['Prompt at', 'Kept out', '≈ Time'], 'phead', true)}
              {prompts.map(one => row([clock(one.at), tokenText(one.saved?.kept ?? 0), durationText(one.saved?.ms ?? 0)], `p${one.at}`))}
            </Box>,
          )}

        {workers.size > 0 &&
          section(
            'Top savers',
            'workers',
            [...workers]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([name, kept]) => (
                <Box key={name} flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text>{name}</Text>
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
          Kept out: tokens subagents read, less the reports they returned. Time ≈ subagents running side by side, plus Haiku being about 20% faster. Kept on this machine only.
        </Text>
      </Box>
    )
  })
}
