import { emptyTotals } from "./index.ts"
import type { ModelTotals } from "./index.ts"
import type { HistoryEntry } from "./store.ts"
import { usageCells } from "./table.ts"

export interface Bucket {
  sessions: number
  totals: ModelTotals
}

export function cutoffMs(statsDays: number): number {
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - (statsDays - 1))

  return cutoff.getTime()
}

export function dayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")

  return `${year}-${month}-${day}`
}

export function addTotals(target: ModelTotals, source: ModelTotals): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.cost += source.cost
  target.turns += source.turns
}

export function statRow(label: string, bucket: Bucket, decimals: number): string[] {
  return [label, String(bucket.sessions), ...usageCells(bucket.totals, decimals)]
}

export interface Aggregated {
  daily: Map<string, Bucket>
  byModel: Map<string, Bucket>
  overall: Bucket
}

export function aggregate(entries: HistoryEntry[]): Aggregated {
  const daily = new Map<string, Bucket>()
  const byModel = new Map<string, Bucket>()

  for (const entry of entries) {
    const day = dayKey(new Date(entry.time))
    const dayBucket = daily.get(day) ?? { sessions: 0, totals: emptyTotals() }
    dayBucket.sessions += 1
    addTotals(dayBucket.totals, entry.totals)
    daily.set(day, dayBucket)

    for (const [id, totals] of Object.entries(entry.models)) {
      const modelBucket = byModel.get(id) ?? { sessions: 0, totals: emptyTotals() }
      modelBucket.sessions += 1
      addTotals(modelBucket.totals, totals)
      byModel.set(id, modelBucket)
    }
  }

  const overall: Bucket = { sessions: entries.length, totals: emptyTotals() }

  for (const bucket of daily.values()) addTotals(overall.totals, bucket.totals)

  return { daily, byModel, overall }
}
