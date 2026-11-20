import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T21:46:00Z')

const PANE = {
  plugin: 'subagent-gateway',
  component: 'Pane',
  requestId: 'subagent-gateway',
  props: { title: 'Savings', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const band = (surface: string) =>
  ({ plugin: 'subagent-gateway', component: 'AbovePrompt', surface, props: { hasSurvey: false, isWorking: true, maxRows: 6 }, viewport: { columns: 140, rows: 40 } }) as any

const spawn = (subagentType: string, extra: Record<string, unknown> = {}) =>
  ({
    prompt: 'look',
    description: 'look',
    subagentType,
    provider: { plugin: 'engine' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...extra,
  }) as any

const done = (agentId: string | undefined, usage?: Record<string, unknown>) =>
  ({
    answer: 'x'.repeat(4_000),
    durationMs: 1,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    ...(agentId ? { agentId } : {}),
    ...(usage ? { usage: { output_tokens: 10, cache_read_input_tokens: 0, model: 'claude-haiku-5-5', ...usage } } : {}),
  }) as any

// Stands in for the engine beneath the plugin: each spawn starts a new agent id.
const engine = (on: any) => {
  let next = 0
  let now = NOW
  on('clock.now', () => ({ value: now }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? (e.subagentType.startsWith('subagent-gateway:') ? 'claude-haiku-5-5' : e.parentModel), agentId: `a${++next}` }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  return { advance: (ms: number) => (now += ms) }
}

test('a running worker shows in the band and the pane, and leaves both when it finishes', async ($, on) => {
  const clock = engine(on)
  const started = await $.agent.spawn(spawn('subagent-gateway:log-reader', { model: 'haiku' }))
  await $.agent.spawn(spawn('Explore'))
  clock.advance(42_000)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const top = await $.ui.mount(band(surface))
    expect((await top.find({ type: 'Text', text: /⬡/ }))?.text).toBe(' ⬡ Explore ▲ 42s +1 ')
    await top.unmount()
    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /^Running now/ }))?.text).toBe('Running now · 2')
    expect(await pane.find({ type: 'Text', text: /^log-reader$/ })).toBeTruthy()
    await pane.unmount()
  }

  await $.turn.complete(done(started.agentId, { input_tokens: 1_000, cache_creation_input_tokens: 39_000 }))
  await $.turn.complete(done('a2', { input_tokens: 0, cache_creation_input_tokens: 0 }))
  const top = await $.ui.mount(band('desktop'))
  expect(await top.find({ type: 'Text', text: /⬡/ })).toBeFalsy()
  await top.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^Running now/ })).toBeFalsy()
  await pane.unmount()
})

test('Explore is routed to Haiku, and a model named by the call is left alone', async ($, on) => {
  engine(on)
  expect((await $.agent.spawn(spawn('Explore'))).model).toBe('haiku')
  expect((await $.agent.spawn(spawn('general-purpose'))).model).toBe('sonnet')
  expect((await $.agent.spawn(spawn('Explore', { model: 'opus' }))).model).toBe('opus')
})

test('a worker cannot write, push or send, and other agents are not checked', async ($, on) => {
  engine(on)
  const worker = await $.agent.spawn(spawn('subagent-gateway:diff-reader'))
  const other = await $.agent.spawn(spawn('general-purpose'))

  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD', agentId: worker.agentId } as any)).deny).toContain('read-only')
  expect((await $.tool.call({ tool: 'Bash', command: 'git diff master', agentId: worker.agentId } as any)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD', agentId: other.agentId } as any)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as any)).deny).toBeUndefined()
})

test('a finished worker adds its kept-out tokens to the prompt, today and the top savers', async ($, on) => {
  const clock = engine(on)
  const first = await $.agent.spawn(spawn('subagent-gateway:log-reader'))
  clock.advance(10_000)
  await $.turn.complete(done(first.agentId, { input_tokens: 1_000, cache_creation_input_tokens: 39_000 }))
  await $.turn.complete(done(undefined))

  const top = await $.ui.mount(band('terminal'))
  expect((await top.find({ type: 'Text', text: /^today/ }))?.text).toBe('today 39K saved · ≈2s')
  await top.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^log-reader$/ })).toBeTruthy()
  expect((await pane.find({ type: 'Text', text: /^39K · 100%$/ }))?.text).toBe('39K · 100%')
  await pane.unmount()
})

test('a fork does not count as a saving', async ($, on) => {
  engine(on)
  const fork = await $.agent.spawn(spawn('general-purpose', { fork: true }))
  await $.turn.complete(done(fork.agentId, { input_tokens: 0, cache_creation_input_tokens: 90_000 }))
  await $.turn.complete(done(undefined))

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^Nothing saved yet/ }))?.text).toContain('Nothing saved yet')
  await pane.unmount()
})

test('/gateway off hides the workers and stops routing', async ($, on) => {
  engine(on)
  on('command.register', () => ({ value: { command: 'gateway' } }))
  expect((await $.command.run({ command: 'gateway', args: 'off' } as any)).text).toBe('Workers and subagent routing off.')
  expect((await $.agent.spawn(spawn('Explore'))).model).toBe('claude-opus-5-5')
  const top = await $.ui.mount(band('desktop'))
  expect(await top.find({ type: 'Text', text: /^workers off$/ })).toBeTruthy()
  await top.unmount()
})

const step = async ($: any, model = 'claude-opus-5-5') => {
  const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1 })
  for await (const _ of stream) {
  }
  await stream.result
}

test('an o/s/h prefix applies to its own prompt only, never to later turns', async ($, on) => {
  engine(on)
  const models: string[] = []
  const texts: string[] = []
  on('turn.step', async function* (_: unknown, e: any) {
    models.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any
  })
  on('prompt.submit', (_: unknown, e: any) => {
    texts.push(e.text)
    return { text: e.text }
  })

  await $.prompt.submit({ text: 'h list the smoke specs' } as any)
  await step($)
  await $.turn.complete(done(undefined))
  await step($)
  await $.prompt.submit({ text: 's where is it' } as any)
  await $.prompt.submit({ text: '/review', command: 'review' } as any)
  await step($)

  expect(texts[0]).toBe('list the smoke specs')
  expect(models).toEqual(['haiku', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('a routed subagent runs at the effort its route chose', async ($, on) => {
  engine(on)
  const efforts: unknown[] = []
  on('turn.step', async function* (_: unknown, e: any) {
    efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any
  })
  const explore = await $.agent.spawn(spawn('Explore'))
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 1, agentId: explore.agentId } as any)
  for await (const _ of stream) {
  }
  expect(efforts).toEqual(['medium'])
})
