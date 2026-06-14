import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import type { Dirent } from "node:fs"
import { homedir } from "node:os"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import type { CheckpointConfig, LabelGroup, ManifestEntry } from "./config.ts"
import { Sqlite } from "./sqlite.ts"

export type SnapshotOutcome = "saved" | "skipped" | "toolarge" | "outside" | "failed"

interface PendingFile {
  path: string
  content: Buffer | null
}

interface SessionSurvivor {
  name: string
  newest: number
  bytes: number
}

interface TrimRow {
  id: number
  hash: string | null
}

export class SnapshotStore {
  private readonly config: CheckpointConfig
  private readonly sqlite: Sqlite
  private readonly root: string
  private sessionId: string
  private currentLabel: string
  private readonly pending: Map<string, PendingFile[]>
  private readonly bashRegexes: RegExp[]
  private sessionBytes: number

  constructor(config: CheckpointConfig, sqlite: Sqlite, root: string = join(homedir(), ".pi", "agent", "checkpoints")) {
    this.config = config
    this.sqlite = sqlite
    this.root = root
    this.sessionId = `unsaved-${randomUUID().slice(0, 8)}`
    this.currentLabel = "session start"
    this.pending = new Map()
    this.sessionBytes = 0
    this.bashRegexes = []

    for (const pattern of config.bashPatterns) {
      try {
        this.bashRegexes.push(new RegExp(pattern))
      } catch {}
    }
  }

  ensureSession(sessionFile: string | null | undefined): void {
    if (!sessionFile) {
      return
    }

    const base = basename(sessionFile)
    const ext = extname(base)
    const stem = ext ? base.slice(0, -ext.length) : base
    const safe = stem.replace(/[^A-Za-z0-9._-]+/g, "-")

    if (!safe || safe === this.sessionId) {
      return
    }

    this.sessionId = safe
    this.sessionBytes = this.dirSize(this.sessionDir())
  }

  resetLabel(): void {
    this.currentLabel = "session start"
    this.pending.clear()
  }

  setLabel(label: string): void {
    const value = label.trim()

    if (value) {
      this.currentLabel = value
    }
  }

  excerpt(prompt: string): string {
    const flat = prompt.replace(/\s+/g, " ").trim()

    if (!flat) {
      return ""
    }

    if (flat.length <= this.config.labelMaxChars) {
      return flat
    }

    return `${flat.slice(0, this.config.labelMaxChars - 1)}…`
  }

  matchesBashHeuristic(command: string): boolean {
    return this.bashRegexes.some(regex => regex.test(command))
  }

  inside(abs: string, cwd: string): boolean {
    const rel = relative(resolve(cwd), abs)

    if (rel === "") {
      return false
    }

    return !rel.startsWith("..") && !isAbsolute(rel)
  }

  capture(toolCallId: string, targetPath: string, cwd: string): void {
    const abs = resolve(cwd, targetPath)

    if (!this.inside(abs, cwd)) {
      return
    }

    const existing = this.pending.get(toolCallId)

    if (existing && existing.some(item => item.path === abs)) {
      return
    }

    let content: Buffer | null = null

    if (existsSync(abs)) {
      try {
        const stat = statSync(abs)

        if (!stat.isFile()) {
          return
        }

        if (stat.size > this.config.maxFileMb * 1024 * 1024) {
          return
        }

        content = readFileSync(abs)
      } catch {
        return
      }
    }

    if (existing) {
      existing.push({ path: abs, content })
    } else {
      this.pending.set(toolCallId, [{ path: abs, content }])
    }
  }

  discard(toolCallId: string): void {
    this.pending.delete(toolCallId)
  }

  discardAll(): void {
    this.pending.clear()
  }

  commit(toolCallId: string): number {
    const list = this.pending.get(toolCallId)
    this.pending.delete(toolCallId)

    if (!list || list.length === 0) {
      return 0
    }

    let committed = 0

    for (const item of list) {
      if (this.persist(toolCallId, item.path, item.content, this.currentLabel)) {
        committed++
      }
    }

    this.maybePrune()

    return committed
  }

  maybePrune(): void {
    if (this.sessionBytes > this.config.maxMb * 1024 * 1024) {
      try {
        this.prune()
      } catch {}
    }
  }

