import { expect, test } from 'claude-code/testing'

import {
  isCheck,
  isHeavy,
  isMcpRead,
  isPolling,
  normalizeDay,
  resultTokens,
  workerFor,
  WORKERS,
  addToDays,
  checkWorkerCall,
  isWorker,
  keptOut,
  parsePrefix,
  routeAgent,
  runsOutAt,
  sparkline,
  isLookOnly,
  isReadCall,
  parallelTime,
  tokenText,
} from '../hooks/rules'

test('the workers are Haiku agents that say when to use them', async () => {
  expect(WORKERS.map(one => one.name)).toEqual(['repo-searcher', 'log-reader', 'test-runner', 'docs-reader', 'diff-reader', 'ticket-reader', 'mcp-reader'])
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
  // A CI job's log is only reachable through gh api while its run is still going.
  expect(checkWorkerCall('subagent-gateway:log-reader', 'Bash', 'gh api repos/o/r/actions/jobs/1/logs')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:log-reader', 'Bash', 'gh api -X GET repos/o/r/pulls')).toBe(null)
  expect(checkWorkerCall('subagent-gateway:log-reader', 'Bash', 'gh api repos/o/r/issues/1/comments -f body=hi')).toContain('read-only')
  expect(checkWorkerCall('subagent-gateway:log-reader', 'Bash', 'gh api -X DELETE repos/o/r/git/refs/heads/x')).toContain('read-only')
  expect(checkWorkerCall('subagent-gateway:log-reader', 'Bash', 'gh api --method PATCH repos/o/r')).toContain('read-only')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'sed -i s/a/b/ file.ts')).toContain('read-only')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'cat a > b')).toContain('one plain command')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'ls && rm -rf x')).toContain('one plain command')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'echo $(rm x)')).toContain('one plain command')
  expect(checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', 'find . -name "*.tmp" -delete')).toContain('read-only')
  expect(checkWorkerCall('subagent-gateway:log-reader', 'Read')).toBe(null)
})

