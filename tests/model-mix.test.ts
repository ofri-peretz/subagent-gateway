import { expect, test } from 'claude-code/testing'

import { runOf, summarize } from '../scripts/model-mix-core.mjs'

const line = (o: object) => JSON.stringify(o)

test('a run takes the model its requests actually used, and sums their tokens', async () => {
  const lines = [
    line({ type: 'user', timestamp: '2026-11-25T10:00:00Z' }),
    line({ type: 'assistant', message: { model: '<synthetic>', content: [] } }),
    line({
      type: 'assistant',
      message: {
        model: 'claude-haiku-5-5',
        usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 },
        content: [{ type: 'text', text: 'Found it at src/a.ts:3.' }],
      },
    }),
  ]
  expect(runOf({ agentType: 'subagent-gateway:repo-searcher', finished: true }, lines)).toEqual({
    day: '2026-11-25',
    type: 'subagent-gateway:repo-searcher',
    model: 'haiku',
    tokens: 162,
    empty: false,
  })
})

test('a meta with no transcript is not counted as a run', async () => {
  expect(runOf({ agentType: 'general-purpose', model: 'claude-sonnet-5-5' }, [])).toBe(null)
})

test('a finished run whose answer says it could not do the work is empty', async () => {
  const lines = [
    line({ type: 'user', timestamp: '2026-11-25T10:00:00Z' }),
    line({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'I could not get the logs: the run is still in progress.' }] } }),
  ]
  expect(runOf({ agentType: 'subagent-gateway:log-reader', finished: true }, lines)?.empty).toBe(true)
})

test('the summary gives the Haiku share and totals by model and agent type', async () => {
  const r = (model: string, type: string, empty = false) => ({ day: '2026-11-25', type, model, tokens: 10, empty })
  const s = summarize([r('haiku', 'Explore'), r('sonnet', 'general-purpose'), r('sonnet', 'general-purpose', true), r('haiku', 'Explore')])
  expect(s.total).toBe(4)
  expect(s.haikuShare).toBe(0.5)
  expect(s.byModel.sonnet).toEqual({ runs: 2, tokens: 20, empty: 1 })
  expect(s.byType['general-purpose → sonnet']).toEqual({ runs: 2, empty: 1 })
  expect(s.byDay['2026-11-25']).toEqual({ haiku: 2, sonnet: 2 })
})
