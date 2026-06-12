import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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

export interface HistoryRecord {
  date: string
  sessionFile: string
  models: Record<string, ModelTotals>
  totals: ModelTotals
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

interface Extracted {
  counts: Counts
  embedded: number | null
}

function extractUsage(message: unknown): Extracted | null {
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

function modelIdOf(message: unknown, activeModel: unknown): string {
  const record = asRecord(message)
  if (record && typeof record.model === "string" && record.model.trim()) return record.model.trim()
  const model = asRecord(activeModel)
  if (model && typeof model.id === "string" && model.id.trim()) return model.id.trim()
  return "unknown"
}

function ratesOf(activeModel: unknown): Counts | null {
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

interface SqlStatement {
  run(...args: (string | number | null)[]): { lastInsertRowid: number | bigint }
  all(...args: (string | number | null)[]): unknown[]
}

interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
}

export function usageDbPath(): string {
  return join(homedir(), ".pi", "agent", "usage.db")
}

let handle: SqlDatabase | null | undefined

function db(): SqlDatabase | null {
  if (handle !== undefined) return handle
  const require = createRequire(import.meta.url)
  const emitWarning = process.emitWarning
  process.emitWarning = () => undefined
  try {
    const sqlite = require("node:sqlite") as { DatabaseSync: new (location: string) => SqlDatabase }
    const path = usageDbPath()
    mkdirSync(dirname(path), { recursive: true })
    const opened = new sqlite.DatabaseSync(path)
    opened.exec("PRAGMA journal_mode = WAL")
    opened.exec("PRAGMA busy_timeout = 5000")
    opened.exec("PRAGMA synchronous = NORMAL")
    opened.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, date TEXT NOT NULL, session_file TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost REAL NOT NULL, turns INTEGER NOT NULL) STRICT"
    )
    opened.exec(
      "CREATE TABLE IF NOT EXISTS session_models (session_id INTEGER NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost REAL NOT NULL, turns INTEGER NOT NULL) STRICT"
    )
    opened.exec("CREATE INDEX IF NOT EXISTS sessions_time ON sessions (time)")
    opened.exec("CREATE INDEX IF NOT EXISTS session_models_session ON session_models (session_id)")
    handle = opened
    migrateLegacyHistory(opened)
  } catch {
    handle = null
  } finally {
    process.emitWarning = emitWarning
  }
  return handle
}

function insertRecord(store: SqlDatabase, record: HistoryRecord): void {
  const time = Date.parse(record.date)
  if (!Number.isFinite(time)) return
  store.exec("BEGIN IMMEDIATE")
  try {
    const totals = record.totals
    const result = store
      .prepare(
        "INSERT INTO sessions (time, date, session_file, input, output, cache_read, cache_write, cost, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        time,
        record.date,
        record.sessionFile,
        totals.input,
        totals.output,
        totals.cacheRead,
        totals.cacheWrite,
        totals.cost,
        totals.turns
      )
    const sessionId = Number(result.lastInsertRowid)
    const insertModel = store.prepare(
      "INSERT INTO session_models (session_id, model, input, output, cache_read, cache_write, cost, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    for (const [model, entry] of Object.entries(record.models)) {
      insertModel.run(sessionId, model, entry.input, entry.output, entry.cacheRead, entry.cacheWrite, entry.cost, entry.turns)
    }
    store.exec("COMMIT")
  } catch (error) {
    try {
      store.exec("ROLLBACK")
    } catch {}
    throw error
  }
}

function parseLegacyLine(line: string): HistoryRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const record = asRecord(parsed)
  if (!record) return null
  if (typeof record.date !== "string" || !Number.isFinite(Date.parse(record.date))) return null
  const models: Record<string, ModelTotals> = {}
  const modelsRecord = asRecord(record.models)
  if (modelsRecord) {
    for (const [id, value] of Object.entries(modelsRecord)) {
      const totals = sanitizeTotals(value)
      if (totals && id.trim() && !isEmptyTotals(totals)) models[id] = totals
    }
  }
  const totals = sanitizeTotals(record.totals) ?? sumModels(models)
  if (Object.keys(models).length === 0 && isEmptyTotals(totals)) return null
  return {
    date: record.date,
    sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : "",
    models,
    totals
  }
}

function migrateLegacyHistory(store: SqlDatabase): void {
  const legacy = join(homedir(), ".pi", "agent", "usage.jsonl")
  if (!existsSync(legacy)) return
  const claimed = `${legacy}.migrated`
  try {
    renameSync(legacy, claimed)
  } catch {
    return
  }
  let raw: string
  try {
    raw = readFileSync(claimed, "utf8")
  } catch {
    return
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const record = parseLegacyLine(trimmed)
    if (!record) continue
    try {
      insertRecord(store, record)
    } catch {}
  }
}

export function appendHistory(record: HistoryRecord): void {
  const store = db()
  if (!store) return
  insertRecord(store, record)
}

function rowTotals(row: Record<string, unknown>): ModelTotals {
  return {
    input: toCount(row.input),
    output: toCount(row.output),
    cacheRead: toCount(row.cache_read),
    cacheWrite: toCount(row.cache_write),
    cost: toCount(row.cost),
    turns: Math.floor(toCount(row.turns))
  }
}

export interface HistoryEntry extends HistoryRecord {
  time: number
}

export function loadHistory(sinceMs: number): HistoryEntry[] | null {
  const store = db()
  if (!store) return null
  try {
    const sessions = store
      .prepare(
        "SELECT id, time, date, session_file, input, output, cache_read, cache_write, cost, turns FROM sessions WHERE time >= ? ORDER BY time"
      )
      .all(sinceMs) as Record<string, unknown>[]
    const modelRows = store
      .prepare(
        "SELECT session_id, model, input, output, cache_read, cache_write, cost, turns FROM session_models WHERE session_id IN (SELECT id FROM sessions WHERE time >= ?)"
      )
      .all(sinceMs) as Record<string, unknown>[]
    const modelsBySession = new Map<number, Record<string, ModelTotals>>()
    for (const row of modelRows) {
      const sessionId = toCount(row.session_id)
      const model = typeof row.model === "string" ? row.model : ""
      if (model === "") continue
      const models = modelsBySession.get(sessionId) ?? {}
      models[model] = rowTotals(row)
      modelsBySession.set(sessionId, models)
    }
    const entries: HistoryEntry[] = []
    for (const row of sessions) {
      const time = toCount(row.time)
      if (time <= 0) continue
      entries.push({
        time,
        date: typeof row.date === "string" ? row.date : new Date(time).toISOString(),
        sessionFile: typeof row.session_file === "string" ? row.session_file : "",
        models: modelsBySession.get(toCount(row.id)) ?? {},
        totals: rowTotals(row)
      })
    }
    return entries
  } catch {
    return null
  }
}
