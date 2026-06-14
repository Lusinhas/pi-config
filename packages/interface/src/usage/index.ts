import { extractUsage, modelIdOf, ratesOf } from "./message.ts"

export interface Counts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelTotals extends Counts {
  cost: number
  turns: number
}

export interface SessionSnapshot {
  models: Record<string, ModelTotals>
  totals: ModelTotals
  updatedAt: string
}

export interface BusPayload extends Counts {
  cost: number
  turns: number
  model: string
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>

  return null
}

export function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

export function emptyTotals(): ModelTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
}

export function isEmptyTotals(totals: ModelTotals): boolean {
  return (
    totals.input === 0 &&
    totals.output === 0 &&
    totals.cacheRead === 0 &&
    totals.cacheWrite === 0 &&
    totals.cost === 0 &&
    totals.turns === 0
  )
}

export function sanitizeTotals(value: unknown): ModelTotals | null {
  const record = asRecord(value)

  if (!record) return null

  return {
    input: toCount(record.input),
    output: toCount(record.output),
    cacheRead: toCount(record.cacheRead),
    cacheWrite: toCount(record.cacheWrite),
    cost: toCount(record.cost),
    turns: Math.floor(toCount(record.turns))
  }
}

export function sumModels(models: Record<string, ModelTotals>): ModelTotals {
  const totals = emptyTotals()

  for (const entry of Object.values(models)) {
    totals.input += entry.input
    totals.output += entry.output
    totals.cacheRead += entry.cacheRead
    totals.cacheWrite += entry.cacheWrite
    totals.cost += entry.cost
    totals.turns += entry.turns
  }

  return totals
}

export class UsageTracker {
  private models = new Map<string, ModelTotals>()
  private turnModels = new Set<string>()
  private turns = 0
  private lastModel = ""
  private baseline: SessionSnapshot | null = null

  reset(): void {
    this.models.clear()
    this.turnModels.clear()
    this.turns = 0
    this.lastModel = ""
    this.baseline = null
  }

  record(message: unknown, activeModel: unknown): boolean {
    const extracted = extractUsage(message)

    if (!extracted) return false

    const modelId = modelIdOf(message, activeModel)
    let cost = extracted.embedded

    if (cost === null) {
      const rates = ratesOf(activeModel)
      cost = rates
        ? (extracted.counts.input * rates.input +
            extracted.counts.output * rates.output +
            extracted.counts.cacheRead * rates.cacheRead +
            extracted.counts.cacheWrite * rates.cacheWrite) /
          1e6
        : 0
    }

    const entry = this.models.get(modelId) ?? emptyTotals()
    entry.input += extracted.counts.input
    entry.output += extracted.counts.output
    entry.cacheRead += extracted.counts.cacheRead
    entry.cacheWrite += extracted.counts.cacheWrite
    entry.cost += cost
    this.models.set(modelId, entry)
    this.turnModels.add(modelId)
    this.lastModel = modelId

    return true
  }

  endTurn(fallbackModel: string): BusPayload {
    this.turns += 1

    for (const modelId of this.turnModels) {
      const entry = this.models.get(modelId)

      if (entry) entry.turns += 1
    }

    this.turnModels.clear()
    const totals = this.totals()

    return {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      cost: totals.cost,
      turns: this.turns,
      model: this.lastModel || fallbackModel || "unknown"
    }
  }

  totals(): ModelTotals {
    const totals = sumModels(Object.fromEntries(this.models))
    totals.turns = this.turns

    return totals
  }

  snapshot(): SessionSnapshot {
    const models: Record<string, ModelTotals> = {}

    for (const [id, entry] of this.models) models[id] = { ...entry }

    return { models, totals: this.totals(), updatedAt: new Date().toISOString() }
  }

  delta(): SessionSnapshot {
    const snap = this.snapshot()

    if (!this.baseline) return snap

    const models: Record<string, ModelTotals> = {}

    for (const [id, entry] of Object.entries(snap.models)) {
      const base = this.baseline.models[id]
      const next: ModelTotals = base
        ? {
            input: Math.max(0, entry.input - base.input),
            output: Math.max(0, entry.output - base.output),
            cacheRead: Math.max(0, entry.cacheRead - base.cacheRead),
            cacheWrite: Math.max(0, entry.cacheWrite - base.cacheWrite),
            cost: Math.max(0, entry.cost - base.cost),
            turns: Math.max(0, entry.turns - base.turns)
          }
        : { ...entry }

      if (!isEmptyTotals(next)) models[id] = next
    }

    const totals = sumModels(models)
    totals.turns = Math.max(0, this.turns - this.baseline.totals.turns)

    return { models, totals, updatedAt: snap.updatedAt }
  }

  restore(data: unknown): boolean {
    const record = asRecord(data)

    if (!record) return false

    const modelsRecord = asRecord(record.models)

    if (!modelsRecord) return false

    const models = new Map<string, ModelTotals>()
    let lastModel = ""

    for (const [id, value] of Object.entries(modelsRecord)) {
      const totals = sanitizeTotals(value)

      if (totals && id.trim() && !isEmptyTotals(totals)) {
        models.set(id, totals)
        lastModel = id
      }
    }

    const totals = sanitizeTotals(record.totals)

    if (models.size === 0 && (!totals || totals.turns === 0)) return false

    this.models = models
    this.turnModels.clear()
    let maxModelTurns = 0

    for (const entry of models.values()) maxModelTurns = Math.max(maxModelTurns, entry.turns)

    this.turns = totals ? Math.max(totals.turns, maxModelTurns) : maxModelTurns
    this.lastModel = lastModel
    this.baseline = this.snapshot()

    return true
  }

  hasData(): boolean {
    return this.models.size > 0 || this.turns > 0
  }

  hasNewData(): boolean {
    return Object.keys(this.delta().models).length > 0
  }
}
