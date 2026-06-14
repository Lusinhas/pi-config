import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tempHome = mkdtempSync(join(tmpdir(), "usage-home-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const sqliteAvailable = (() => {
  try {
    const require = createRequire(import.meta.url)
    require("node:sqlite")

    return true
  } catch {
    return false
  }
})()

const { appendHistory, loadHistory, parseLegacyLine } = await import("../../src/usage/store.ts")

import type { HistoryRecord } from "../../src/usage/store.ts"
import type { ModelTotals } from "../../src/usage/index.ts"

function totals(values: Partial<ModelTotals>): ModelTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...values }
}

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true })
})

describe("appendHistory and loadHistory", () => {
  test.skipIf(!sqliteAvailable)("round-trips a session record with per-model rows", () => {
    const record: HistoryRecord = {
      date: "2026-06-13T10:00:00.000Z",
      sessionFile: "/s.jsonl",
      models: { m1: totals({ input: 100, output: 50, cost: 0.1, turns: 2 }) },
      totals: totals({ input: 100, output: 50, cost: 0.1, turns: 2 })
    }
    appendHistory(record)

    const since = Date.parse("2026-06-13T00:00:00.000Z")
    const loaded = loadHistory(since)

    expect(loaded).not.toBeNull()
    const found = loaded?.find(entry => entry.date === record.date)

    expect(found).toBeDefined()
    expect(found?.sessionFile).toBe("/s.jsonl")
    expect(found?.models.m1.input).toBe(100)
    expect(found?.totals.cost).toBeCloseTo(0.1, 10)
    expect(found?.time).toBe(Date.parse(record.date))
  })

  test.skipIf(!sqliteAvailable)("loadHistory filters by sinceMs and orders by time", () => {
    appendHistory({ date: "2026-03-10T00:00:00.000Z", sessionFile: "", models: {}, totals: totals({ turns: 1 }) })
    appendHistory({ date: "2026-03-12T00:00:00.000Z", sessionFile: "", models: {}, totals: totals({ turns: 1 }) })

    const since = Date.parse("2026-03-11T00:00:00.000Z")
    const upper = Date.parse("2026-03-13T00:00:00.000Z")
    const loaded = loadHistory(since)?.filter(entry => entry.time < upper)

    expect(loaded).toHaveLength(1)
    expect(loaded?.[0].date).toBe("2026-03-12T00:00:00.000Z")
  })

  test.skipIf(!sqliteAvailable)("appendHistory skips records with an unparseable date", () => {
    const before = loadHistory(0)?.length ?? 0
    appendHistory({ date: "not-a-date", sessionFile: "", models: {}, totals: totals({ turns: 1 }) })
    const after = loadHistory(0)?.length ?? 0

    expect(after).toBe(before)
  })

  test.skipIf(sqliteAvailable)("loadHistory returns null when sqlite is unavailable", () => {
    expect(loadHistory(0)).toBeNull()
  })
})

describe("parseLegacyLine", () => {
  test("parses a valid legacy line", () => {
    const record = parseLegacyLine(
      JSON.stringify({
        date: "2026-06-01T00:00:00.000Z",
        sessionFile: "/a.jsonl",
        models: { m1: { input: 10, turns: 1 } },
        totals: { input: 10, turns: 1 }
      })
    )

    expect(record?.date).toBe("2026-06-01T00:00:00.000Z")
    expect(record?.models.m1.input).toBe(10)
  })

  test("falls back totals to sumModels when missing", () => {
    const record = parseLegacyLine(
      JSON.stringify({ date: "2026-06-01T00:00:00.000Z", models: { m1: { input: 7, turns: 1 } } })
    )

    expect(record?.totals.input).toBe(7)
  })

  test("rejects invalid json, missing date, empty content", () => {
    expect(parseLegacyLine("{bad json")).toBeNull()
    expect(parseLegacyLine(JSON.stringify({ models: {} }))).toBeNull()
    expect(parseLegacyLine(JSON.stringify({ date: "x" }))).toBeNull()
    expect(parseLegacyLine(JSON.stringify({ date: "2026-06-01T00:00:00.000Z", models: {}, totals: {} }))).toBeNull()
  })
})
