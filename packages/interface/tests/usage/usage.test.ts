import { describe, expect, test } from "bun:test"
import { asRecord, emptyTotals, isEmptyTotals, sanitizeTotals, sumModels, toCount, UsageTracker } from "../../src/usage/index.ts"
import { extractUsage, modelIdOf, ratesOf } from "../../src/usage/message.ts"
import type { Counts, Extracted } from "../../src/usage/message.ts"

function assistant(usage: unknown, model?: string): unknown {
  const message: Record<string, unknown> = { role: "assistant", usage }

  if (model !== undefined) {
    message.model = model
  }

  return message
}

function costOf(extracted: Extracted, activeModel: unknown): number {
  if (extracted.embedded !== null) return extracted.embedded

  const rates = ratesOf(activeModel)

  if (!rates) return 0

  return (
    (extracted.counts.input * rates.input +
      extracted.counts.output * rates.output +
      extracted.counts.cacheRead * rates.cacheRead +
      extracted.counts.cacheWrite * rates.cacheWrite) /
    1e6
  )
}

describe("helpers", () => {
  test("toCount coerces to 0 unless finite positive", () => {
    expect(toCount(5)).toBe(5)
    expect(toCount(0)).toBe(0)
    expect(toCount(-1)).toBe(0)
    expect(toCount(Number.NaN)).toBe(0)
    expect(toCount(Infinity)).toBe(0)
    expect(toCount("5")).toBe(0)
    expect(toCount(undefined)).toBe(0)
  })

  test("asRecord rejects arrays, null, primitives", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([1])).toBeNull()
    expect(asRecord(null)).toBeNull()
    expect(asRecord("x")).toBeNull()
  })

  test("emptyTotals and isEmptyTotals", () => {
    expect(isEmptyTotals(emptyTotals())).toBe(true)
    expect(isEmptyTotals({ ...emptyTotals(), input: 1 })).toBe(false)
    expect(isEmptyTotals({ ...emptyTotals(), turns: 1 })).toBe(false)
  })

  test("sanitizeTotals floors turns and clamps counts", () => {
    expect(sanitizeTotals({ input: 5, output: -1, cacheRead: 2, cacheWrite: 0, cost: 1.5, turns: 3.9 })).toEqual({
      input: 5,
      output: 0,
      cacheRead: 2,
      cacheWrite: 0,
      cost: 1.5,
      turns: 3
    })
    expect(sanitizeTotals(null)).toBeNull()
    expect(sanitizeTotals([1])).toBeNull()
  })

  test("sumModels sums all fields including turns", () => {
    const sum = sumModels({
      a: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 },
      b: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 1.5, turns: 2 }
    })

    expect(sum).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 2, turns: 3 })
  })
})

describe("extractUsage", () => {
  test("only assistant messages with usage are extracted", () => {
    expect(extractUsage({ role: "user", usage: { input: 5 } })).toBeNull()
    expect(extractUsage({ role: "assistant" })).toBeNull()
    expect(extractUsage(null)).toBeNull()
  })

  test("drops messages with zero counts and no embedded cost", () => {
    expect(extractUsage(assistant({ input: 0, output: 0 }))).toBeNull()
  })

  test("kept when at least one count is positive", () => {
    const extracted = extractUsage(assistant({ input: 100 }))

    expect(extracted).not.toBeNull()
    expect(extracted?.counts.input).toBe(100)
    expect(extracted?.embedded).toBeNull()
  })

  test("kept when embedded cost present despite zero counts", () => {
    expect(extractUsage(assistant({ cost: 0.25 }))?.embedded).toBe(0.25)
  })

  test("embedded cost accepts numeric .total object", () => {
    expect(extractUsage(assistant({ input: 1, cost: { total: 0.9 } }))?.embedded).toBe(0.9)
  })

  test("embedded cost ignores negative numbers and non-numeric total", () => {
    expect(extractUsage(assistant({ input: 1, cost: -1 }))?.embedded).toBeNull()
    expect(extractUsage(assistant({ input: 1, cost: { total: "x" } }))?.embedded).toBeNull()
  })
})