  snapshotNow(toolCallId: string, absPath: string, cwd: string, label: string): SnapshotOutcome {
    if (!this.inside(absPath, cwd)) {
      return "outside"
    }

    let content: Buffer | null = null

    if (existsSync(absPath)) {
      try {
        const stat = statSync(absPath)

        if (stat.isDirectory()) {
          return "skipped"
        }

        if (!stat.isFile()) {
          return "skipped"
        }

        if (stat.size > this.config.maxFileMb * 1024 * 1024) {
          return "toolarge"
        }

        content = readFileSync(absPath)
      } catch {
        return "failed"
      }
    }

    return this.persist(toolCallId, absPath, content, label) ? "saved" : "failed"
  }

  readManifest(): ManifestEntry[] {
    const store = this.sqlite.handle()

    if (!store) {
      return []
    }

    let rows: Record<string, unknown>[]

    try {
      rows = store
        .prepare("SELECT ts, tool_call_id, path, hash, size, label FROM manifest WHERE session_id = ? ORDER BY id")
        .all(this.sessionId) as Record<string, unknown>[]
    } catch {
      return []
    }

    const entries: ManifestEntry[] = []

    for (const row of rows) {
      if (
        typeof row.ts === "number" &&
        typeof row.tool_call_id === "string" &&
        typeof row.path === "string" &&
        typeof row.size === "number" &&
        typeof row.label === "string" &&
        (row.hash === null || typeof row.hash === "string")
      ) {
        entries.push({
          ts: row.ts,
          toolCallId: row.tool_call_id,
          path: row.path,
          hash: row.hash,
          size: row.size,
          label: row.label
        })
      }
    }

    return entries
  }

  groups(): LabelGroup[] {
    const entries = this.readManifest()
    const ascending: LabelGroup[] = []

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const last = ascending[ascending.length - 1]

      if (last && last.label === entry.label) {
        last.lastTs = Math.max(last.lastTs, entry.ts)
        last.entryCount++

        if (!last.paths.includes(entry.path)) {
          last.paths.push(entry.path)
        }
      } else {
        ascending.push({
          label: entry.label,
          firstIndex: i,
          firstTs: entry.ts,
          lastTs: entry.ts,
          paths: [entry.path],
          entryCount: 1
        })
      }
    }

