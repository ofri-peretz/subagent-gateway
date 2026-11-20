// The routing, safety and savings rules: pure, so the tests can call them directly.

import type { Day, Saving } from '../types'

export type Effort = 'low' | 'medium' | 'high'
// effort absent: keep the session's effort.
export type Route = { model: string; effort?: Effort; rule: string }

// A one-letter prefix picks the model for that prompt alone: "o fix it" runs
// "fix it" on Opus (o, s or h). The letter must stand alone, so "s3 bucket" is untouched.
const PICKS: Record<string, string> = { o: 'opus', s: 'sonnet', h: 'haiku' }
const PREFIX = /^\s*([osh])\s+(\S[\s\S]*)$/i

export function parsePrefix(text: string): { model: string; text: string } | null {
  const found = PREFIX.exec(text)
  const model = found ? PICKS[(found[1] ?? '').toLowerCase()] : undefined

  return found && model ? { model, text: found[2] ?? '' } : null
}

// The main conversation is never routed: a new model starts with a cold prompt
// cache and re-reads the whole conversation. A subagent starts fresh, so it can
// run on a cheaper model at no such cost.
// Subagent types that get a model when the call names none. Agents whose
// definition already pins one (planner, implementer) are left alone.
const AGENT_MODELS: Record<string, string> = {
  Explore: 'haiku',
  'general-purpose': 'sonnet',
}

export function routeAgent(type: string): Route | null {
  const model = AGENT_MODELS[type]

  return model ? { model, effort: 'medium', rule: `agent type ${type}` } : null
}

// Haiku workers the mod registers. Opus delegates when a description matches
// the task, so each says plainly when to use it; edits stay with the main model.
// The tool lists alone do not make them read-only (Bash writes too):
// checkWorkerCall enforces that on every call.
export const WORKERS = [
  {
    name: 'repo-searcher',
    description:
      'Finds files, usages, definitions and specs in the repository and reports paths with line numbers. Use for any search across more than a couple of files. Read-only.',
    prompt:
      'Search the repository for what you are asked. Report each match as path:line with a one-line note. Do not edit files. Keep the report short: no file dumps.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: 'haiku',
    effort: 'low',
  },
  {
    name: 'log-reader',
    description:
      'Reads test output, CI and Cypress logs and reports each failing case: file, test name and first error line. Use after a test run or when given a log file or URL. Read-only.',
    prompt:
      'Read the logs you are given. For each failure, report the file, the test name and the first error line. Do not edit files. Keep the report short.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: 'haiku',
    effort: 'low',
  },
  {
    name: 'test-runner',
    description:
      'Runs a Cypress spec, a Postman/Newman collection or another test command and reports pass or fail, with the first error of each failure. Use whenever tests need to run and only the result matters. Never edits files.',
    prompt:
      'Run the tests you are asked to run, once, with the command you are given or the project\'s usual one. Report the totals, then each failing test with its file and first error line. Do not edit files and do not try to fix anything. Keep the report short: no full output.',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    model: 'haiku',
    effort: 'low',
  },
  {
    name: 'docs-reader',
    description:
      'Fetches a docs page, article or URL (or searches the web) and answers one question from it, quoting only what is needed. Use when an answer is in documentation or on the web. Read-only.',
    prompt:
      'Find the answer to the question you are asked in the pages you are given, or search for them. Reply with the answer, the facts it rests on and the source URL. Do not paste whole pages.',
    tools: ['WebFetch', 'WebSearch', 'Read'],
    model: 'haiku',
    effort: 'low',
  },
  {
    name: 'diff-reader',
    description:
      'Summarizes a git diff, a branch or a pull request: which files changed and what changed in each. Use to understand changes before reviewing or describing them. Read-only.',
    prompt:
      'Read the diff, branch or pull request you are pointed at (git diff, git log, gh pr diff). List each changed file with one or two lines on what changed. Do not edit files, commit or push. Keep the summary short.',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    model: 'haiku',
    effort: 'low',
  },
  {
    // No tool list: the Atlassian tools are named differently on each machine,
    // so this worker gets the parent's tools and checkWorkerCall lets through
    // only reads and the Atlassian get/search/list calls.
    name: 'ticket-reader',
    description:
      'Reads a Jira ticket or Confluence page and returns the key facts: summary, status, acceptance criteria, decisions and open questions. Use when a ticket or page needs to be read. Read-only.',
    prompt:
      'Read the Jira ticket or Confluence page you are given, with its comments, using the Atlassian tools. Report the summary, status, acceptance criteria, decisions and open questions. Do not change, comment on or transition anything.',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
    model: 'haiku',
    effort: 'low',
  },
] as const

