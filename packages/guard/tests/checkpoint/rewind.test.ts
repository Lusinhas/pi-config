import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FALLBACK } from "../../src/checkpoint/config.ts"
import type { CheckpointConfig, ManifestEntry } from "../../src/checkpoint/config.ts"
import { Sqlite } from "../../src/checkpoint/sqlite.ts"
import type { SqlDatabase } from "../../src/checkpoint/sqlite.ts"
import { SnapshotStore } from "../../src/checkpoint/index.ts"
import { RewindEngine } from "../../src/checkpoint/rewind.ts"
import type { MutationQueue } from "../../src/checkpoint/rewind.ts"
import { CheckpointPlanner } from "../../src/checkpoint/planner.ts"

function config(overrides: Partial<CheckpointConfig> = {}): CheckpointConfig {
  return { ...FALLBACK, ...overrides }
}

function opener(location: string): SqlDatabase {
  return new Database(location) as unknown as SqlDatabase
}

const directQueue: MutationQueue = async (_path, fn) => {
  await fn()
}

let storageRoot: string
let workdir: string

function newStore(cfg: CheckpointConfig = config()): SnapshotStore {
  return new SnapshotStore(cfg, new Sqlite(storageRoot, opener), storageRoot)
}

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "checkpoint-rw-store-"))
  workdir = mkdtempSync(join(tmpdir(), "checkpoint-rw-work-"))
})

afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
})

describe("RewindEngine.parseArgs", () => {
  const engine = new RewindEngine(newStoreLazy(), config(), directQueue)

  function newStoreLazy(): SnapshotStore {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-rw-unused-"))
    return new SnapshotStore(config(), new Sqlite(dir, opener), dir)
  }

  test("detects dry, preview, and --dry-run tokens", () => {
    expect(engine.parseArgs("dry", 3).dry).toBe(true)
    expect(engine.parseArgs("preview", 3).dry).toBe(true)
    expect(engine.parseArgs("--dry-run", 3).dry).toBe(true)
    expect(engine.parseArgs("2", 3).dry).toBe(false)
  })

  test("resolves an in-range numeric index", () => {
    const parsed = engine.parseArgs("2", 3)

    expect(parsed.numericPresent).toBe(true)
    expect(parsed.numericValue).toBe(2)
    expect(parsed.index).toBe(1)
  })

  test("out-of-range numeric leaves index unresolved", () => {
    const parsed = engine.parseArgs("9", 3)

    expect(parsed.numericPresent).toBe(true)
    expect(parsed.index).toBe(-1)
  })

  test("unknown tokens are collected", () => {
    const parsed = engine.parseArgs("bogus", 3)

    expect(parsed.numericPresent).toBe(false)
    expect(parsed.unknown).toEqual(["bogus"])
  })

  test("empty args yields no numeric and no unknown", () => {
    const parsed = engine.parseArgs("", 3)

    expect(parsed.numericPresent).toBe(false)
    expect(parsed.unknown).toEqual([])
    expect(parsed.index).toBe(-1)
  })
})

