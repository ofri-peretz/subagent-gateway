// The routing, safety and savings rules: pure, so the tests can call them directly.

import type { Activity, Day, Tally } from '../types'

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

// A task that only asks to look: Haiku reads as well as Sonnet and costs a fraction.
// Any word about changing something keeps it on Sonnet.
const LOOK_WORDS = /\b(find|search|where|list|locate|look up|summari[sz]e|read|which|grep|show)\b/i
const CHANGE_WORDS = /\b(edit|fix|write|implement|change|update|refactor|add|remove|delete|create|commit|push|rename|migrate|build|install|run)\b/i
// "Do not edit any file" is a look-only task: a clause after a negation is not a change asked for.
const NEGATED = /\b(do not|don't|must not|never|without|not)\b[^.\n]*/gi
export const isLookOnly = (task: string) => LOOK_WORDS.test(task) && !CHANGE_WORDS.test(task.replace(NEGATED, ''))

export function routeAgent(type: string, task = ''): Route | null {
  if (type === 'general-purpose' && isLookOnly(task)) return { model: 'haiku', effort: 'medium', rule: 'look-only task' }
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
      'Use first for any search: finding files, usages, definitions or specs across the repository, instead of reading them in the main conversation. Reports path:line with a short note. Read-only.',
    prompt:
      'Search the repository for what you are asked. Report each match as path:line with a one-line note. Do not edit files. Keep the report short: no file dumps.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: 'haiku',
    effort: 'low',
  },
  {
    name: 'log-reader',
    description:
      'Use first for any log: test output, CI or Cypress logs, a log file or URL. Reports each failing case with its file, test name and first error line. Read-only.',
    prompt:
      'Read the logs you are given. For each failure, report the file, the test name and the first error line. Do not edit files. Keep the report short.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: 'haiku',
    effort: 'low',
  },
  {
    name: 'test-runner',
    description:
      'Use first whenever tests need to run and only the result matters: Vitest, Jest, Cypress, Newman or npm test. Reports totals and the first error of each failure. Never edits files.',
    prompt:
      'Run the tests you are asked to run, once, with the command you are given or the project\'s usual one. Report the totals, then each failing test with its file and first error line. Do not edit files and do not try to fix anything. Keep the report short: no full output.',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    model: 'haiku',
    effort: 'low',
  },
  {
    name: 'docs-reader',
    description:
      'Use first when an answer is in documentation or on the web: fetches the page or searches, and answers one question with its source. Read-only.',
    prompt:
      'Find the answer to the question you are asked in the pages you are given, or search for them. Reply with the answer, the facts it rests on and the source URL. Do not paste whole pages.',
    tools: ['WebFetch', 'WebSearch', 'Read'],
    model: 'haiku',
    effort: 'low',
  },
  {
    name: 'diff-reader',
    description:
      'Use first to understand a git diff, branch or pull request before reviewing or describing it: lists each changed file and what changed. Read-only.',
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
      'Use first to read a Jira ticket or Confluence page: returns summary, status, acceptance criteria, decisions and open questions. Read-only.',
    prompt:
      'Read the Jira ticket or Confluence page you are given, with its comments, using the Atlassian tools. Report the summary, status, acceptance criteria, decisions and open questions. Do not change, comment on or transition anything.',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
    model: 'haiku',
    effort: 'low',
  },
  {
    // Like ticket-reader, it gets the parent's tools: connected tools have a name per machine.
    name: 'mcp-reader',
    description:
      'Use first to search or read mail, Slack, analytics, log services or other connected (MCP) tools: returns only what answers the question. Read-only.',
    prompt:
      'Use the connected tools you are given only to search, list, get or read. Answer the question with the few facts that matter, each with where it came from (thread, message, query). Do not send, label, edit, create or delete anything.',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
    model: 'haiku',
    effort: 'low',
  },
] as const

export const isWorker = (type: string | undefined) => (type ?? '').startsWith('subagent-gateway:')

// A connected tool's action, after an optional service prefix ("slack_read_thread"):
// only these verbs read. `exec`, `send`, `label`, `navigate`, `click` and the rest do not.
const MCP_READ = /^(?:[a-zA-Z0-9]+[_-])?(get|search|list|fetch|lookup|read|query|find|describe|count|take_snapshot|take_screenshot)(?:[_-]|[A-Z]|$)/

