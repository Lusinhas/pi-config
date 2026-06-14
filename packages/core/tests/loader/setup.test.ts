import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SetupPlanner } from "../../src/loader/setup.ts"
import type { ResourceRecord } from "../../src/loader/index.ts"

function themeResource(path: string): ResourceRecord {
  return {
    kind: "theme",
    path,
    contentPath: path,
    relativePath: path,
  }
}

describe("SetupPlanner.nextSuite", () => {
  const planner = new SetupPlanner()

  test("does nothing when there is no stale theme and no chosen mode", () => {
    const plan = planner.nextSuite({ permissions: { mode: "ask" } }, undefined)
    expect(plan.written).toEqual([])
    expect(plan.kept).toEqual([])
    expect(plan.next).toEqual({ permissions: { mode: "ask" } })
  })

  test("removes a stale loader.theme and drops the loader section when it empties", () => {
    const plan = planner.nextSuite({ loader: { theme: "old" } }, undefined)
    expect(plan.written).toEqual(["removed stale loader.theme (the theme now persists in settings.json)"])
    expect(plan.next).toEqual({})
  })

  test("removes loader.theme but keeps other loader keys", () => {
    const plan = planner.nextSuite({ loader: { theme: "old", prompts: false } }, undefined)
    expect(plan.next).toEqual({ loader: { prompts: false } })
    expect(plan.written).toContain("removed stale loader.theme (the theme now persists in settings.json)")
  })

  test("sets a new permissions.mode", () => {
    const plan = planner.nextSuite({}, "yolo")
    expect(plan.next).toEqual({ permissions: { mode: "yolo" } })
    expect(plan.written).toEqual(['permissions.mode = "yolo"'])
    expect(plan.kept).toEqual([])
  })

  test("keeps an already-matching permissions.mode", () => {
    const plan = planner.nextSuite({ permissions: { mode: "auto" } }, "auto")
    expect(plan.written).toEqual([])
    expect(plan.kept).toEqual(['permissions.mode already "auto"'])
  })

  test("preserves sibling permission keys when changing the mode", () => {
    const plan = planner.nextSuite({ permissions: { mode: "ask", extra: 1 } }, "write")
    expect(plan.next).toEqual({ permissions: { mode: "write", extra: 1 } })
  })

  test("does not mutate the input object", () => {
    const existing = { loader: { theme: "old" }, permissions: { mode: "ask" } }
    planner.nextSuite(existing, "auto")
    expect(existing).toEqual({ loader: { theme: "old" }, permissions: { mode: "ask" } })
  })

  test("combines theme removal and mode change", () => {
    const plan = planner.nextSuite({ loader: { theme: "old" }, permissions: { mode: "ask" } }, "yolo")
    expect(plan.next).toEqual({ permissions: { mode: "yolo" } })
    expect(plan.written).toEqual([
      "removed stale loader.theme (the theme now persists in settings.json)",
      'permissions.mode = "yolo"'
    ])
  })
})

describe("SetupPlanner.themeChoices", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loader-setup-"))
    mkdirSync(join(root, "themes"), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("prefers the JSON name field, falls back to the file basename", () => {
    const dark = join(root, "themes", "dark.json")
    const plain = join(root, "themes", "plain.json")
    const broken = join(root, "themes", "broken.json")
    writeFileSync(dark, JSON.stringify({ name: "Midnight" }))
    writeFileSync(plain, JSON.stringify({ colors: {} }))
    writeFileSync(broken, "{not json")
    const choices = new SetupPlanner().themeChoices([themeResource(dark), themeResource(plain), themeResource(broken)])
    expect(choices).toEqual(["Midnight", "broken", "plain"])
  })

  test("deduplicates and sorts theme names", () => {
    const a = join(root, "themes", "a.json")
    const b = join(root, "themes", "b.json")
    writeFileSync(a, JSON.stringify({ name: "Same" }))
    writeFileSync(b, JSON.stringify({ name: "Same" }))
    expect(new SetupPlanner().themeChoices([themeResource(a), themeResource(b)])).toEqual(["Same"])
  })

  test("returns an empty list when there are no resources", () => {
    expect(new SetupPlanner().themeChoices([])).toEqual([])
  })
})
