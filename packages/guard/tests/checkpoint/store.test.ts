import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FALLBACK } from "../../src/checkpoint/config.ts"
import type { CheckpointConfig } from "../../src/checkpoint/config.ts"
import { Sqlite } from "../../src/checkpoint/sqlite.ts"
import type { SqlDatabase } from "../../src/checkpoint/sqlite.ts"
import { SnapshotStore } from "../../src/checkpoint/index.ts"

function config(overrides: Partial<CheckpointConfig> = {}): CheckpointConfig {
  return { ...FALLBACK, ...overrides }
}

function opener(location: string): SqlDatabase {
  return new Database(location) as unknown as SqlDatabase
}

let storageRoot: string
let workdir: string

function newSqlite(): Sqlite {
  return new Sqlite(storageRoot, opener)
}

function newStore(cfg: CheckpointConfig = config()): SnapshotStore {
  return new SnapshotStore(cfg, newSqlite(), storageRoot)
}

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "checkpoint-store-"))
  workdir = mkdtempSync(join(tmpdir(), "checkpoint-work-"))
})

afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
})

describe("SnapshotStore label helpers", () => {
  test("excerpt collapses whitespace and truncates with ellipsis", () => {
    const store = newStore(config({ labelMaxChars: 10 }))

    expect(store.excerpt("  hi\n  there  ")).toBe("hi there")
    expect(store.excerpt("abcdefghijklmnop")).toBe("abcdefghi…")
    expect(store.excerpt("   ")).toBe("")
  })

  test("setLabel ignores blank labels", () => {
    const store = newStore()
    store.setLabel("real")
    store.setLabel("   ")

    const file = join(workdir, "x.txt")
    writeFileSync(file, "v1")
    store.ensureSession(join(storageRoot, "sessions", "abc.jsonl"))
    store.capture("t1", file, workdir)
    store.commit("t1")

    const groups = store.groups()
    expect(groups[0].label).toBe("real")
  })

  test("matchesBashHeuristic uses compiled patterns", () => {
    const store = newStore(config({ bashPatterns: ["\\brm\\s", ">{1,2}"] }))

    expect(store.matchesBashHeuristic("rm file")).toBe(true)
    expect(store.matchesBashHeuristic("echo hi > out")).toBe(true)
    expect(store.matchesBashHeuristic("ls -la")).toBe(false)
  })

  test("invalid regex patterns are dropped without throwing", () => {
    const store = newStore(config({ bashPatterns: ["(", "\\brm\\s"] }))

    expect(store.matchesBashHeuristic("rm file")).toBe(true)
  })
})

describe("SnapshotStore.inside", () => {
  test("rejects equal, parent, and absolute escapes", () => {
    const store = newStore()

    expect(store.inside(workdir, workdir)).toBe(false)
    expect(store.inside(join(workdir, "a"), workdir)).toBe(true)
    expect(store.inside(join(workdir, "..", "x"), workdir)).toBe(false)
  })
})

describe("SnapshotStore session derivation", () => {
  test("sanitizes session id from file basename stem", () => {
    const store = newStore()
    store.ensureSession("/some/path/My Session!.jsonl")
    const file = join(workdir, "f.txt")
    writeFileSync(file, "x")
    store.capture("t", file, workdir)
    store.commit("t")

    expect(existsSync(join(storageRoot, "My-Session-"))).toBe(true)
  })
})

describe("SnapshotStore capture and commit", () => {
  test("captures pre-mutation content and commits it as a blob", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s1.jsonl"))
    const file = join(workdir, "a.txt")
    writeFileSync(file, "before")
    store.capture("call1", file, workdir)
    writeFileSync(file, "after")

    expect(store.commit("call1")).toBe(1)

    const entries = store.readManifest()
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(file)
    expect(entries[0].hash).not.toBeNull()
    expect(store.readBlob(entries[0].hash as string)?.toString()).toBe("before")
  })

  test("captures nonexistent target as null hash so rewind can delete it", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s2.jsonl"))
    const file = join(workdir, "new.txt")
    store.capture("call", file, workdir)
    store.commit("call")

    const entries = store.readManifest()
    expect(entries).toHaveLength(1)
    expect(entries[0].hash).toBeNull()
    expect(entries[0].size).toBe(0)
  })

  test("skips files larger than maxFileMb", () => {
    const store = newStore(config({ maxFileMb: 0.000001 }))
    store.ensureSession(join(storageRoot, "s3.jsonl"))
    const file = join(workdir, "big.txt")
    writeFileSync(file, "x".repeat(1024))
    store.capture("call", file, workdir)
    store.commit("call")

    expect(store.readManifest()).toHaveLength(0)
  })

  test("skips targets outside cwd", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s4.jsonl"))
    store.capture("call", join(workdir, "..", "escape.txt"), workdir)
    store.commit("call")

    expect(store.readManifest()).toHaveLength(0)
  })

  test("dedupes the same path within a tool call", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s5.jsonl"))
    const file = join(workdir, "d.txt")
    writeFileSync(file, "x")
    store.capture("call", file, workdir)
    store.capture("call", file, workdir)
    store.commit("call")

    expect(store.readManifest()).toHaveLength(1)
  })

  test("discard drops pending captures", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s6.jsonl"))
    const file = join(workdir, "e.txt")
    writeFileSync(file, "x")
    store.capture("call", file, workdir)
    store.discard("call")
    store.commit("call")

    expect(store.readManifest()).toHaveLength(0)
  })

  test("discardAll clears every pending capture", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s7.jsonl"))
    const file = join(workdir, "g.txt")
    writeFileSync(file, "x")
    store.capture("c1", file, workdir)
    store.discardAll()
    store.commit("c1")

    expect(store.readManifest()).toHaveLength(0)
  })

  test("identical content commits dedupe the blob but keep manifest rows", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s8.jsonl"))
    const a = join(workdir, "a.txt")
    const b = join(workdir, "b.txt")
    writeFileSync(a, "same")
    writeFileSync(b, "same")
    store.capture("c1", a, workdir)
    store.capture("c1", b, workdir)
    store.commit("c1")

    const entries = store.readManifest()
    expect(entries).toHaveLength(2)
    expect(entries[0].hash).toBe(entries[1].hash as string)
  })
})