/** Whether a connected (MCP) tool call only reads, judged by its action's name; `server` narrows which servers count. */
export function isMcpRead(tool: string, server?: RegExp): boolean {
  const mcp = /^mcp__(.+)__([^_].*)$/.exec(tool)

  return mcp !== null && (server === undefined || server.test(mcp[1] ?? '')) && MCP_READ.test(mcp[2] ?? '')
}

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

    return isMcpRead(tool, /atlassian|jira|confluence/i) ? null : `ticket-reader only reads Jira and Confluence; ${tool} is not allowed.`
  }

  if (name === 'mcp-reader') {
    if (['Read', 'Grep', 'Glob', 'ToolSearch'].includes(tool)) return null

    return isMcpRead(tool) ? null : `mcp-reader only searches, lists, gets and reads; ${tool} is not allowed.`
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

// Steps that only set up a read: a cd, a variable, a comment, a blank line.
const SETUP = /^(cd\s|[A-Za-z_]\w*=|#|$)/

/**
 * Whether a main-conversation tool call only reads, the kind a worker could take.
 * Only counts, never allows: a chained shell command counts when every step reads.
 */
export function isReadCall(tool: string, command?: string): boolean {
  if (['Read', 'Grep', 'Glob'].includes(tool) || isMcpRead(tool)) return true
  if (tool !== 'Bash' || command === undefined || /[^2]>|`|\$\(/.test(command.replace(/2>&1|2>\/dev\/null/g, ''))) return false
  const steps = command.split(/&&|\|\||;|\||\n/).map(step => step.trim()).filter(step => !SETUP.test(step))

  return steps.length > 0 && steps.every(isReadSegment)
}

// Reads in a row in the main conversation that count as a missed hand-off.
export const MISSED_AT = 5

// One read in the main conversation this large counts as a missed hand-off too.
export const MISSED_TOKENS = 8_000

/** About how many tokens a tool's result holds. */
export const resultTokens = (result: unknown) => (result === undefined ? 0 : Math.ceil(JSON.stringify(result).length / 4))

/** The worker that should have taken a main-conversation read. */
export const workerFor = (tool: string) => (tool.startsWith('mcp__') ? (/atlassian|jira|confluence/i.test(tool) ? 'ticket-reader' : 'mcp-reader') : 'repo-searcher')

// Commands that check work: tests, lint, type checks, builds.
const CHECKS = /\b(test|vitest|jest|cypress|newman|pytest|lint|eslint|oxlint|tsc|tsrs|check-types|typecheck|go test|cargo (test|check)|build)\b/
/** Whether a shell command checks the work: a test, lint, type check or build. */
export const isCheck = (command: string) => CHECKS.test(command)

// Long-running and CPU-heavy: test suites and installs.
const HEAVY = /\b((pnpm|npm|yarn|bun)( run)? (test|install|ci|i)\b|npx (vitest|jest|cypress)|vitest run|jest\b|cypress run)/
/** Whether a shell command is heavy: a test suite or an install. */
export const isHeavy = (command: string) => HEAVY.test(command)

// A sleep loop or a fixed sleep: waiting by polling instead of by notification.
const POLL = /(^|[;&|\s])sleep\s+\d|\b(until|while)\b[^\n]*\bsleep\b/
/** Whether a shell command waits by polling. */
export const isPolling = (command: string) => POLL.test(command)

// Agents running at once past which a fan-out is worth a look, and heavy commands past which the machine slows.
export const FAN_OUT_AT = 6
export const HEAVY_AT = 3

// Added to the main conversation's system prompt while the gateway is on.
export const HANDOFF_RULE =
  'Hand reading to the subagent-gateway workers: searches to repo-searcher, logs to log-reader, test runs to test-runner, docs and the web to docs-reader, diffs and pull requests to diff-reader, Jira and Confluence to ticket-reader, mail, Slack and other connected tools to mcp-reader. Run independent ones in parallel. Read in this conversation only the files you are about to change.'

// About four characters to a token: close enough for a report's size.
const tokensOf = (text: string) => Math.ceil(text.length / 4)

/**
 * Tokens a subagent took into its own context and kept out of the main one:
 * everything its requests wrote or sent uncached, less what its first request
 * already held (system prompt, tools, its task: the main conversation has those
 * too) and less the report it handed back.
 */
export function keptOut(
  usage: { input_tokens: number; cache_creation_input_tokens: number } | undefined,
  answer: string,
  base = 0,
): number {
  if (!usage) return 0

  return Math.max(0, usage.input_tokens + usage.cache_creation_input_tokens - base - tokensOf(answer))
}

/**
 * The new tokens a run's requests took in and wrote: what moved to a cheaper model when it was routed.
 * Cache reads are left out: each request re-reads the agent's own context, which would count it hundreds of times.
 */
export const tokensRun = (usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number } | undefined) =>
  usage ? usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens : 0

/**
 * How long subagents ran side by side: the summed run times less the wall time
 * they covered. Only time in parallel, not time saved: the runs may never have
 * run one after another.
 */
export function parallelTime(runs: readonly { start: number; end: number }[]): number {
  const sorted = [...runs].sort((a, b) => a.start - b.start)
  let covered = 0
  let reach = -Infinity
  for (const run of sorted) {
    covered += Math.max(0, run.end - Math.max(run.start, reach))
    reach = Math.max(reach, run.end)
  }
  const summed = runs.reduce((sum, run) => sum + (run.end - run.start), 0)

  return Math.round(summed - covered)
}

export const NO_TALLY: Tally = { gateway: 0, subagents: 0, moved: 0, parallelMs: 0, workerRuns: 0, builtinRuns: 0, missed: 0 }

export const addTally = (a: Tally, b: Tally): Tally => ({
  gateway: a.gateway + b.gateway,
  subagents: a.subagents + b.subagents,
  moved: a.moved + b.moved,
  parallelMs: a.parallelMs + b.parallelMs,
  workerRuns: a.workerRuns + b.workerRuns,
  builtinRuns: a.builtinRuns + b.builtinRuns,
  missed: a.missed + b.missed,
})

export const isEmptyTally = (t: Tally) => Object.values(t).every(value => value === 0)

// Days kept in the store, about 25 KB of JSON at most.
export const DAYS_KEPT = 365

/** Adds one prompt's saving to the day it happened on, keeping DAYS_KEPT days. */
export function addToDays(days: readonly Day[], date: string, tally: Tally, byAgent: Record<string, number>): Day[] {
  days = days.map(normalizeDay)
  const today = days.find(one => one.date === date)
  const merged: Day = today
    ? {
        ...today,
        ...addTally(today, tally),
        byAgent: Object.fromEntries(
          [...new Set([...Object.keys(today.byAgent), ...Object.keys(byAgent)])].map(name => [
            name,
            (today.byAgent[name] ?? 0) + (byAgent[name] ?? 0),
          ]),
        ),
      }
    : { date, ...tally, byAgent }

  return [...days.filter(one => one.date !== date), merged].sort((a, b) => a.date.localeCompare(b.date)).slice(-DAYS_KEPT)
}

/** A stored day with every count present: rows written by an older version miss newer fields. */
export const normalizeDay = (day: Partial<Day> & { date: string }): Day => ({ ...NO_TALLY, byAgent: {}, ...day })

export const sumDays = (days: readonly Day[]) => days.reduce<Tally>((sum, one) => addTally(sum, one), NO_TALLY)

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

/** The key the main conversation's activity is kept under. */
export const MAIN = 'main'

/** Tools that change a file: the ones that can collide. */
export const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** A file path's last part. */
export const baseName = (path: string) => path.split('/').pop() ?? path

/** A short label for a tool call: the tool and its file or command. */
export function toolLabel(tool: string, path?: string, command?: string): string {
  const name = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool
  const detail = path ? baseName(path) : command ? (command.split('\n')[0] ?? '').slice(0, 40) : ''

  return detail ? `${name} ${detail}` : name
}

/**
 * Who else edited `path` while both they and `self` ran: another party whose edit
 * came after `self` started, and who is still alive now. Separate worktrees have
 * separate paths, so they never collide.
 */
export function clashesWith(
  all: Record<string, Activity>,
  self: string,
  path: string,
  selfSince: number,
  isAlive: (id: string) => boolean,
): string[] {
  return Object.entries(all)
    .filter(([id, one]) => id !== self && (one.files[path] ?? -1) >= selfSince && isAlive(id))
    .map(([id]) => id)
}
