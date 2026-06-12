import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import type { Dirent } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

export interface CheckpointConfig {
  maxMb: number
  maxAgeDays: number
  labelMaxChars: number
  maxFileMb: number
  maxBashFiles: number
  maxCheckpointFiles: number
  confirmListLimit: number
  bashPatterns: string[]
}

export interface ManifestEntry {
  ts: number
  toolCallId: string
  path: string
  hash: string | null
  size: number
  label: string
}

export interface LabelGroup {
  label: string
  firstIndex: number
  firstTs: number
  lastTs: number
  paths: string[]
  entryCount: number
}

interface SqlStatement {
  run(...args: (string | number | null)[]): unknown
  get(...args: (string | number | null)[]): unknown
  all(...args: (string | number | null)[]): unknown[]
}

interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
}

let handle: SqlDatabase | null | undefined

function db(): SqlDatabase | null {
  if (handle !== undefined) return handle
  const require = createRequire(import.meta.url)
  const emitWarning = process.emitWarning
  process.emitWarning = () => undefined
  try {
    const sqlite = require("node:sqlite") as { DatabaseSync: new (location: string) => SqlDatabase }
    const path = join(homedir(), ".pi", "agent", "checkpoints", "manifests.db")
    mkdirSync(dirname(path), { recursive: true })
    const opened = new sqlite.DatabaseSync(path)
    opened.exec("PRAGMA journal_mode = WAL")
    opened.exec("PRAGMA busy_timeout = 5000")
    opened.exec("PRAGMA synchronous = NORMAL")
    opened.exec(
      "CREATE TABLE IF NOT EXISTS manifest (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, tool_call_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT, size INTEGER NOT NULL, label TEXT NOT NULL) STRICT"
    )
    opened.exec("CREATE INDEX IF NOT EXISTS manifest_session ON manifest (session_id, id)")
    handle = opened
    migrateLegacyManifests(opened)
  } catch {
    handle = null
  } finally {
    process.emitWarning = emitWarning
  }
  return handle
}

function parseLegacyManifest(raw: string): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as ManifestEntry
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
    } catch {}
  }
  return entries
}

