import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { asRecord, isEmptyTotals, sanitizeTotals, sumModels, toCount } from "./index.ts"
import type { ModelTotals } from "./index.ts"

export interface HistoryRecord {
  date: string
  sessionFile: string
  models: Record<string, ModelTotals>
  totals: ModelTotals
}

export interface HistoryEntry extends HistoryRecord {
  time: number
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

export function parseLegacyLine(line: string): HistoryRecord | null {
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