describe("modelIdOf and ratesOf", () => {
  test("modelId prefers message.model, then activeModel.id, then unknown", () => {
    expect(modelIdOf(assistant({ input: 1 }, "  gpt  "), { id: "claude" })).toBe("gpt")
    expect(modelIdOf(assistant({ input: 1 }), { id: "  claude  " })).toBe("claude")
    expect(modelIdOf(assistant({ input: 1 }), null)).toBe("unknown")
    expect(modelIdOf(assistant({ input: 1 }, "   "), null)).toBe("unknown")
  })

  test("cost prefers embedded over computed", () => {
    const extracted: Extracted = { counts: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, embedded: 0.42 }

    expect(costOf(extracted, { cost: { input: 1 } })).toBe(0.42)
  })

  test("cost computed from rates when no embedded cost", () => {
    const extracted: Extracted = {
      counts: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
      embedded: null
    }

    expect(costOf(extracted, { cost: { input: 3, output: 15 } })).toBeCloseTo(3 + 30, 10)
  })

  test("cost zero when no rates available", () => {
    const extracted: Extracted = { counts: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, embedded: null }

    expect(costOf(extracted, { cost: {} })).toBe(0)
    expect(costOf(extracted, null)).toBe(0)
  })

  test("ratesOf returns null when no usable rates", () => {
    expect(ratesOf(null)).toBeNull()
    expect(ratesOf({})).toBeNull()
    expect(ratesOf({ cost: {} })).toBeNull()

    const rates = ratesOf({ cost: { input: 3, output: 15 } }) as Counts

    expect(rates.input).toBe(3)
    expect(rates.output).toBe(15)
  })
})

describe("UsageTracker record and totals", () => {
  test("records usage and aggregates per model", () => {
    const tracker = new UsageTracker()

    expect(tracker.record(assistant({ input: 100, output: 50, cost: 0.1 }, "m1"), null)).toBe(true)
    expect(tracker.record(assistant({ input: 10, output: 5, cost: 0.02 }, "m1"), null)).toBe(true)
    expect(tracker.record(assistant({ input: 1, cost: 0.5 }, "m2"), null)).toBe(true)

    const snap = tracker.snapshot()

    expect(snap.models.m1.input).toBe(110)
    expect(snap.models.m1.output).toBe(55)
    expect(snap.models.m1.cost).toBeCloseTo(0.12, 10)
    expect(snap.models.m2.cost).toBe(0.5)
    expect(snap.totals.input).toBe(111)
    expect(snap.totals.cost).toBeCloseTo(0.62, 10)
  })

  test("record returns false for non-usable messages", () => {
    const tracker = new UsageTracker()

    expect(tracker.record({ role: "user" }, null)).toBe(false)
    expect(tracker.hasData()).toBe(false)
  })

  test("endTurn increments session turns and per-model turns for touched models", () => {
    const tracker = new UsageTracker()
    tracker.record(assistant({ input: 100 }, "m1"), null)
    tracker.record(assistant({ input: 50 }, "m2"), null)

    const payload = tracker.endTurn("fallback")

    expect(payload.turns).toBe(1)
    expect(payload.model).toBe("m2")
    expect(payload.input).toBe(150)

    const snap = tracker.snapshot()

    expect(snap.models.m1.turns).toBe(1)
    expect(snap.models.m2.turns).toBe(1)
    expect(snap.totals.turns).toBe(1)
  })

  test("a model spanning two turns counts a turn per turn it appears", () => {
    const tracker = new UsageTracker()
    tracker.record(assistant({ input: 1 }, "m1"), null)
    tracker.endTurn("")
    tracker.record(assistant({ input: 1 }, "m1"), null)
    tracker.endTurn("")

    expect(tracker.snapshot().models.m1.turns).toBe(2)
  })

  test("endTurn payload uses fallback then unknown when no model recorded", () => {
    const tracker = new UsageTracker()

    expect(tracker.endTurn("fallback").model).toBe("fallback")

    const fresh = new UsageTracker()

    expect(fresh.endTurn("").model).toBe("unknown")
  })

  test("BusPayload carries cumulative totals across turns", () => {
    const tracker = new UsageTracker()
    tracker.record(assistant({ input: 100 }, "m1"), null)
    tracker.endTurn("")
    tracker.record(assistant({ input: 200 }, "m1"), null)

    const payload = tracker.endTurn("")

    expect(payload.input).toBe(300)
    expect(payload.turns).toBe(2)
  })
})

