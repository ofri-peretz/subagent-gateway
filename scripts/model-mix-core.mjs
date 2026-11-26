// The pure half of scripts/model-mix.mjs: no imports, so the plugin's test runner can load it.

const FAMILY = /(opus|sonnet|haiku|fable)/i
const EMPTY = /\b(could not|couldn't|unable to|was blocked|is blocked|permission (prompt|denied)|not permitted)\b/i

/** One subagent run from its meta and transcript lines. */
export function runOf(meta, lines) {
  let tokens = 0
  let at = null
  let last = ''
  let model = meta.model ?? null
  for (const line of lines) {
    if (!line.trim()) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    at ??= o.timestamp ?? null
    if (o.type !== 'assistant') continue
    const m = o.message ?? {}
    if (m.model && m.model !== '<synthetic>') model = m.model
    const u = m.usage ?? {}
    tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
    const text = (m.content ?? []).filter(c => c.type === 'text').map(c => c.text).join(' ')
    if (text) last = text
  }
  // A meta with no transcript is a subagent that never ran or was not recorded: not a run.
  if (!at) return null
  const family = (FAMILY.exec(model ?? '')?.[1] ?? 'unknown').toLowerCase()
  return { day: at ? at.slice(0, 10) : null, type: meta.agentType ?? 'unknown', model: family, tokens, empty: Boolean(meta.finished) && EMPTY.test(last.slice(-600)) }
}

/** Totals by model, by agent type and model, and per day. */
export function summarize(runs) {
  const byModel = {}
  const byType = {}
  const byDay = {}
  for (const r of runs) {
    const m = (byModel[r.model] ??= { runs: 0, tokens: 0, empty: 0 })
    m.runs++
    m.tokens += r.tokens
    if (r.empty) m.empty++
    const t = (byType[`${r.type} → ${r.model}`] ??= { runs: 0, empty: 0 })
    t.runs++
    if (r.empty) t.empty++
    if (r.day) (byDay[r.day] ??= {})[r.model] = ((byDay[r.day] ?? {})[r.model] ?? 0) + 1
  }
  const total = runs.length
  const haiku = byModel.haiku?.runs ?? 0
  return { total, haikuShare: total ? haiku / total : 0, byModel, byType, byDay }
}

