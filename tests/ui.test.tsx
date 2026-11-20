import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T21:46:00Z')
const pad = (n: number) => String(n).padStart(2, '0')
const local = (at: number) => {
  const day = new Date(at)
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

const ENTRIES = [
  { at: NOW - 300_000, model: 'claude-opus-5-5', routed: false, saved: { gateway: 42000, subagents: 90000, moved: 0, parallelMs: 0, workerRuns: 0, builtinRuns: 0, missed: 0 } },
  { at: NOW - 60_000, model: 'claude-opus-5-5', routed: false, saved: null },
]

const DAYS = [
  { date: local(NOW - 86_400_000), gateway: 100_000, subagents: 100_000, moved: 0, parallelMs: 0, workerRuns: 2, builtinRuns: 0, missed: 1, byAgent: { 'repo-searcher': 100_000 } },
  { date: local(NOW), gateway: 180_000, subagents: 1_400_000, moved: 2_000_000, parallelMs: 60_000, workerRuns: 3, builtinRuns: 4, missed: 2, byAgent: { 'log-reader': 180_000, 'general-purpose': 1_220_000 } },
]

const USAGE = {
  limits: [
    { kind: 'five_hour', percentUsed: 62, resetsAt: '2099-01-01T00:00:00Z' },
    { kind: 'seven_day', percentUsed: 93, resetsAt: null },
  ],
  contextPercent: 31,
  contextTokens: 160_000,
}

const VALUES: Record<string, unknown> = {
  entries: { shape: 'entries-2', value: ENTRIES },
  usage: { shape: 'usage-1', value: USAGE },
  days: { shape: 'days-2', value: DAYS },
  limitStarts: { shape: 'limit-starts-1', value: { five_hour: { percent: 22, at: NOW - 2 * 3_600_000, resetsAt: '2099-01-01T00:00:00Z' } } },
  isOff: false,
}

const seed = (on: any, values: Record<string, unknown> = VALUES) => {
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: values[e.key], version: 1 } }))
  on('clock.now', () => ({ value: NOW }))
}

const band = (surface: string, columns: number) =>
  ({ plugin: 'subagent-gateway', component: 'AbovePrompt', surface, props: { hasSurvey: false, isWorking: false, maxRows: 6 }, viewport: { columns, rows: 40 } }) as any

const pane = (surface: string) =>
  ({
    plugin: 'subagent-gateway',
    component: 'Pane',
    requestId: 'subagent-gateway',
    surface,
    props: { title: 'Savings', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as any

test('the pane shows gateway and all-subagent totals, hand-offs, per-agent totals and limits on every surface', async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /^All time$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^280K$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^42K$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^1.5M$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^2.0M$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^log-reader · gateway$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^general-purpose$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Hand-offs$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Weekly limit/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /runs out at/ }))?.text).toMatch(/^At this pace it runs out at \d\d:\d\d$/)
    expect(await ui.find({ type: 'Text', text: /\$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /^Running now/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('an empty pane says what it is waiting for and draws no empty sections', async ($, on) => {
  seed(on, { isOff: false })
  const ui = await $.ui.mount(pane('desktop'))
  expect((await ui.find({ type: 'Text', text: /^Nothing yet/ }))?.text).toBe('Nothing yet. Numbers show once a subagent finishes.')
  expect(await ui.find({ type: 'Text', text: /^Kept out per agent type$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Hand-offs$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /per prompt/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Usage limits$/ })).toBeFalsy()
  await ui.unmount()
})

test('the band shows the gateway\'s own saving apart from all subagents, and the 5h forecast', async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(band(surface, 140))
    expect((await ui.find({ type: 'Text', text: /^prompt/ }))?.text).toBe('prompt 42K')
    expect((await ui.find({ type: 'Text', text: /^today/ }))?.text).toBe('today 180K by gateway · 1.4M by all subagents')
    expect((await ui.find({ type: 'Text', text: /^5h/ }))?.text).toMatch(/^5h 62% → out \d\d:\d\d$/)
    expect((await ui.find({ type: 'Text', text: /Ctx/ }))?.text).toBe('⟲ Ctx 31%')
    expect(await ui.find({ type: 'Text', text: /Opus/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('the band names the model only when a prefix chose it', async ($, on) => {
  seed(on, { ...VALUES, entries: { shape: 'entries-2', value: [{ at: NOW, model: 'claude-haiku-5-5', routed: true, saved: null }] } })
  const ui = await $.ui.mount(band('terminal', 140))
  expect((await ui.find({ type: 'Text', text: /prefix/ }))?.text).toBe(' ▲ Haiku · prefix ')
  await ui.unmount()
})

test('the compact button runs a compaction', async ($, on) => {
  seed(on)
  let compactions = 0
  on('state.set', () => ({ value: { isSet: true, version: 2 } }))
  on('session.compact', () => {
    compactions += 1
    return { skip: 'test' }
  })
  const ui = await $.ui.mount(band('desktop', 140))
  await ui.press({ key: 'compact' })
  expect(compactions).toBe(1)
  await ui.unmount()
})

test('a narrow band drops today and the reset times instead of crowding', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount(band('terminal', 70))
  expect(await ui.find({ type: 'Text', text: /^today/ })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /^Week/ }))?.text).toBe('Week 93%')
  await ui.unmount()
})