describe("RewindEngine.buildPlan", () => {
  test("classifies restore, delete, unchanged, and skip", () => {
    const store = newStore()
    const engine = new RewindEngine(store, config(), directQueue)
    store.ensureSession(join(storageRoot, "plan.jsonl"))

    const restoreFile = join(workdir, "restore.txt")
    writeFileSync(restoreFile, "old")
    store.capture("c1", restoreFile, workdir)
    store.commit("c1")
    writeFileSync(restoreFile, "new")

    const deleteFile = join(workdir, "delete.txt")
    store.capture("c2", deleteFile, workdir)
    store.commit("c2")
    writeFileSync(deleteFile, "created later")

    const unchangedFile = join(workdir, "unchanged.txt")
    writeFileSync(unchangedFile, "stable")
    store.capture("c3", unchangedFile, workdir)
    store.commit("c3")

    const entries = store.readManifest()
    const plan = engine.buildPlan(entries, 0, workdir)
    const byPath = new Map(plan.map(item => [item.entry.path, item.action]))

    expect(byPath.get(restoreFile)).toBe("restore")
    expect(byPath.get(deleteFile)).toBe("delete")
    expect(byPath.get(unchangedFile)).toBe("unchanged")
  })

  test("skips entries whose blob is missing", () => {
    const entries: ManifestEntry[] = [
      { ts: 1, toolCallId: "t", path: join(workdir, "gone.txt"), hash: "a".repeat(64), size: 3, label: "l" }
    ]
    const store = newStore()
    const engine = new RewindEngine(store, config(), directQueue)

    const plan = engine.buildPlan(entries, 0, workdir)

    expect(plan[0].action).toBe("skip")
    expect(plan[0].note).toBe("snapshot data missing")
  })

  test("skips entries outside cwd", () => {
    const entries: ManifestEntry[] = [
      { ts: 1, toolCallId: "t", path: "/etc/passwd", hash: null, size: 0, label: "l" }
    ]
    const store = newStore()
    const engine = new RewindEngine(store, config(), directQueue)

    const plan = engine.buildPlan(entries, 0, workdir)

    expect(plan[0].action).toBe("skip")
    expect(plan[0].note).toBe("outside cwd")
  })

  test("null-hash entry that is already absent is unchanged", () => {
    const entries: ManifestEntry[] = [
      { ts: 1, toolCallId: "t", path: join(workdir, "absent.txt"), hash: null, size: 0, label: "l" }
    ]
    const store = newStore()
    const engine = new RewindEngine(store, config(), directQueue)

    const plan = engine.buildPlan(entries, 0, workdir)

    expect(plan[0].action).toBe("unchanged")
    expect(plan[0].note).toBe("already absent")
  })

  test("takes oldest entry per path and orders by ts descending", () => {
    const older = join(workdir, "a.txt")
    const newer = join(workdir, "b.txt")
    const entries: ManifestEntry[] = [
      { ts: 100, toolCallId: "t", path: older, hash: null, size: 0, label: "l" },
      { ts: 200, toolCallId: "t", path: newer, hash: null, size: 0, label: "l" },
      { ts: 300, toolCallId: "t", path: older, hash: null, size: 0, label: "l" }
    ]
    const store = newStore()
    const engine = new RewindEngine(store, config(), directQueue)

    const plan = engine.buildPlan(entries, 0, workdir)

    expect(plan.map(item => item.entry.ts)).toEqual([200, 100])
  })
})

describe("RewindEngine.applyPlan", () => {
  test("restores files, deletes others, and records counts", async () => {
    const store = newStore()
    const engine = new RewindEngine(store, config(), directQueue)
    store.ensureSession(join(storageRoot, "apply.jsonl"))

    const restoreFile = join(workdir, "restore.txt")
    writeFileSync(restoreFile, "snapshot")
    store.capture("c1", restoreFile, workdir)
    store.commit("c1")
    writeFileSync(restoreFile, "drifted")

    const deleteFile = join(workdir, "del.txt")
    store.capture("c2", deleteFile, workdir)
    store.commit("c2")
    writeFileSync(deleteFile, "exists now")

    const entries = store.readManifest()
    const plan = engine.buildPlan(entries, 0, workdir)
    const result = await engine.applyPlan(plan)

    expect(result.restored).toBe(1)
    expect(result.deleted).toBe(1)
    expect(readFileSync(restoreFile, "utf8")).toBe("snapshot")
    expect(existsSync(deleteFile)).toBe(false)
    expect(result.failures).toEqual([])
  })

  test("reports unreadable snapshot data as a failure", async () => {
    const store = newStore()
    const engine = new RewindEngine(store, config(), directQueue)
    const entries: ManifestEntry[] = [
      { ts: 1, toolCallId: "t", path: join(workdir, "x.txt"), hash: "b".repeat(64), size: 1, label: "l" }
    ]
    const plan = entries.map(entry => ({ entry, action: "restore" as const, note: "" }))
    const result = await engine.applyPlan(plan)

    expect(result.restored).toBe(0)
    expect(result.failures[0]).toContain("snapshot data unreadable")
  })
})

