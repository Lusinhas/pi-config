import { asRecord, toCount } from "./index.ts"
import type { Counts } from "./index.ts"

export interface Extracted {
  counts: Counts
  embedded: number | null
}

export function extractUsage(message: unknown): Extracted | null {
  const record = asRecord(message)

  if (!record) return null

  if (record.role !== "assistant") return null

  const usage = asRecord(record.usage)

  if (!usage) return null

  const counts: Counts = {
    input: toCount(usage.input),
    output: toCount(usage.output),
    cacheRead: toCount(usage.cacheRead),
    cacheWrite: toCount(usage.cacheWrite)
  }
  let embedded: number | null = null

  if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) {
    embedded = usage.cost
  } else {
    const cost = asRecord(usage.cost)

    if (cost && typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total >= 0) {
      embedded = cost.total
    }
  }

  if (counts.input + counts.output + counts.cacheRead + counts.cacheWrite === 0 && embedded === null) return null

  return { counts, embedded }
}

export function modelIdOf(message: unknown, activeModel: unknown): string {
  const record = asRecord(message)

  if (record && typeof record.model === "string" && record.model.trim()) return record.model.trim()

  const model = asRecord(activeModel)

  if (model && typeof model.id === "string" && model.id.trim()) return model.id.trim()

  return "unknown"
}

export function ratesOf(activeModel: unknown): Counts | null {
  const model = asRecord(activeModel)

  if (!model) return null

  const cost = asRecord(model.cost)

  if (!cost) return null

  const rates: Counts = {
    input: toCount(cost.input),
    output: toCount(cost.output),
    cacheRead: toCount(cost.cacheRead),
    cacheWrite: toCount(cost.cacheWrite)
  }

  if (rates.input + rates.output + rates.cacheRead + rates.cacheWrite === 0) return null

  return rates
}