function migrateLegacyManifests(store: SqlDatabase): void {
  const root = join(homedir(), ".pi", "agent", "checkpoints")
  let items: Dirent[]
  try {
    items = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const insert = store.prepare(
    "INSERT INTO manifest (session_id, ts, tool_call_id, path, hash, size, label) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
  for (const item of items) {
    if (!item.isDirectory()) continue
    const file = join(root, item.name, "manifest.jsonl")
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch {
      continue
    }
    try {
      store.exec("BEGIN IMMEDIATE")
      for (const entry of parseLegacyManifest(raw)) {
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

export type SnapshotOutcome = "saved" | "skipped" | "toolarge" | "outside" | "failed"

export interface CheckpointSummary {
  saved: number
  skippedOutside: string[]
  skippedLarge: string[]
  skippedOther: string[]
  failed: string[]
  truncated: boolean
}

interface PendingFile {
  path: string
  content: Buffer | null
}

interface BashCandidate {
  path: string
  existing: boolean
}

export class SnapshotStore {
  private readonly config: CheckpointConfig
  private readonly root: string
  private sessionId: string
  private currentLabel: string
  private readonly pending: Map<string, PendingFile[]>
  private readonly bashRegexes: RegExp[]
  private sessionBytes: number

  constructor(config: CheckpointConfig) {
    this.config = config
    this.root = join(homedir(), ".pi", "agent", "checkpoints")
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
    if (!sessionFile) return
    const base = basename(sessionFile)
    const ext = extname(base)
    const stem = ext ? base.slice(0, -ext.length) : base
    const safe = stem.replace(/[^A-Za-z0-9._-]+/g, "-")
    if (!safe || safe === this.sessionId) return
    this.sessionId = safe
    this.sessionBytes = this.dirSize(this.sessionDir())
  }

  resetLabel(): void {
    this.currentLabel = "session start"
    this.pending.clear()
  }

  setLabel(label: string): void {
    const value = label.trim()
    if (value) this.currentLabel = value
  }

  excerpt(prompt: string): string {
    const flat = prompt.replace(/\s+/g, " ").trim()
    if (!flat) return ""
    if (flat.length <= this.config.labelMaxChars) return flat
    return `${flat.slice(0, this.config.labelMaxChars - 1)}…`
  }

  matchesBashHeuristic(command: string): boolean {
    return this.bashRegexes.some(regex => regex.test(command))
  }

  inside(abs: string, cwd: string): boolean {
    const rel = relative(resolve(cwd), abs)
    if (rel === "") return false
    return !rel.startsWith("..") && !isAbsolute(rel)
  }

  capture(toolCallId: string, targetPath: string, cwd: string): void {
    const abs = resolve(cwd, targetPath)
    if (!this.inside(abs, cwd)) return
    const existing = this.pending.get(toolCallId)
    if (existing && existing.some(item => item.path === abs)) return
    let content: Buffer | null = null
    if (existsSync(abs)) {
      try {
        const stat = statSync(abs)
        if (!stat.isFile()) return
        if (stat.size > this.config.maxFileMb * 1024 * 1024) return
        content = readFileSync(abs)
      } catch {
        return
      }
    }
    if (existing) existing.push({ path: abs, content })
    else this.pending.set(toolCallId, [{ path: abs, content }])
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
    if (!list || list.length === 0) return 0
    let committed = 0
    for (const item of list) {
      if (this.persist(toolCallId, item.path, item.content, this.currentLabel)) committed++
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
    if (!this.inside(absPath, cwd)) return "outside"
    let content: Buffer | null = null
    if (existsSync(absPath)) {
      try {
        const stat = statSync(absPath)
        if (stat.isDirectory()) return "skipped"
        if (!stat.isFile()) return "skipped"
        if (stat.size > this.config.maxFileMb * 1024 * 1024) return "toolarge"
        content = readFileSync(absPath)
      } catch {
        return "failed"
      }
    }
    return this.persist(toolCallId, absPath, content, label) ? "saved" : "failed"
  }

  readManifest(): ManifestEntry[] {
    const store = db()
    if (!store) return []
    try {
      const rows = store
        .prepare("SELECT ts, tool_call_id, path, hash, size, label FROM manifest WHERE session_id = ? ORDER BY id")
        .all(this.sessionId) as Record<string, unknown>[]
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
    } catch {
      return []
    }
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
        if (!last.paths.includes(entry.path)) last.paths.push(entry.path)
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
    try {
      const raw = readFileSync(join(this.objectsDir(), `${hash}.gz`))
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
    const survivors: { name: string; newest: number; bytes: number }[] = []
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
        if (total <= budget) break
        try {
          rmSync(join(this.root, victim.name), { recursive: true, force: true })
          this.dropSessionRows(victim.name)
          total -= victim.bytes
        } catch {}
      }
      if (total > budget) this.trimSession(budget)
    }
    this.dropOrphanRows(new Set(names))
    this.sessionBytes = this.dirSize(this.sessionDir())
  }

  private dropSessionRows(name: string): void {
    const store = db()
    if (!store) return
    try {
      store.prepare("DELETE FROM manifest WHERE session_id = ?").run(name)
    } catch {}
  }

  private dropOrphanRows(existing: Set<string>): void {
    const store = db()
    if (!store) return
    try {
      const rows = store.prepare("SELECT DISTINCT session_id FROM manifest").all() as Record<string, unknown>[]
      for (const row of rows) {
        const name = typeof row.session_id === "string" ? row.session_id : ""
        if (name === "" || name === this.sessionId || existing.has(name)) continue
        this.dropSessionRows(name)
      }
    } catch {}
  }

  private persist(toolCallId: string, path: string, content: Buffer | null, label: string): boolean {
    const store = db()
    if (!store) return false
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
    const store = db()
    if (!store) return
    let rows: { id: number; hash: string | null }[]
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
    if (rows.length === 0) return
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
    const kept: { id: number; hash: string | null }[] = []
    const keptHashes = new Set<string>()
    let used = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      const extra = row.hash && !keptHashes.has(row.hash) ? blobSizes.get(row.hash) ?? 0 : 0
      if (kept.length > 0 && used + extra > budget) break
      kept.unshift(row)
      if (row.hash) keptHashes.add(row.hash)
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

  private newestTs(name: string, dir: string): number {
    const store = db()
    if (store) {
      try {
        const row = store.prepare("SELECT MAX(ts) AS ts FROM manifest WHERE session_id = ?").get(name) as
          | { ts?: unknown }
          | undefined
        if (row && typeof row.ts === "number") return row.ts
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

export function bashCandidates(command: string, cwd: string, limit: number): BashCandidate[] {
  const tokens = tokenize(command)
  const out: BashCandidate[] = []
  const seen = new Set<string>()
  let redirectNext = false
  for (const raw of tokens) {
    if (out.length >= limit) break
    if (/^(?:\d*|&)>{1,2}$/.test(raw)) {
      redirectNext = true
      continue
    }
    let token = raw
    let fromRedirect = redirectNext
    redirectNext = false
    const attached = /^(?:\d*|&)>{1,2}(.+)$/.exec(raw)
    if (attached && attached[1]) {
      token = attached[1]
      fromRedirect = true
    }
    if (!fromRedirect && token.startsWith("-")) continue
    let expanded = token
    if (expanded === "~") expanded = homedir()
    else if (expanded.startsWith("~/")) expanded = join(homedir(), expanded.slice(2))
    const abs = resolve(cwd, expanded)
    const rel = relative(resolve(cwd), abs)
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue
    if (seen.has(abs)) continue
    let existing = false
    try {
      existing = statSync(abs).isFile()
    } catch {
      existing = false
    }
    if (!existing && !fromRedirect) continue
    seen.add(abs)
    out.push({ path: abs, existing })
  }
  return out
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i]
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[++i]
    } else if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&") {
      if (current) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

export async function checkpointGitWorkingSet(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  store: SnapshotStore,
  config: CheckpointConfig,
  label: string
): Promise<CheckpointSummary | string> {
  let top: { stdout: string; stderr: string; code: number }
  try {
    top = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 10000 })
  } catch (error) {
    return `git unavailable: ${errorMessage(error)}`
  }
  if (top.code !== 0) return "Not inside a git repository; nothing to checkpoint."
  const root = top.stdout.trim()
  if (!root) return "Could not resolve the git repository root."
  let status: { stdout: string; stderr: string; code: number }
  try {
    status = await pi.exec("git", ["-C", ctx.cwd, "status", "--porcelain"], { timeout: 30000 })
  } catch (error) {
    return `git status failed: ${errorMessage(error)}`
  }
  if (status.code !== 0) {
    return `git status failed: ${status.stderr.trim() || `exit code ${status.code}`}`
  }
  const paths = parsePorcelain(status.stdout)
  if (paths.length === 0) return "Git working set is clean; nothing to checkpoint."
  const summary: CheckpointSummary = {
    saved: 0,
    skippedOutside: [],
    skippedLarge: [],
    skippedOther: [],
    failed: [],
    truncated: false
  }
  const targets: string[] = []
  for (const rel of paths) {
    if (targets.length >= config.maxCheckpointFiles) {
      summary.truncated = true
      break
    }
    const abs = resolve(root, rel)
    let isDirectory = false
    try {
      isDirectory = statSync(abs).isDirectory()
    } catch {
      isDirectory = false
    }
    if (isDirectory) {
      collectFiles(abs, targets, config.maxCheckpointFiles)
      if (targets.length >= config.maxCheckpointFiles) summary.truncated = true
    } else {
      targets.push(abs)
    }
  }
  const toolCallId = `manual-${randomUUID().slice(0, 8)}`
  for (const abs of targets.slice(0, config.maxCheckpointFiles)) {
    const outcome = store.snapshotNow(toolCallId, abs, ctx.cwd, label)
    if (outcome === "saved") summary.saved++
    else if (outcome === "outside") summary.skippedOutside.push(abs)
    else if (outcome === "toolarge") summary.skippedLarge.push(abs)
    else if (outcome === "skipped") summary.skippedOther.push(abs)
    else summary.failed.push(abs)
  }
  store.maybePrune()
  return summary
}

function collectFiles(dir: string, sink: string[], limit: number): void {
  if (sink.length >= limit) return
  let items: Dirent[]
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    if (sink.length >= limit) return
    const full = join(dir, item.name)
    if (item.isDirectory()) collectFiles(full, sink, limit)
    else if (item.isFile()) sink.push(full)
  }
}

function parsePorcelain(stdout: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const rest = line.slice(3)
    let targets: string[]
    if (code.includes("R") || code.includes("C")) {
      const pair = splitRename(rest)
      targets = pair ? [pair[0], pair[1]] : [rest]
    } else {
      targets = [rest]
    }
    for (const target of targets) {
      const cleaned = unquoteGitPath(target).replace(/\/+$/, "")
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned)
        out.push(cleaned)
      }
    }
  }
  return out
}

function splitRename(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    let i = 1
    while (i < rest.length) {
      if (rest[i] === "\\") i += 2
      else if (rest[i] === '"') break
      else i++
    }
    const from = rest.slice(0, i + 1)
    const remainder = rest.slice(i + 1)
    if (remainder.startsWith(" -> ")) return [from, remainder.slice(4)]
    return null
  }
  const idx = rest.indexOf(" -> ")
  if (idx === -1) return null
  return [rest.slice(0, idx), rest.slice(idx + 4)]
}

function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  const inner = value.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch !== "\\") {
      for (const byte of Buffer.from(ch, "utf8")) bytes.push(byte)
      continue
    }
    const next = inner[i + 1]
    if (next === undefined) break
    if (next >= "0" && next <= "7") {
      let digits = ""
      while (digits.length < 3 && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
        digits += inner[i + 1]
        i++
      }
      bytes.push(Number.parseInt(digits, 8) & 0xff)
      continue
    }
    i++
    if (next === "n") bytes.push(10)
    else if (next === "t") bytes.push(9)
    else if (next === "r") bytes.push(13)
    else if (next === "a") bytes.push(7)
    else if (next === "b") bytes.push(8)
    else if (next === "f") bytes.push(12)
    else if (next === "v") bytes.push(11)
    else for (const byte of Buffer.from(next, "utf8")) bytes.push(byte)
  }
  return Buffer.from(bytes).toString("utf8")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