test('a read command cannot be made to write or run another program', async () => {
  const check = (command: string) => checkWorkerCall('subagent-gateway:repo-searcher', 'Bash', command)
  // A newline is a second command, as ; is.
  expect(check('ls\nrm -rf src')).toContain('one plain command')
  expect(check('ls\r\nrm -rf src')).toContain('one plain command')
  // Options and arguments that write a file.
  expect(check('sort -o src/config.ts notes.txt')).toContain('read-only')
  expect(check('sort -uo out.txt notes.txt')).toContain('read-only')
  expect(check('sort --output=out.txt notes.txt')).toContain('read-only')
  expect(check('uniq notes.txt src/config.ts')).toContain('read-only')
  expect(check('git diff --output=patch.diff')).toContain('read-only')
  expect(check('git log -p --output patch.diff')).toContain('read-only')
  expect(check('find . -fprintf out.txt %p')).toContain('read-only')
  expect(check('find . -fprint0 out.txt')).toContain('read-only')
  expect(check('find . -okdir rm {} +')).toContain('read-only')
  // Options that run another program.
  expect(check('rg --pre ./script.sh foo')).toContain('read-only')
  expect(check('rg --pre=./script.sh foo')).toContain('read-only')
  expect(check('git grep -O foo')).toContain('read-only')
  expect(check('git grep --open-files-in-pager=vim foo')).toContain('read-only')
  expect(check('git diff --ext-diff')).toContain('read-only')
  // Their read forms still run.
  expect(check('sort notes.txt | uniq -c')).toBe(null)
  expect(check('uniq -c notes.txt')).toBe(null)
  expect(check('git diff --stat main')).toBe(null)
  expect(check('rg -n --type ts useState src')).toBe(null)
  expect(check('find . -name "*.ts" -print')).toBe(null)
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

test('kept-out tokens are what the worker took in beyond its starting context, less its report', async () => {
  expect(keptOut({ input_tokens: 2_000, cache_creation_input_tokens: 38_000 }, 'x'.repeat(4_000))).toBe(39_000)
  expect(keptOut({ input_tokens: 2_000, cache_creation_input_tokens: 38_000 }, 'x'.repeat(4_000), 25_000)).toBe(14_000)
  expect(keptOut({ input_tokens: 0, cache_creation_input_tokens: 20_000 }, '', 25_000)).toBe(0)
  expect(keptOut({ input_tokens: 10, cache_creation_input_tokens: 0 }, 'x'.repeat(400))).toBe(0)
  expect(keptOut(undefined, 'anything')).toBe(0)
})

test('parallel time is only the overlap of runs', async () => {
  expect(parallelTime([{ start: 0, end: 10_000 }, { start: 10_000, end: 20_000 }])).toBe(0)
  expect(parallelTime([{ start: 0, end: 10_000 }, { start: 0, end: 10_000 }])).toBe(10_000)
  expect(parallelTime([{ start: 0, end: 10_000 }])).toBe(0)
})

const tally = (gateway: number, subagents: number) => ({ gateway, subagents, moved: 0, parallelMs: 0, workerRuns: 1, builtinRuns: 0, missed: 0 })

test('a day adds up its prompts and keeps per-agent totals', async () => {
  const one = addToDays([], '2026-11-19', tally(100, 100), { 'log-reader': 100 })
  const two = addToDays(one, '2026-11-19', { ...tally(0, 50), workerRuns: 0, builtinRuns: 1 }, { Explore: 50 })
  expect(two).toEqual([
    { date: '2026-11-19', gateway: 100, subagents: 150, moved: 0, parallelMs: 0, workerRuns: 1, builtinRuns: 1, missed: 0, byAgent: { 'log-reader': 100, Explore: 50 } },
  ])
  expect(addToDays(two, '2026-11-18', tally(1, 1), {}).map(day => day.date)).toEqual(['2026-11-18', '2026-11-19'])
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
  expect(routeAgent('web-fetch')?.model).toBe('haiku')
  expect(routeAgent('claude-code-guide')?.model).toBe('haiku')
  expect(routeAgent('general-purpose')?.model).toBe('sonnet')
  expect(routeAgent('planner')).toBe(null)
})

test('a general-purpose task that only looks runs on Haiku, one that changes anything stays on Sonnet', async () => {
  expect(routeAgent('general-purpose', 'Find where the checkout total is computed')?.model).toBe('haiku')
  expect(routeAgent('general-purpose', 'Find the bug and fix it')?.model).toBe('sonnet')
  expect(routeAgent('general-purpose', 'Refactor the billing hooks')?.model).toBe('sonnet')
  expect(isLookOnly('summarize the open tickets')).toBe(true)
  expect(isLookOnly('add a test')).toBe(false)
  expect(isLookOnly('List all files under url-state. Do not edit, create, or delete any file.')).toBe(true)
  expect(isLookOnly('List the files, then delete the stale ones. Do not push.')).toBe(false)
})

test('reads in the main conversation are told apart from other calls', async () => {
  expect(isReadCall('Read')).toBe(true)
  expect(isReadCall('Grep')).toBe(true)
  expect(isReadCall('Bash', 'rg useRef src')).toBe(true)
  expect(isReadCall('Bash', 'pnpm install')).toBe(false)
  expect(isReadCall('Edit')).toBe(false)
  expect(isReadCall('Bash', 'cd /repo && grep -rl testIdPrefix src/v2 | sort; echo done')).toBe(true)
  expect(isReadCall('Bash', 'cd /repo\nS=/tmp/x\ngrep -rn useRef src 2>/dev/null | wc -l')).toBe(true)
  expect(isReadCall('Bash', 'grep -rl x src > /tmp/out')).toBe(false)
  expect(isReadCall('Bash', 'cd /repo && git push')).toBe(false)
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

test('mcp-reader may search, list, get and read connected tools, and nothing that sends, labels or runs', async () => {
  for (const tool of ['mcp__gmail__search_threads', 'mcp__gmail__get_thread', 'mcp__claude_ai_Slack__slack_read_thread', 'mcp__posthog__query', 'mcp__claude-in-chrome__get_page_text', 'mcp__notion__notion-search', 'Read', 'ToolSearch']) {
    expect(checkWorkerCall('subagent-gateway:mcp-reader', tool)).toBe(null)
  }
  for (const tool of ['mcp__gmail__label_thread', 'mcp__gmail__send_message', 'mcp__claude_ai_Slack__slack_send_message', 'mcp__posthog__exec', 'mcp__claude-in-chrome__navigate', 'mcp__chrome-devtools__click', 'Bash', 'Edit']) {
    expect(checkWorkerCall('subagent-gateway:mcp-reader', tool)).toContain('only searches')
  }
})

test('connected-tool reads count as reads for missed hand-offs, and name the worker that fits', async () => {
  expect(isMcpRead('mcp__gmail__search_threads')).toBe(true)
  expect(isMcpRead('mcp__gmail__label_thread')).toBe(false)
  expect(isReadCall('mcp__claude_ai_Slack__slack_search_public')).toBe(true)
  expect(workerFor('mcp__gmail__search_threads')).toBe('mcp-reader')
  expect(workerFor('mcp__claude_ai_Atlassian_MCP__getJiraIssue')).toBe('ticket-reader')
  expect(workerFor('Read')).toBe('repo-searcher')
  expect(resultTokens({ text: 'x'.repeat(40_000) })).toBeGreaterThan(10_000)
})

test('checks, heavy commands and polling are told apart', async () => {
  expect([isCheck('pnpm test'), isCheck('pnpm check-types'), isCheck('npx vitest run src'), isCheck('ls src')]).toEqual([true, true, true, false])
  expect([isHeavy('pnpm install'), isHeavy('npm ci'), isHeavy('npx vitest run'), isHeavy('git status')]).toEqual([true, true, true, false])
  expect([isPolling('sleep 30'), isPolling('until gh pr checks 1; do sleep 10; done'), isPolling('echo asleep'), isPolling('git log')]).toEqual([true, true, false, false])
})

test('a day stored by an older version gets every count, so an upgrade never loses history', async () => {
  const old = { date: '2026-11-20', gateway: 100, subagents: 200 } as any
  expect(normalizeDay(old)).toEqual({ date: '2026-11-20', gateway: 100, subagents: 200, moved: 0, parallelMs: 0, workerRuns: 0, builtinRuns: 0, missed: 0, byAgent: {} })
  expect(addToDays([old], '2026-11-20', { gateway: 1, subagents: 1, moved: 0, parallelMs: 0, workerRuns: 1, builtinRuns: 0, missed: 0 }, { 'repo-searcher': 1 })[0]).toEqual({
    date: '2026-11-20', gateway: 101, subagents: 201, moved: 0, parallelMs: 0, workerRuns: 1, builtinRuns: 0, missed: 0, byAgent: { 'repo-searcher': 1 },
  })
})
