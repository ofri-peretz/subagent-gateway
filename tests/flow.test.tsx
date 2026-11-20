import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T21:46:00Z')

const AGENTS = (surface: string) =>
  ({
    plugin: 'subagent-gateway',
    component: 'Pane',
    requestId: 'subagent-gateway-agents',
    surface,
    props: { title: 'Agents', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as any

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
  const listed: any[] = []
  on('clock.now', () => ({ value: now }))
  on('agent.list', () => ({ value: listed.map(one => ({ ...one })) }))
  on('agent.spawn', (_: unknown, e: any) => {
    const agentId = `a${++next}`
    listed.push({ id: agentId, type: e.subagentType, description: e.description, status: 'running', ...(e.parentAgentId ? { parentId: e.parentAgentId } : {}) })
    return { model: e.model ?? (e.subagentType.startsWith('subagent-gateway:') ? 'claude-haiku-5-5' : e.parentModel), agentId }
  })
  on('turn.complete', (_: unknown, e: any) => {
    const one = listed.find(agent => agent.id === e.agentId)
    if (one) one.status = 'completed'
    return { text: '' }
  })
  on('tool.call', () => ({ result: {} }))
  let stored: unknown
  on('store.get', () => ({ value: stored }))
  on('store.set', (_: unknown, e: any) => {
    stored = e.value
    return { value: undefined }
  })
  const opened: string[] = []
  on('ui.open', (_: unknown, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })

  return { advance: (ms: number) => (now += ms), opened, store: { get: () => stored, set: (value: unknown) => (stored = value) } }
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
    const pane = await $.ui.mount(AGENTS(surface))
    expect((await pane.find({ type: 'Text', text: /running ·/ }))?.text).toBe('2 running · 0 idle or done')
    expect(await pane.find({ type: 'Text', text: /^log-reader$/ })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /^Explore$/ })).toBeTruthy()
    await pane.unmount()
  }

  await $.turn.complete(done(started.agentId, { input_tokens: 1_000, cache_creation_input_tokens: 39_000 }))
  await $.turn.complete(done('a2', { input_tokens: 0, cache_creation_input_tokens: 0 }))
  const top = await $.ui.mount(band('desktop'))
  expect(await top.find({ type: 'Text', text: /⬡/ })).toBeFalsy()
  await top.unmount()
  const pane = await $.ui.mount(AGENTS('desktop'))
  expect((await pane.find({ type: 'Text', text: /running ·/ }))?.text).toBe('0 running · 2 idle or done')
  expect((await pane.find({ type: 'Text', text: /✓/ }))?.text).toBe('▲ log-reader · ✓ · 42s')
  await pane.unmount()
})

test('the agents view nests sub-agents under the agent that started them', async ($, on) => {
  engine(on)
  const parent = await $.agent.spawn(spawn('general-purpose', { description: 'fix the flaky test' }))
  await $.agent.spawn(spawn('Explore', { description: 'find the spec', parentAgentId: parent.agentId }))
  await $.agent.spawn(spawn('subagent-gateway:log-reader', { description: 'read the CI log' }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const pane = await $.ui.mount(AGENTS(surface))
    expect((await pane.find({ type: 'Text', text: /running ·/ }))?.text).toBe('3 running · 0 idle or done')
    expect(await pane.find({ type: 'Text', text: /^└ $/ })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /^  find the spec$/ })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /^fix the flaky test$/ })).toBeTruthy()
    await pane.unmount()
  }
})

test('the running chip opens the agents view', async ($, on) => {
  const { opened } = engine(on)
  await $.agent.spawn(spawn('Explore'))
  const top = await $.ui.mount(band('desktop'))
  await top.press({ key: 'agents' })
  expect(opened).toEqual(['subagent-gateway-agents'])
  await top.unmount()
})

test('an empty agents view says so', async ($, on) => {
  engine(on)
  const pane = await $.ui.mount(AGENTS('desktop'))
  expect((await pane.find({ type: 'Text', text: /agents/ }))?.text).toBe('No agents in this session yet.')
  await pane.unmount()
})

test('Explore is routed to Haiku, and a model named by the call is left alone', async ($, on) => {
  engine(on)
  expect((await $.agent.spawn(spawn('Explore'))).model).toBe('haiku')
  expect((await $.agent.spawn(spawn('general-purpose', { prompt: 'fix it', description: 'fix it' }))).model).toBe('sonnet')
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

test('a worker counts for the gateway, a built-in agent only for all subagents', async ($, on) => {
  const clock = engine(on)
  const worker = await $.agent.spawn(spawn('subagent-gateway:log-reader'))
  const builtin = await $.agent.spawn(spawn('general-purpose', { prompt: 'fix the flaky test' }))
  clock.advance(10_000)
  await $.turn.complete(done(worker.agentId, { input_tokens: 1_000, cache_creation_input_tokens: 39_000 }))
  await $.turn.complete(done(builtin.agentId, { input_tokens: 0, cache_creation_input_tokens: 101_000, cache_read_input_tokens: 5_000_000 }))
  await $.turn.complete(done(undefined))

  const top = await $.ui.mount(band('terminal'))
  expect((await top.find({ type: 'Text', text: /^today/ }))?.text).toBe('today 39K by gateway · 139K by all subagents')
  await top.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^log-reader · gateway$/ })).toBeTruthy()
  expect((await pane.find({ type: 'Text', text: /^39K · 28%$/ }))?.text).toBe('39K · 28%')
  await pane.unmount()
  const [day] = clock.store.get() as any[]
  expect(day.moved).toBe(101_010)
  expect([day.workerRuns, day.builtinRuns, day.parallelMs]).toEqual([1, 1, 10_000])
})

