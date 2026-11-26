export interface Run {
  day: string | null
  type: string
  model: string
  tokens: number
  empty: boolean
}

export interface Summary {
  total: number
  haikuShare: number
  byModel: Record<string, { runs: number; tokens: number; empty: number }>
  byType: Record<string, { runs: number; empty: number }>
  byDay: Record<string, Record<string, number>>
}

export function runOf(meta: { agentType?: string; model?: string; finished?: boolean }, lines: string[]): Run | null
export function summarize(runs: Run[]): Summary
