import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs"
import type { Dirent } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ManifestEntry } from "./config.ts"

export interface SqlStatement {
  run(...args: (string | number | null)[]): unknown
  get(...args: (string | number | null)[]): unknown
  all(...args: (string | number | null)[]): unknown[]
}

export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
}

export type SqlOpener = (location: string) => SqlDatabase

interface SqliteModule {
  DatabaseSync: new (location: string) => SqlDatabase
}

export function nodeSqliteOpener(location: string): SqlDatabase {
  const require = createRequire(import.meta.url)
  const emitWarning = process.emitWarning
  process.emitWarning = () => undefined

  try {
    const sqlite = require("node:sqlite") as SqliteModule

    return new sqlite.DatabaseSync(location)
  } finally {
    process.emitWarning = emitWarning
  }
}

export class Sqlite {
  private opened: SqlDatabase | null | undefined
  private readonly root: string
  private readonly location: string
  private readonly open: SqlOpener

  constructor(root: string = join(homedir(), ".pi", "agent", "checkpoints"), open: SqlOpener = nodeSqliteOpener) {
    this.opened = undefined
    this.root = root
    this.location = join(this.root, "manifests.db")
    this.open = open
  }

  handle(): SqlDatabase | null {
    if (this.opened !== undefined) {
      return this.opened
    }

    try {
      mkdirSync(dirname(this.location), { recursive: true })

      const opened = this.open(this.location)
      opened.exec("PRAGMA journal_mode = WAL")
      opened.exec("PRAGMA busy_timeout = 5000")
      opened.exec("PRAGMA synchronous = NORMAL")
      opened.exec(
        "CREATE TABLE IF NOT EXISTS manifest (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, tool_call_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT, size INTEGER NOT NULL, label TEXT NOT NULL) STRICT"
      )
      opened.exec("CREATE INDEX IF NOT EXISTS manifest_session ON manifest (session_id, id)")

      this.opened = opened
      this.migrate(opened)
    } catch {
      this.opened = null
    }

    return this.opened
  }

  private migrate(store: SqlDatabase): void {
    let items: Dirent[]

    try {
      items = readdirSync(this.root, { withFileTypes: true })
    } catch {
      return
    }

    const insert = store.prepare(
      "INSERT INTO manifest (session_id, ts, tool_call_id, path, hash, size, label) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )

    for (const item of items) {
      if (!item.isDirectory()) {
        continue
      }

      const file = join(this.root, item.name, "manifest.jsonl")
      let raw: string

      try {
        raw = readFileSync(file, "utf8")
      } catch {
        continue
      }

      try {
        store.exec("BEGIN IMMEDIATE")

        for (const entry of this.parseLegacy(raw)) {
          insert.run(item.name, entry.ts, entry.toolCallId, entry.path, entry.hash, entry.size, entry.label)
        }

        store.exec("COMMIT")
      } catch {
        try {
          store.exec("ROLLBACK")
        } catch {}

        continue
      }

      try {
        unlinkSync(file)
      } catch {}
    }
  }

  parseLegacy(raw: string): ManifestEntry[] {
    const entries: ManifestEntry[] = []

    for (const line of raw.split("\n")) {
      const trimmed = line.trim()

      if (!trimmed) {
        continue
      }

      let parsed: ManifestEntry

      try {
        parsed = JSON.parse(trimmed) as ManifestEntry
      } catch {
        continue
      }

      if (
        typeof parsed.ts === "number" &&
        typeof parsed.toolCallId === "string" &&
        typeof parsed.path === "string" &&
        typeof parsed.size === "number" &&
        typeof parsed.label === "string" &&
        (parsed.hash === null || typeof parsed.hash === "string")
      ) {
        entries.push(parsed)
      }
    }

    return entries
  }
}