test('a continued agent counts as one run', async ($, on) => {
  const clock = engine(on)
  const builtin = await $.agent.spawn(spawn('general-purpose', { prompt: 'fix the flaky test' }))
  await $.turn.complete(done(builtin.agentId, { input_tokens: 0, cache_creation_input_tokens: 50_000 }))
  await $.turn.complete(done(builtin.agentId, { input_tokens: 0, cache_creation_input_tokens: 50_000 }))
  await $.turn.complete(done(undefined))
  const [day] = clock.store.get() as any[]
  expect(day.builtinRuns).toBe(1)
})

test('an agent\'s starting context is not counted as kept out', async ($, on) => {
  const clock = engine(on)
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 5_000, cache_creation_input_tokens: 25_000, cache_read_input_tokens: 0, output_tokens: 0, model: 'claude-haiku-5-5' } } as any
  })
  const worker = await $.agent.spawn(spawn('subagent-gateway:repo-searcher'))
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 1, agentId: worker.agentId } as any)
  for await (const _ of stream) {
  }
  await $.turn.complete(done(worker.agentId, { input_tokens: 5_000, cache_creation_input_tokens: 66_000 }))
  await $.turn.complete(done(undefined))

  expect((clock.store.get() as any[])[0].gateway).toBe(40_000)
})

test('five reads in a row in the main conversation count as a missed hand-off, once, with one tip', async ($, on) => {
  const clock = engine(on)
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  for (let i = 0; i < 7; i++) await $.tool.call({ tool: 'Read', file_path: `/f${i}` } as any)
  await $.tool.call({ tool: 'Edit' } as any)
  for (let i = 0; i < 5; i++) await $.tool.call({ tool: 'Grep', pattern: 'x' } as any)
  await $.turn.complete(done(undefined))

  expect((clock.store.get() as any[])[0].missed).toBe(2)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('repo-searcher')
})

test('the hand-off rule rides beside each prompt, and stays out when the gateway is off', async ($, on) => {
  engine(on)
  const contexts: unknown[] = []
  on('prompt.submit', (_: unknown, e: any) => {
    contexts.push(e.context)
    return { text: e.text }
  })
  on('command.register', () => ({ value: { command: 'gateway' } }))
  await $.prompt.submit({ text: 'where is the spec' } as any)
  await $.command.run({ command: 'gateway', args: 'off' } as any)
  await $.prompt.submit({ text: 'where is the spec' } as any)
  expect((contexts[0] as string[])[0]).toContain('repo-searcher')
  expect(contexts[1]).toBeUndefined()
})

test('a look-only general-purpose task runs on Haiku', async ($, on) => {
  engine(on)
  expect((await $.agent.spawn(spawn('general-purpose', { prompt: 'Find where the checkout total is computed' }))).model).toBe('haiku')
  expect((await $.agent.spawn(spawn('general-purpose', { prompt: 'Fix the checkout total' }))).model).toBe('sonnet')
})

test('a fork does not count as a saving', async ($, on) => {
  engine(on)
  const fork = await $.agent.spawn(spawn('general-purpose', { fork: true }))
  await $.turn.complete(done(fork.agentId, { input_tokens: 0, cache_creation_input_tokens: 90_000 }))
  await $.turn.complete(done(undefined))

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^Nothing yet/ }))?.text).toContain('Nothing yet')
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

test('savings add to what other sessions stored, not only this session', async ($, on) => {
  const clock = engine(on)
  const today = new Date(NOW)
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const zero = { gateway: 0, subagents: 0, moved: 0, parallelMs: 0, workerRuns: 0, builtinRuns: 0, missed: 0 }
  clock.store.set([{ date, ...zero, subagents: 50_000, builtinRuns: 1, byAgent: { Explore: 50_000 } }])
  const worker = await $.agent.spawn(spawn('subagent-gateway:log-reader'))
  clock.advance(1_000)
  await $.turn.complete(done(worker.agentId, { input_tokens: 0, cache_creation_input_tokens: 11_000 }))
  await $.turn.complete(done(undefined))

  expect(clock.store.get()).toEqual([{ date, ...zero, gateway: 10_000, subagents: 60_000, workerRuns: 1, builtinRuns: 1, byAgent: { Explore: 50_000, 'log-reader': 10_000 } }])
})