describe("RewindEngine formatting", () => {
  const fmtDir = mkdtempSync(join(tmpdir(), "checkpoint-rw-fmt-"))
  const engine = new RewindEngine(
    new SnapshotStore(config(), new Sqlite(fmtDir, opener), fmtDir),
    config({ confirmListLimit: 2 }),
    directQueue
  )

  test("optionLabel and listing render index, label, count, and age", () => {
    const group = {
      label: "edit readme",
      firstIndex: 0,
      firstTs: 0,
      lastTs: Date.now(),
      paths: ["a", "b"],
      entryCount: 2
    }

    expect(engine.optionLabel(group, 0)).toBe("1. edit readme — 2 file(s), just now")
    expect(engine.listing([group])).toBe("  1. edit readme — 2 file(s), just now")
  })

  test("planLines uses action markers and truncates beyond the limit", () => {
    const make = (path: string, action: "restore" | "delete" | "unchanged" | "skip", note: string, size: number) => ({
      entry: { ts: 0, toolCallId: "t", path, hash: null, size, label: "l" },
      action,
      note
    })
    const plan = [
      make("/a", "restore", "", 2048),
      make("/b", "delete", "", 0),
      make("/c", "unchanged", "already matches", 0)
    ]

    const lines = engine.planLines(plan).split("\n")

    expect(lines[0]).toBe("  ~ /a (2.0 KB)")
    expect(lines[1]).toBe("  - /b")
    expect(lines[2]).toBe("  … and 1 more")
  })

  test("summarize appends failures and escalates severity", () => {
    const ok = engine.summarize({ restored: 1, deleted: 0, unchanged: 0, skipped: 0, failures: [] })
    expect(ok.severity).toBe("info")
    expect(ok.text).toBe("Rewind complete: 1 restored, 0 deleted, 0 unchanged, 0 skipped")

    const bad = engine.summarize({ restored: 0, deleted: 0, unchanged: 0, skipped: 0, failures: ["/x: boom"] })
    expect(bad.severity).toBe("warning")
    expect(bad.text).toContain("Failures:\n  /x: boom")
  })
})

describe("CheckpointPlanner", () => {
  test("expands directories and truncates at maxCheckpointFiles", () => {
    const store = newStore()
    const planner = new CheckpointPlanner(store, config({ maxCheckpointFiles: 2 }))
    mkdirSync(join(workdir, "dir"), { recursive: true })
    writeFileSync(join(workdir, "dir", "1.txt"), "1")
    writeFileSync(join(workdir, "dir", "2.txt"), "2")
    writeFileSync(join(workdir, "dir", "3.txt"), "3")

    const { targets, truncated } = planner.collectTargets(workdir, ["dir"])

    expect(targets).toHaveLength(2)
    expect(truncated).toBe(true)
  })

  test("snapshot summarizes outcomes by category", () => {
    const store = newStore()
    const planner = new CheckpointPlanner(store, config())
    store.ensureSession(join(storageRoot, "manual.jsonl"))

    const file = join(workdir, "real.txt")
    writeFileSync(file, "data")
    mkdirSync(join(workdir, "asdir"))

    const summary = planner.snapshot(
      "manual-1",
      [file, join(workdir, "asdir"), join(workdir, "..", "outside.txt")],
      workdir,
      "manual",
      false
    )

    expect(summary.saved).toBe(1)
    expect(summary.skippedOther).toEqual([join(workdir, "asdir")])
    expect(summary.skippedOutside).toEqual([join(workdir, "..", "outside.txt")])
  })

  test("summaryText composes the message and severity", () => {
    const store = newStore()
    const planner = new CheckpointPlanner(store, config({ maxCheckpointFiles: 500 }))

    const clean = planner.summaryText("label", {
      saved: 3,
      skippedOutside: [],
      skippedLarge: [],
      skippedOther: [],
      failed: [],
      truncated: false
    })
    expect(clean.text).toBe('Checkpoint "label": 3 file(s) saved')
    expect(clean.severity).toBe("info")

    const messy = planner.summaryText("label", {
      saved: 1,
      skippedOutside: ["/a", "/b", "/c", "/d", "/e", "/f"],
      skippedLarge: ["/big"],
      skippedOther: ["/dir"],
      failed: ["/boom"],
      truncated: true
    })
    expect(messy.severity).toBe("warning")
    expect(messy.text).toContain("1 skipped as too large")
    expect(messy.text).toContain("1 skipped as non-regular")
    expect(messy.text).toContain("1 failed")
    expect(messy.text).toContain("file list truncated at 500")
    expect(messy.text).toContain("Skipped (outside cwd):")
    expect(messy.text).toContain("… and 1 more")
  })
})