    return ascending.reverse()
  }

  hasBlob(hash: string): boolean {
    return existsSync(join(this.objectsDir(), `${hash}.gz`))
  }

  readBlob(hash: string): Buffer | null {
    let raw: Buffer

    try {
      raw = readFileSync(join(this.objectsDir(), `${hash}.gz`))
    } catch {
      return null
    }

    try {
      const content = gunzipSync(raw)
      const digest = createHash("sha256").update(content).digest("hex")

      return digest === hash ? content : null
    } catch {
      return null
    }
  }

  prune(): void {
    let names: string[]

    try {
      names = readdirSync(this.root, { withFileTypes: true })
        .filter(item => item.isDirectory())
        .map(item => item.name)
    } catch {
      return
    }

    const cutoff = Date.now() - this.config.maxAgeDays * 86400000
    const survivors: SessionSurvivor[] = []

    for (const name of names) {
      const dir = join(this.root, name)
      const newest = this.newestTs(name, dir)

      if (newest < cutoff && name !== this.sessionId) {
        try {
          rmSync(dir, { recursive: true, force: true })
          this.dropSessionRows(name)
        } catch {}

        continue
      }

      survivors.push({ name, newest, bytes: this.dirSize(dir) })
    }

    const budget = this.config.maxMb * 1024 * 1024
    let total = survivors.reduce((sum, item) => sum + item.bytes, 0)

    if (total > budget) {
      const removable = survivors
        .filter(item => item.name !== this.sessionId)
        .sort((a, b) => a.newest - b.newest)

      for (const victim of removable) {
        if (total <= budget) {
          break
        }

        try {
          rmSync(join(this.root, victim.name), { recursive: true, force: true })
          this.dropSessionRows(victim.name)
          total -= victim.bytes
        } catch {}
      }

      if (total > budget) {
        this.trimSession(budget)
      }
    }

    this.dropOrphanRows(new Set(names))
    this.sessionBytes = this.dirSize(this.sessionDir())
  }

  private dropSessionRows(name: string): void {
    const store = this.sqlite.handle()

    if (!store) {
      return
    }

    try {
      store.prepare("DELETE FROM manifest WHERE session_id = ?").run(name)
    } catch {}
  }

  private dropOrphanRows(existing: Set<string>): void {
    const store = this.sqlite.handle()

    if (!store) {
      return
    }

    let rows: Record<string, unknown>[]

    try {
      rows = store.prepare("SELECT DISTINCT session_id FROM manifest").all() as Record<string, unknown>[]
    } catch {
      return
    }

    for (const row of rows) {
      const name = typeof row.session_id === "string" ? row.session_id : ""

      if (name === "" || name === this.sessionId || existing.has(name)) {
        continue
      }

      this.dropSessionRows(name)
    }
  }

  private persist(toolCallId: string, path: string, content: Buffer | null, label: string): boolean {
    const store = this.sqlite.handle()

    if (!store) {
      return false
    }

    try {
      mkdirSync(this.objectsDir(), { recursive: true })
      let hash: string | null = null
      let size = 0

      if (content) {
        hash = createHash("sha256").update(content).digest("hex")
        size = content.length
        const blobPath = join(this.objectsDir(), `${hash}.gz`)

        if (!existsSync(blobPath)) {
          const compressed = gzipSync(content)
          const tmp = `${blobPath}.${process.pid}.tmp`
          writeFileSync(tmp, compressed)
          renameSync(tmp, blobPath)
          this.sessionBytes += compressed.length
        }
      }

      store
        .prepare("INSERT INTO manifest (session_id, ts, tool_call_id, path, hash, size, label) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(this.sessionId, Date.now(), toolCallId, path, hash, size, label)

      return true
    } catch {
      return false
    }
  }

  private trimSession(budget: number): void {
    const store = this.sqlite.handle()

    if (!store) {
      return
    }

    let rows: TrimRow[]

    try {
      const raw = store
        .prepare("SELECT id, hash FROM manifest WHERE session_id = ? ORDER BY id")
        .all(this.sessionId) as Record<string, unknown>[]
      rows = raw
        .filter(row => typeof row.id === "number" && (row.hash === null || typeof row.hash === "string"))
        .map(row => ({ id: row.id as number, hash: row.hash as string | null }))
    } catch {
      return
    }

    if (rows.length === 0) {
      return
    }

    const blobSizes = this.measureBlobs(rows)
    const kept: TrimRow[] = []
    const keptHashes = new Set<string>()
    let used = 0

    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      const extra = row.hash && !keptHashes.has(row.hash) ? blobSizes.get(row.hash) ?? 0 : 0

      if (kept.length > 0 && used + extra > budget) {
        break
      }

      kept.unshift(row)

      if (row.hash) {
        keptHashes.add(row.hash)
      }

      used += extra
    }

    if (kept.length < rows.length) {
      try {
        store.prepare("DELETE FROM manifest WHERE session_id = ? AND id < ?").run(this.sessionId, kept[0].id)
      } catch {
        return
      }
    }

    for (const hash of blobSizes.keys()) {
      if (!keptHashes.has(hash)) {
        try {
          rmSync(join(this.objectsDir(), `${hash}.gz`), { force: true })
        } catch {}
      }
    }
  }

  private measureBlobs(rows: TrimRow[]): Map<string, number> {
    const blobSizes = new Map<string, number>()

    for (const row of rows) {
      if (row.hash && !blobSizes.has(row.hash)) {
        try {
          blobSizes.set(row.hash, statSync(join(this.objectsDir(), `${row.hash}.gz`)).size)
        } catch {
          blobSizes.set(row.hash, 0)
        }
      }
    }

    return blobSizes
  }

  private newestTs(name: string, dir: string): number {
    const store = this.sqlite.handle()

    if (store) {
      try {
        const row = store.prepare("SELECT MAX(ts) AS ts FROM manifest WHERE session_id = ?").get(name) as
          | { ts?: unknown }
          | undefined

        if (row && typeof row.ts === "number") {
          return row.ts
        }
      } catch {}
    }

    try {
      return statSync(dir).mtimeMs
    } catch {
      return 0
    }
  }

  private dirSize(dir: string): number {
    let items: Dirent[]

    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return 0
    }

    let total = 0

    for (const item of items) {
      const full = join(dir, item.name)

      if (item.isDirectory()) {
        total += this.dirSize(full)
      } else if (item.isFile()) {
        try {
          total += statSync(full).size
        } catch {}
      }
    }

    return total
  }

  private sessionDir(): string {
    return join(this.root, this.sessionId)
  }

  private objectsDir(): string {
    return join(this.sessionDir(), "objects")
  }
}
