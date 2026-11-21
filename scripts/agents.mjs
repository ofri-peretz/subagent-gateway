// Writes agents/*.md from WORKERS in hooks/rules.ts; with --check, fails when they differ.
import { readFileSync, writeFileSync } from 'node:fs'
const { WORKERS } = await import('../hooks/rules.ts')
const check = process.argv.includes('--check')
let stale = []
for (const w of WORKERS) {
  const lines = ['---', `name: ${w.name}`, `description: ${JSON.stringify(w.description)}`, `model: ${w.model}`, `effort: ${w.effort}`]
  if (w.tools) lines.push(`tools: ${w.tools.join(', ')}`)
  if (w.disallowedTools) lines.push(`disallowedTools: ${w.disallowedTools.join(', ')}`)
  const text = [...lines, '---', '', w.prompt, ''].join('\n')
  const path = new URL(`../agents/${w.name}.md`, import.meta.url)
  if (!check) writeFileSync(path, text)
  else if ((() => { try { return readFileSync(path, 'utf8') } catch { return '' } })() !== text) stale.push(w.name)
}
if (stale.length) {
  console.error(`agents/ is out of step with WORKERS: ${stale.join(', ')}. Run: node --experimental-strip-types scripts/agents.mjs`)
  process.exit(1)
}
