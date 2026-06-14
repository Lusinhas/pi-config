import { describe, expect, test } from "bun:test"
import { formatCost, humanTokens, renderTable } from "../../src/usage/table.ts"
import { renderSession } from "../../src/usage/report.ts"
import { aggregate, dayKey, statRow } from "../../src/usage/aggregate.ts"
import type { SessionSnapshot, ModelTotals } from "../../src/usage/index.ts"
import type { HistoryEntry } from "../../src/usage/store.ts"

function totals(values: Partial<ModelTotals>): ModelTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...values }
}

function entry(time: number, models: Record<string, ModelTotals>, t: ModelTotals): HistoryEntry {
  return { time, date: new Date(time).toISOString(), sessionFile: "", models, totals: t }
}

describe("humanTokens", () => {
  test("below 1000 is rounded integer", () => {
    expect(humanTokens(0)).toBe("0")
    expect(humanTokens(999)).toBe("999")
    expect(humanTokens(12.6)).toBe("13")
  })

  test("thousands suffixed with k and trailing zeros stripped", () => {
    expect(humanTokens(1000)).toBe("1k")
    expect(humanTokens(1500)).toBe("1.5k")
    expect(humanTokens(12_340)).toBe("12.3k")
    expect(humanTokens(123_400)).toBe("123k")
  })

  test("millions suffixed with M", () => {
    expect(humanTokens(1_000_000)).toBe("1M")
    expect(humanTokens(2_500_000)).toBe("2.5M")
  })

  test("non-positive and non-finite coerced to 0", () => {
    expect(humanTokens(-5)).toBe("0")
    expect(humanTokens(Number.NaN)).toBe("0")
  })
})

describe("formatCost", () => {
  test("formats with the requested decimals", () => {
    expect(formatCost(1.23456, 4)).toBe("$1.2346")
    expect(formatCost(1.23456, 2)).toBe("$1.23")
    expect(formatCost(1.23456, 0)).toBe("$1")
  })

  test("non-positive or non-finite renders as zero", () => {
    expect(formatCost(0, 4)).toBe("$0.0000")
    expect(formatCost(-3, 2)).toBe("$0.00")
    expect(formatCost(Number.NaN, 2)).toBe("$0.00")
  })
})

describe("renderTable", () => {
  test("widths, divider, padding, and trimEnd", () => {
    const table = renderTable(["model", "input"], [["m1", "5"], ["longmodel", "100"]], [false, true])
    const lines = table.split("\n")

    expect(lines[0]).toBe("model      input")
    expect(lines[1]).toBe("---------  -----")
    expect(lines[2]).toBe("m1             5")
    expect(lines[3]).toBe("longmodel    100")
  })
})

describe("renderSession", () => {
  test("empty session message", () => {
    const snapshot: SessionSnapshot = { models: {}, totals: totals({}), updatedAt: "" }

    expect(renderSession(snapshot, 4)).toBe("No usage recorded in this session yet.")
  })

  test("renders header, table, total row, sorted by cost desc then id", () => {
    const snapshot: SessionSnapshot = {
      models: {
        b: totals({ input: 100, cost: 0.2, turns: 1 }),
        a: totals({ input: 200, cost: 0.5, turns: 2 }),
        c: totals({ input: 50, cost: 0.2, turns: 1 })
      },
      totals: totals({ input: 350, cost: 0.9, turns: 4 }),
      updatedAt: ""
    }
    const lines = renderSession(snapshot, 4).split("\n")

    expect(lines[0]).toBe("Session usage")
    expect(lines[1]).toBe("")
    expect(lines[2].trimEnd().startsWith("model")).toBe(true)

    const dataLines = lines.slice(4)

    expect(dataLines[0].startsWith("a")).toBe(true)
    expect(dataLines[1].startsWith("b")).toBe(true)
    expect(dataLines[2].startsWith("c")).toBe(true)
    expect(dataLines[3].startsWith("total")).toBe(true)
  })
})

describe("aggregate", () => {
  test("dayKey formats local date with zero padding", () => {
    expect(dayKey(new Date(2026, 5, 1, 9, 0, 0))).toBe("2026-06-01")
    expect(dayKey(new Date(2026, 11, 31, 23, 0, 0))).toBe("2026-12-31")
  })

  test("statRow prefixes label and session count before usage cells", () => {
    const row = statRow("total", { sessions: 3, totals: totals({ input: 1000, cost: 0.5, turns: 2 }) }, 4)

    expect(row[0]).toBe("total")
    expect(row[1]).toBe("3")
    expect(row[2]).toBe("1k")
    expect(row[row.length - 1]).toBe("2")
  })

  test("aggregates by day and by model with overall totals", () => {
    const dayA = new Date(2026, 5, 10, 9, 0, 0).getTime()
    const dayB = new Date(2026, 5, 12, 9, 0, 0).getTime()
    const { daily, byModel, overall } = aggregate([
      entry(dayA, { m1: totals({ input: 100, cost: 0.5, turns: 1 }) }, totals({ input: 100, cost: 0.5, turns: 1 })),
      entry(dayB, { m2: totals({ input: 200, cost: 0.9, turns: 1 }) }, totals({ input: 200, cost: 0.9, turns: 1 })),
      entry(dayB, { m1: totals({ input: 50, cost: 0.1, turns: 1 }) }, totals({ input: 50, cost: 0.1, turns: 1 }))
    ])

    const dayKeys = [...daily.keys()].sort((a, b) => a.localeCompare(b))

    expect(dayKeys).toEqual(["2026-06-10", "2026-06-12"])
    expect(daily.get("2026-06-12")?.sessions).toBe(2)
    expect(daily.get("2026-06-12")?.totals.input).toBe(250)

    const modelKeys = [...byModel.entries()].sort((a, b) => b[1].totals.cost - a[1].totals.cost || a[0].localeCompare(b[0]))

    expect(modelKeys[0][0]).toBe("m2")
    expect(modelKeys[1][0]).toBe("m1")
    expect(byModel.get("m1")?.totals.input).toBe(150)

    expect(overall.sessions).toBe(3)
    expect(overall.totals.input).toBe(350)
    expect(overall.totals.cost).toBeCloseTo(1.5, 10)
  })

  test("model rows sort by cost desc then id for tie-breaks", () => {
    const t = new Date(2026, 5, 11, 12, 0, 0).getTime()
    const { byModel } = aggregate([
      entry(t, { z: totals({ cost: 0.3, turns: 1 }), a: totals({ cost: 0.3, turns: 1 }) }, totals({ cost: 0.6, turns: 1 }))
    ])
    const ordered = [...byModel.entries()]
      .sort((a, b) => b[1].totals.cost - a[1].totals.cost || a[0].localeCompare(b[0]))
      .map(([id]) => id)

    expect(ordered).toEqual(["a", "z"])
  })
})
