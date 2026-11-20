import { expect, test } from 'claude-code/testing'

import {
  WORKERS,
  addToDays,
  checkWorkerCall,
  isWorker,
  keptOut,
  parsePrefix,
  routeAgent,
  runsOutAt,
  sparkline,
  timeSaved,
  tokenText,
} from '../hooks/rules'

test('the workers are Haiku agents that say when to use them', async () => {
  expect(WORKERS.map(one => one.name)).toEqual(['repo-searcher', 'log-reader', 'test-runner', 'docs-reader', 'diff-reader', 'ticket-reader'])
  for (const worker of WORKERS) {
    expect(worker.model).toBe('haiku')
    expect(worker.description).toContain('Use ')
  }
  expect(isWorker('subagent-gateway:log-reader')).toBe(true)
  expect(isWorker('Explore')).toBe(false)
})

test('reading workers run reads and refuse writes, chains and redirects', async () => {
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'rg -n useState src')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:diff-reader', 'Bash', 'git diff master | head -200')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:diff-reader', 'Bash', 'gh pr diff 512')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:diff-reader', 'Bash', 'git push origin HEAD')).toContain('read-only')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'sed -i s/a/b/ file.ts')).toContain('read-only')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'cat a > b')).toContain('one plain command')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'ls && rm -rf x')).toContain('one plain command')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'echo $(rm x)')).toContain('one plain command')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'find . -name "*.tmp" -delete')).toContain('read-only')
  expect(checkWorkerCall('subagent-gateway:log-reader', 'Read')).toBe(null)
})

test('test-runner starts test commands only', async () => {
  expect(checkWorkerCall('subagent-gateway:test-runner', 'Bash', 'npx cypress run --spec cypress/e2e/login.cy.ts 2>&1 | tail -50')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:test-runner', 'Bash', 'pnpm test src')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:test-runner', 'Bash', 'npm publish')).toContain('or a test run')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'pnpm test')).toContain('read-only')
})

test('ticket-reader reads Atlassian and nothing that writes or sends', async () => {
  expect(checkWorkerCall('subagent-gateway:ticket-reader', 'mcp__claude_ai_Atlassian_MCP__getJiraIssue')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:ticket-reader', 'mcp__claude_ai_Atlassian_Rovo_2__searchJiraIssuesUsingJql')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:ticket-reader', 'ToolSearch')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:ticket-reader', 'mcp__claude_ai_Atlassian_MCP__transitionJiraIssue')).toContain('only reads')
  expect(checkWorkerCall('subagent-gateway:ticket-reader', 'mcp__claude_ai_Atlassian_Rovo_2__addCommentToJiraIssue')).toContain('only reads')
  expect(checkWorkerCall('subagent-gateway:ticket-reader', 'mcp__claude_ai_Slack__slack_send_message')).toContain('only reads')
  expect(checkWorkerCall('subagent-gateway:ticket-reader', 'mcp__claude_ai_Gmail__get_thread')).toContain('only reads')
})

test('kept-out tokens are what the worker took in, less its report', async () => {
  expect(keptOut({ input_tokens: 2_000, cache_creation_input_tokens: 38_000 }, 'x'.repeat(4_000))).toBe(39_000)
  expect(keptOut({ input_tokens: 10, cache_creation_input_tokens: 0 }, 'x'.repeat(400))).toBe(0)
  expect(keptOut(undefined, 'anything')).toBe(0)
})

test('time saved counts overlap and Haiku speed, not sequential Sonnet runs', async () => {
  expect(timeSaved([{ start: 0, end: 10_000, isHaiku: false }, { start: 10_000, end: 20_000, isHaiku: false }])).toBe(0)
  expect(timeSaved([{ start: 0, end: 10_000, isHaiku: false }, { start: 0, end: 10_000, isHaiku: false }])).toBe(10_000)
  expect(timeSaved([{ start: 0, end: 10_000, isHaiku: true }])).toBe(2_000)
})

test('a day adds up its prompts and keeps per-worker totals', async () => {
  const one = addToDays([], '2026-11-19', { kept: 100, ms: 1_000 }, { 'log-reader': 100 })
  const two = addToDays(one, '2026-11-19', { kept: 50, ms: 0 }, { 'repo-searcher': 50 })
  expect(two).toEqual([{ date: '2026-11-19', kept: 150, ms: 1_000, byWorker: { 'log-reader': 100, 'repo-searcher': 50 } }])
  expect(addToDays(two, '2026-11-18', { kept: 1, ms: 0 }, {}).map(day => day.date)).toEqual(['2026-11-18', '2026-11-19'])
})

test('the limit forecast needs ten minutes of rising usage and a reset after it', async () => {
  const start = { percent: 20, at: 0 }
  expect(runsOutAt(start, { percent: 40, at: 3_600_000 }, null)).toBe(3_600_000 + 3 * 3_600_000)
  expect(runsOutAt(start, { percent: 40, at: 60_000 }, null)).toBe(null)
  expect(runsOutAt(start, { percent: 20, at: 3_600_000 }, null)).toBe(null)
  expect(runsOutAt(start, { percent: 40, at: 3_600_000 }, new Date(7_200_000).toISOString())).toBe(null)
})

test('the sparkline and token text read at a glance', async () => {
  expect(sparkline([0, 4, 8])).toBe('·▄█')
  expect(tokenText(640)).toBe('640')
  expect(tokenText(180_400)).toBe('180K')
  expect(tokenText(1_240_000)).toBe('1.2M')
})

test('Explore subagents get Haiku, general-purpose Sonnet, pinned agents are left alone', async () => {
  expect(routeAgent('Explore')?.model).toBe('haiku')
  expect(routeAgent('general-purpose')?.model).toBe('sonnet')
  expect(routeAgent('planner')).toBe(null)
})

test('a one-letter prefix picks the model and is stripped', async () => {
  expect(parsePrefix('o fix the flaky test')).toEqual({ model: 'opus', text: 'fix the flaky test' })
  expect(parsePrefix('S where is the spec')?.model).toBe('sonnet')
  expect(parsePrefix('h list specs')?.model).toBe('haiku')
})

test('words that only start with the letter are left alone', async () => {
  expect(parsePrefix('s3 bucket is empty')).toBe(null)
  expect(parsePrefix('show the logs')).toBe(null)
  expect(parsePrefix('o')).toBe(null)
})