describe("SnapshotStore.groups ordering", () => {
  test("groups consecutive same-label runs and reverses to newest first", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s9.jsonl"))
    const file = join(workdir, "f.txt")

    store.setLabel("first")
    writeFileSync(file, "1")
    store.capture("c1", file, workdir)
    store.commit("c1")

    store.setLabel("second")
    writeFileSync(file, "2")
    store.capture("c2", file, workdir)
    store.commit("c2")

    const groups = store.groups()
    expect(groups.map(g => g.label)).toEqual(["second", "first"])
    expect(groups[0].firstIndex).toBe(1)
    expect(groups[1].firstIndex).toBe(0)
  })
})

describe("SnapshotStore.snapshotNow", () => {
  test("classifies outside, directory, and saved outcomes", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s10.jsonl"))
    const file = join(workdir, "snap.txt")
    writeFileSync(file, "data")
    mkdirSync(join(workdir, "adir"))

    expect(store.snapshotNow("m", join(workdir, "..", "x"), workdir, "manual")).toBe("outside")
    expect(store.snapshotNow("m", join(workdir, "adir"), workdir, "manual")).toBe("skipped")
    expect(store.snapshotNow("m", file, workdir, "manual")).toBe("saved")
  })

  test("marks oversize files as toolarge", () => {
    const store = newStore(config({ maxFileMb: 0.000001 }))
    store.ensureSession(join(storageRoot, "s11.jsonl"))
    const file = join(workdir, "huge.txt")
    writeFileSync(file, "y".repeat(4096))

    expect(store.snapshotNow("m", file, workdir, "manual")).toBe("toolarge")
  })
})

describe("SnapshotStore.readBlob integrity", () => {
  test("returns null when the blob does not exist", () => {
    const store = newStore()
    store.ensureSession(join(storageRoot, "s12.jsonl"))

    expect(store.readBlob("0".repeat(64))).toBeNull()
    expect(store.hasBlob("0".repeat(64))).toBe(false)
  })
})

describe("SnapshotStore.prune", () => {
  test("removes sessions older than maxAgeDays except the current one", () => {
    const store = newStore(config({ maxAgeDays: 30 }))
    const oldDir = join(storageRoot, "old-session")
    mkdirSync(join(oldDir, "objects"), { recursive: true })
    writeFileSync(join(oldDir, "objects", "blob.gz"), "x")
    const past = Date.now() - 60 * 86400000
    statSync(oldDir)

    const fakeSqlite = newSqlite()
    const handle = fakeSqlite.handle()
    handle?.prepare(
      "INSERT INTO manifest (session_id, ts, tool_call_id, path, hash, size, label) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("old-session", past, "t", join(workdir, "z.txt"), null, 0, "lbl")

    const pruner = new SnapshotStore(config(), fakeSqlite, storageRoot)
    pruner.ensureSession(join(storageRoot, "current.jsonl"))
    pruner.prune()

    expect(existsSync(oldDir)).toBe(false)
  })

  test("maybePrune swallows a prune failure without throwing", () => {
    const store = newStore(config({ maxMb: 0.000001 }))
    store.ensureSession(join(storageRoot, "fail.jsonl"))
    const file = join(workdir, "p.txt")
    writeFileSync(file, "z".repeat(2048))
    store.capture("c1", file, workdir)
    store.commit("c1")

    rmSync(storageRoot, { recursive: true, force: true })

    expect(() => store.maybePrune()).not.toThrow()
  })
})

describe("Sqlite legacy migration", () => {
  test("imports manifest.jsonl rows and unlinks the legacy file", () => {
    const legacyDir = join(storageRoot, "legacy")
    mkdirSync(legacyDir, { recursive: true })
    const row = {
      ts: 123,
      toolCallId: "t",
      path: "/x/y.txt",
      hash: null,
      size: 0,
      label: "old"
    }
    writeFileSync(join(legacyDir, "manifest.jsonl"), `${JSON.stringify(row)}\ninvalid line\n`)

    const sqlite = newSqlite()
    const handle = sqlite.handle()
    const rows = handle?.prepare("SELECT session_id, label FROM manifest WHERE session_id = ?").all("legacy")

    expect(rows).toHaveLength(1)
    expect(existsSync(join(legacyDir, "manifest.jsonl"))).toBe(false)
  })

  test("parseLegacy validates each line", () => {
    const sqlite = newSqlite()
    const parsed = sqlite.parseLegacy(
      `${JSON.stringify({ ts: 1, toolCallId: "a", path: "p", hash: "h", size: 2, label: "l" })}\n` +
        `${JSON.stringify({ ts: "bad", toolCallId: "a", path: "p", hash: "h", size: 2, label: "l" })}\n` +
        "not json\n"
    )

    expect(parsed).toHaveLength(1)
    expect(parsed[0].toolCallId).toBe("a")
  })
})
