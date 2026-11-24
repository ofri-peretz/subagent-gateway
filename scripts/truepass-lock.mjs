// Fails when truepass is unwired. `truepass diff --base origin/main` runs before every push through
// the hookset pre-push preset's test-integrity station (`npm run --if-present hook:test-integrity`),
// so deleting the script makes the station pass silently. This holds the script, the dependency and
// the preset. A plugin test cannot read package.json or lefthook.yml (`claude plugin test` loads
// code files only), so the lock is a script, run by CI (check.yml) like scripts/agents.mjs.
import { readFileSync } from 'node:fs'
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const { scripts = {}, devDependencies = {} } = JSON.parse(read('package.json'))
const problems = []
if (!/^\^?[1-9]\d*\./.test(devDependencies.truepass ?? '')) problems.push(`package.json devDependencies.truepass is ${devDependencies.truepass ?? 'missing'}, not 1.x or later. Run: npm i -D truepass@^1.0.0`)
if (scripts['hook:test-integrity'] !== 'npx truepass diff --base origin/main') problems.push('package.json scripts["hook:test-integrity"] must be "npx truepass diff --base origin/main"')
if (!read('lefthook.yml').includes('- packages/hookset/presets/lefthook/pre-push.yml')) problems.push('lefthook.yml no longer pulls the hookset pre-push preset, whose test-integrity station runs hook:test-integrity')
if (problems.length) {
  console.error(`truepass is unwired:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
