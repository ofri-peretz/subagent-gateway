import { expect, test } from 'claude-code/testing'

import { isLookOnly, parsePrefix, resultTokens } from '../hooks/rules'

// Property tests: generated inputs try to break what each rule promises. The plugin has no
// dependencies, so the generator is a seeded PRNG (mulberry32) rather than fast-check; a fixed
// seed makes a failure reproduce, and the failing input is printed with it.
const RUNS = 500
const SEED = 0x5eed

const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzOSH0123456789 .-_/\n'
const word = (next: () => number, length = 1 + Math.floor(next() * 12)) => Array.from({ length }, () => pick(next, [...ALPHABET])).join('')
const space = (next: () => number) => pick(next, [' ', '  ', '\t', ' \n '])

const forAll = (check: (next: () => number) => void) => {
  const next = random(SEED)
  for (let run = 0; run < RUNS; run++) check(next)
}

test('a lone o, s or h then text routes that text, whole, to its model', () => {
  const models: Record<string, string> = { o: 'opus', s: 'sonnet', h: 'haiku' }
  forAll(next => {
    const letter = pick(next, ['o', 's', 'h', 'O', 'S', 'H'])
    const text = `${pick(next, ['x', 'fix', 'Find', '3'])}${word(next)}`
    const input = `${pick(next, ['', ' ', '\n'])}${letter}${space(next)}${text}`
    expect({ input, parsed: parsePrefix(input) }).toEqual({ input, parsed: { model: models[letter.toLowerCase()], text } })
  })
})

test('text whose first word is not a lone o, s or h is never routed', () => {
  forAll(next => {
    const first = pick(next, ['s3', 'oh', 'ship', 'x', 'h2o', 'S.', 'o-'])
    const input = `${first}${space(next)}${word(next)}`
    expect({ input, parsed: parsePrefix(input) }).toEqual({ input, parsed: null })
  })
})

test('a negated clause never turns a look-only task into a change', () => {
  forAll(next => {
    const look = `${pick(next, ['find', 'list', 'where is', 'summarise', 'grep for'])} ${word(next)}`
    if (!isLookOnly(look)) return
    const task = `${look}. ${pick(next, ['Do not', "Don't", 'Never', 'Must not'])} ${pick(next, ['edit', 'fix', 'write', 'delete'])} ${word(next).replaceAll('\n', ' ')}`
    expect({ task, lookOnly: isLookOnly(task) }).toEqual({ task, lookOnly: true })
  })
})

test('a result costs at least a token a 4 characters of its JSON, and nothing when absent', () => {
  expect(resultTokens(undefined)).toBe(0)
  forAll(next => {
    const result = { text: word(next, Math.floor(next() * 400)) }
    const tokens = resultTokens(result)
    expect(tokens * 4 >= JSON.stringify(result).length && (tokens - 1) * 4 < JSON.stringify(result).length).toBe(true)
  })
})
