// model-mix: which model each subagent actually ran on, counted from Claude Code's own transcripts,
// not from the gateway's savings counters. Each subagent leaves
// ~/.claude/projects/<project>/<session>/subagents/agent-<id>.meta.json (agentType, model) and a
// .jsonl transcript (usage per request). Counts only; nothing is read beyond these fields and nothing
// leaves this machine.
//
//   node scripts/model-mix.mjs                 # last 7 days, all projects
//   node scripts/model-mix.mjs --days 30 --json
//
// An "empty" run is a finished subagent whose last answer says it could not do the work (permission,
// blocked, unable, could not): the hand-off that fell back to the main model. That is a text
// heuristic, reported as such.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runOf, summarize } from './model-mix-core.mjs'

const noTranscript = { count: 0 }

function* runsOnDisk(root, sinceDay) {
  if (!existsSync(root)) return
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const pdir = join(root, project.name)
    for (const session of readdirSync(pdir, { withFileTypes: true })) {
      const sdir = join(pdir, session.name, 'subagents')
      if (!session.isDirectory() || !existsSync(sdir)) continue
      for (const f of readdirSync(sdir)) {
        if (!f.endsWith('.meta.json')) continue
        let meta
        try {
          meta = JSON.parse(readFileSync(join(sdir, f), 'utf8'))
        } catch {
          continue
        }
        const jsonl = join(sdir, f.replace(/\.meta\.json$/, '.jsonl'))
        const run = runOf(meta, existsSync(jsonl) ? readFileSync(jsonl, 'utf8').split('\n') : [])
        if (run === null) noTranscript.count++
        else if (run.day >= sinceDay) yield run
      }
    }
  }
}

function main() {
  const args = process.argv.slice(2)
  const days = Number(args[args.indexOf('--days') + 1]) || 7
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const s = summarize([...runsOnDisk(join(homedir(), '.claude', 'projects'), since)])
  if (args.includes('--json')) return console.log(JSON.stringify(s, null, 2))
  const pct = x => `${Math.round(100 * x)}%`
  console.log(`subagent runs since ${since}: ${s.total}, on Haiku ${pct(s.haikuShare)} (${noTranscript.count} metas with no transcript, all time, not counted)`)
  for (const [m, v] of Object.entries(s.byModel)) console.log(`  ${m.padEnd(8)} ${String(v.runs).padStart(5)} runs  ${String(Math.round(v.tokens / 1e3)).padStart(7)}k tokens  ${v.empty} empty`)
  console.log('by agent type:')
  for (const [k, v] of Object.entries(s.byType).sort((a, b) => b[1].runs - a[1].runs).slice(0, 15)) console.log(`  ${String(v.runs).padStart(5)}  ${k}${v.empty ? `  (${v.empty} empty)` : ''}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