export const isWorker = (type: string | undefined) => (type ?? '').startsWith('subagent-gateway:')

// Commands a reading worker may run. git and gh only through their read subcommands.
const READ_WORDS = new Set(['cat', 'ls', 'grep', 'rg', 'find', 'head', 'tail', 'wc', 'jq', 'sort', 'uniq', 'cut', 'tr', 'echo', 'pwd'])
const GIT_READS = new Set(['diff', 'log', 'show', 'status', 'blame', 'ls-files', 'rev-parse', 'grep', 'merge-base'])
const GH_READS = /^gh (pr (view|diff|checks|list)|run (view|list)|issue view)\b/
// Test commands test-runner may start; what they run is the project's own suite.
const TEST_RUNS = /^(npx (cypress run|newman run|vitest run|jest)|newman run|(pnpm|npm|yarn)( run)? test|pnpm (exec )?vitest run)\b/
// Chaining, redirection and substitution: each could hide a write behind a read.
const SHELL_TRICKS = /[;&<>`]|\$\(|\|\|/
const FIND_WRITES = /\s-(delete|exec|execdir|ok|fprint|fls)\b/

const isReadSegment = (segment: string) => {
  const trimmed = segment.trim()
  const [head = '', sub = ''] = trimmed.split(/\s+/)
  if (head === 'git') return GIT_READS.has(sub)
  if (head === 'gh') return GH_READS.test(trimmed)
  if (head === 'find') return !FIND_WRITES.test(trimmed)

  return READ_WORDS.has(head)
}

/**
 * Why a worker's tool call is refused, or null when it may run. Workers promise
 * to be read-only; this keeps the promise however the model words the call.
 */
export function checkWorkerCall(worker: string, tool: string, command?: string): string | null {
  const name = worker.replace(/^subagent-gateway:/, '')

  if (name === 'ticket-reader') {
    if (['Read', 'Grep', 'Glob', 'ToolSearch'].includes(tool)) return null
    const mcp = /^mcp__(.+)__([^_].*)$/.exec(tool)
    const isAtlassianRead =
      mcp !== null && /atlassian|jira|confluence/i.test(mcp[1] ?? '') && /^(get|search|list|fetch|lookup|read)/i.test(mcp[2] ?? '')

    return isAtlassianRead ? null : `ticket-reader only reads Jira and Confluence; ${tool} is not allowed.`
  }

  if (tool !== 'Bash' || command === undefined) return null

  // 2>&1 only merges output, so it may stay on a test run.
  const plain = command.replace(/\s2>&1\b/g, '').trim()
  if (SHELL_TRICKS.test(plain)) return `${name} runs one plain command: no ;, &&, ||, redirects or substitutions.`
  const [first = '', ...rest] = plain.split('|')
  const isFirstOk = (name === 'test-runner' && TEST_RUNS.test(first.trim())) || isReadSegment(first)

  return isFirstOk && rest.every(isReadSegment)
    ? null
    : `${name} is read-only: "${plain.slice(0, 60)}" is not a read${name === 'test-runner' ? ' or a test run' : ''}.`
}

// About four characters to a token: close enough for a report's size.
const tokensOf = (text: string) => Math.ceil(text.length / 4)

/**
 * Tokens a subagent took into its own context and kept out of the main one:
 * everything its requests wrote or sent uncached, less the report it handed back.
 * ponytail: counts the worker's own prompt on a cold cache, a few K too high per run.
 */
export function keptOut(
  usage: { input_tokens: number; cache_creation_input_tokens: number } | undefined,
  answer: string,
): number {
  if (!usage) return 0

  return Math.max(0, usage.input_tokens + usage.cache_creation_input_tokens - tokensOf(answer))
}

// How much faster Haiku answers than the main model on the same work.
// ponytail: one fixed estimate (a model comparison run measured 10-30%); measure per model if it matters.
export const HAIKU_SPEEDUP = 0.2

/**
 * Time the subagents of one prompt saved: what ran side by side (their summed
 * length minus the span they covered) plus Haiku's speed on the Haiku runs.
 */
export function timeSaved(runs: readonly { start: number; end: number; isHaiku: boolean }[]): number {
  const sorted = [...runs].sort((a, b) => a.start - b.start)
  let covered = 0
  let reach = -Infinity
  for (const run of sorted) {
    covered += Math.max(0, run.end - Math.max(run.start, reach))
    reach = Math.max(reach, run.end)
  }
  const summed = runs.reduce((sum, run) => sum + (run.end - run.start), 0)
  const faster = runs.reduce((sum, run) => sum + (run.isHaiku ? (run.end - run.start) * HAIKU_SPEEDUP : 0), 0)

  return Math.round(summed - covered + faster)
}

export const NO_SAVING: Saving = { kept: 0, ms: 0 }

export const addSaving = (a: Saving, b: Saving): Saving => ({ kept: a.kept + b.kept, ms: a.ms + b.ms })

// Days kept in the store, about 25 KB of JSON at most.
export const DAYS_KEPT = 365

/** Adds one prompt's saving to the day it happened on, keeping DAYS_KEPT days. */
export function addToDays(days: readonly Day[], date: string, saving: Saving, byWorker: Record<string, number>): Day[] {
  const today = days.find(one => one.date === date)
  const merged: Day = today
    ? {
        ...today,
        ...addSaving(today, saving),
        byWorker: Object.fromEntries(
          [...new Set([...Object.keys(today.byWorker), ...Object.keys(byWorker)])].map(name => [
            name,
            (today.byWorker[name] ?? 0) + (byWorker[name] ?? 0),
          ]),
        ),
      }
    : { date, ...saving, byWorker }

  return [...days.filter(one => one.date !== date), merged].sort((a, b) => a.date.localeCompare(b.date)).slice(-DAYS_KEPT)
}

export const sumDays = (days: readonly Day[]) => days.reduce<Saving>((sum, one) => addSaving(sum, one), NO_SAVING)

// The local calendar date of `at`, as the store keys days.
export function dateOf(at: number): string {
  const day = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

// The last `count` dates up to and including `at`'s, oldest first.
export const lastDates = (at: number, count: number) =>
  Array.from({ length: count }, (_, i) => dateOf(at - (count - 1 - i) * 86_400_000))

const BLOCKS = '▁▂▃▄▅▆▇█'

/** A one-line chart of `values`, the largest drawn full height and zero as a gap. */
export function sparkline(values: readonly number[]): string {
  const top = Math.max(...values, 1)

  return values.map(value => (value <= 0 ? '·' : BLOCKS[Math.min(7, Math.floor((value / top) * 7.999))])).join('')
}

/**
 * When a limit runs out at the pace since `first`, or null: too little time to
 * judge, usage not rising, or the window resets first.
 */
export function runsOutAt(
  first: { percent: number; at: number },
  now: { percent: number; at: number },
  resetsAt: string | null,
): number | null {
  const span = now.at - first.at
  const rate = (now.percent - first.percent) / span
  if (span < 10 * 60_000 || !(rate > 0)) return null
  const at = now.at + (100 - now.percent) / rate
  const reset = resetsAt ? Date.parse(resetsAt) : Infinity

  return at < reset ? at : null
}

// "180K", "1.2M", "640".
export function tokenText(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}K`

  return String(Math.round(tokens))
}

// "40s", "6m", "1.5h".
export function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)

  return minutes < 90 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`
}

// Past COMPACT_AT the band suggests /compact; past SWITCH_WARN_AT a prefix switch
// warns that the other model re-reads the whole conversation.
export const COMPACT_AT = 150_000
export const SWITCH_WARN_AT = 50_000

// A short display name for a model alias or full id.
export function modelLabel(model: string): string {
  const found = /(opus|sonnet|haiku|fable)/i.exec(model)
  const name = found?.[1]?.toLowerCase() ?? model

  return name.charAt(0).toUpperCase() + name.slice(1)
}