describe("UsageTracker delta and restore", () => {
  test("delta with no baseline returns full snapshot", () => {
    const tracker = new UsageTracker()
    tracker.record(assistant({ input: 100 }, "m1"), null)
    tracker.endTurn("")

    const delta = tracker.delta()

    expect(delta.models.m1.input).toBe(100)
    expect(delta.totals.turns).toBe(1)
  })

  test("delta subtracts restored baseline and drops empties", () => {
    const tracker = new UsageTracker()
    tracker.restore({ models: { m1: { input: 100, turns: 2 } }, totals: { input: 100, turns: 2 } })

    expect(tracker.hasNewData()).toBe(false)

    tracker.record(assistant({ input: 40 }, "m1"), null)
    tracker.endTurn("")

    const delta = tracker.delta()

    expect(delta.models.m1.input).toBe(40)
    expect(delta.models.m1.turns).toBe(1)
    expect(delta.totals.turns).toBe(1)
    expect(tracker.hasNewData()).toBe(true)
  })

  test("delta drops a model whose values match the baseline exactly", () => {
    const tracker = new UsageTracker()
    tracker.restore({ models: { m1: { input: 100, turns: 1 }, m2: { input: 5, turns: 1 } }, totals: { turns: 2 } })
    tracker.record(assistant({ input: 10 }, "m2"), null)

    const delta = tracker.delta()

    expect(delta.models.m1).toBeUndefined()
    expect(delta.models.m2.input).toBe(10)
  })

  test("restore rejects bad shapes", () => {
    expect(new UsageTracker().restore(null)).toBe(false)
    expect(new UsageTracker().restore({})).toBe(false)
    expect(new UsageTracker().restore({ models: {}, totals: { turns: 0 } })).toBe(false)
    expect(new UsageTracker().restore({ models: { "": { input: 5 } } })).toBe(false)
  })

  test("restore accepts models-only snapshot and computes turns", () => {
    const tracker = new UsageTracker()

    expect(tracker.restore({ models: { m1: { input: 5, turns: 3 } } })).toBe(true)

    const snap = tracker.snapshot()

    expect(snap.models.m1.input).toBe(5)
    expect(snap.totals.turns).toBe(3)
  })

  test("restore accepts totals-only snapshot with turns and no models", () => {
    const tracker = new UsageTracker()

    expect(tracker.restore({ models: {}, totals: { turns: 4 } })).toBe(true)
    expect(tracker.snapshot().totals.turns).toBe(4)
  })

  test("restore turns is max of totals.turns and per-model max", () => {
    const tracker = new UsageTracker()
    tracker.restore({ models: { m1: { input: 1, turns: 9 } }, totals: { turns: 2 } })

    expect(tracker.snapshot().totals.turns).toBe(9)
  })

  test("reset clears everything", () => {
    const tracker = new UsageTracker()
    tracker.record(assistant({ input: 100 }, "m1"), null)
    tracker.endTurn("")
    tracker.reset()

    expect(tracker.hasData()).toBe(false)
    expect(isEmptyTotals(tracker.totals())).toBe(true)
  })

  test("hasData true when only turns exist", () => {
    const tracker = new UsageTracker()
    tracker.restore({ models: {}, totals: { turns: 1 } })

    expect(tracker.hasData()).toBe(true)
  })
})
