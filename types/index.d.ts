// What subagents did for one prompt or one day.
export type Tally = {
  // Tokens the gateway's workers kept out of the main conversation: the gateway's own saving.
  gateway: number
  // Tokens every top-level subagent kept out, workers included; most would be kept out without the gateway.
  subagents: number
  // Tokens built-in agents ran on a cheaper model because the gateway routed them.
  moved: number
  // Time subagents ran side by side, in ms.
  parallelMs: number
  // Runs of a gateway worker.
  workerRuns: number
  // Runs of any other subagent type (Explore, general-purpose, custom agents).
  builtinRuns: number
  // Times the main conversation read MISSED_AT or more files in a row instead of handing them off.
  missed: number
}

// One main-conversation prompt: its model, whether an o/s/h prefix chose it,
// and what its subagents saved once it ended (null while running or when none ran).
export type Entry = {
  at: number
  model: string
  routed: boolean
  saved: Tally | null
}

// One calendar day, kept across sessions; byAgent is kept-out tokens per subagent type.
export type Day = Tally & {
  date: string
  byAgent: Record<string, number>
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

// A subagent this session started: its type and model, when it started, the
// effort its route set (null keeps its own), and whether its savings count
// (not a fork, not nested in another subagent), whether the gateway chose its
// model, and the tokens its first request held, once known.
export type SpawnedAgent = {
  type: string
  model: string
  at: number
  effort: 'low' | 'medium' | 'high' | null
  isCounted: boolean
  isRouted: boolean
  base: number | null
  /** Whether a turn of this agent has completed: a continued agent is one run, not one per turn. Default false. */
  hasRun?: boolean
}

// One agent the engine lists: its parent (null under the main conversation),
// type, name or task, status, model when known, and since when it has been seen.
export type LiveAgent = {
  id: string
  parentId: string | null
  type: string
  label: string
  status: string
  model: string | null
  since: number
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
      live: Shaped<LiveAgent[]>
      limitStarts: Shaped<Record<string, LimitStart>>
    }
  }
}
