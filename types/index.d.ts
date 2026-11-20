// What subagents saved: tokens kept out of the main conversation, and time (estimated).
export type Saving = {
  kept: number
  ms: number
}

// One main-conversation prompt: its model, whether an o/s/h prefix chose it,
// and what its subagents saved once it ended (null while running or when none ran).
export type Entry = {
  at: number
  model: string
  routed: boolean
  saved: Saving | null
}

// One calendar day of savings, kept across sessions; byWorker is kept tokens per subagent type.
export type Day = Saving & {
  date: string
  byWorker: Record<string, number>
}

// The account's limit windows and the session's context, as last measured.
export type Usage = {
  limits: { kind: string; percentUsed: number; resetsAt: string | null }[]
  contextPercent: number | null
  contextTokens: number | null
}

// A limit window's first reading, the start of its pace for the forecast.
export type LimitStart = {
  percent: number
  at: number
  resetsAt: string | null
}

// A subagent this session started: its type and model, when it started and
// ended (null while running), the effort its route set (null keeps its own),
// and whether its savings count (not a fork, not nested in another subagent).
export type SpawnedAgent = {
  type: string
  model: string
  at: number
  endedAt: number | null
  effort: 'low' | 'medium' | 'high' | null
  isCounted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-gateway': {
      entries: Shaped<Entry[]>
      isOff: boolean
      usage: Shaped<Usage | null>
      agents: Shaped<Record<string, SpawnedAgent>>
      isCompacting: boolean
      days: Shaped<Day[]>
      limitStarts: Shaped<Record<string, LimitStart>>
    }
  }
}
