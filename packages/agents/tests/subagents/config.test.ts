import { describe, expect, test } from "bun:test"
import { Config, DEFAULT_CONFIG } from "../../src/subagents/config.ts"

describe("Config.isRecord", () => {
  test("accepts plain objects only", () => {
    expect(Config.isRecord({})).toBe(true)
    expect(Config.isRecord({ a: 1 })).toBe(true)
  })

  test("rejects null, arrays, and primitives", () => {
    expect(Config.isRecord(null)).toBe(false)
    expect(Config.isRecord([])).toBe(false)
    expect(Config.isRecord("x")).toBe(false)
    expect(Config.isRecord(7)).toBe(false)
  })
})

describe("Config.toCount", () => {
  test("floors finite numbers and clamps to the minimum", () => {
    expect(Config.toCount(12.9, 4, 1)).toBe(12)
    expect(Config.toCount(0, 4, 1)).toBe(1)
    expect(Config.toCount(-5, 4, 0)).toBe(0)
  })

  test("falls back for non-numbers and non-finite values", () => {
    expect(Config.toCount("8", 4, 1)).toBe(4)
    expect(Config.toCount(Number.NaN, 4, 1)).toBe(4)
    expect(Config.toCount(Number.POSITIVE_INFINITY, 4, 1)).toBe(4)
    expect(Config.toCount(undefined, 4, 1)).toBe(4)
  })

  test("allows zero when the minimum is zero", () => {
    expect(Config.toCount(0, 32, 0)).toBe(0)
  })
})

describe("Config.deepMerge", () => {
  test("recursively merges nested records", () => {
    const merged = Config.deepMerge({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 9, z: 4 } })
    expect(merged).toEqual({ a: { x: 1, y: 9, z: 4 }, b: 3 })
  })

  test("ignores undefined override values", () => {
    const merged = Config.deepMerge({ a: 1 }, { a: undefined })
    expect(merged).toEqual({ a: 1 })
  })

  test("replaces non-record values", () => {
    const merged = Config.deepMerge({ a: { x: 1 } }, { a: 5 })
    expect(merged).toEqual({ a: 5 })
  })
})

describe("Config.section", () => {
  test("returns the subagents section when present", () => {
    expect(Config.section({ subagents: { maxDepth: 1 } })).toEqual({ maxDepth: 1 })
  })

  test("returns null when missing or not a record", () => {
    expect(Config.section(null)).toBeNull()
    expect(Config.section({})).toBeNull()
    expect(Config.section({ subagents: 5 })).toBeNull()
  })
})

describe("Config.normalize", () => {
  test("produces the shipped defaults from an empty object", () => {
    expect(Config.normalize({})).toEqual(DEFAULT_CONFIG)
  })

  test("only literal false disables the widget", () => {
    expect(Config.normalize({ widget: false }).widget).toBe(false)
    expect(Config.normalize({ widget: 0 }).widget).toBe(true)
    expect(Config.normalize({ widget: "no" }).widget).toBe(true)
    expect(Config.normalize({}).widget).toBe(true)
  })

  test("keeps advisor strings only when they are strings", () => {
    expect(Config.normalize({ advisorModel: "anthropic/x" }).advisorModel).toBe("anthropic/x")
    expect(Config.normalize({ advisorModel: 5 }).advisorModel).toBe("")
    expect(Config.normalize({ advisorThinking: "low" }).advisorThinking).toBe("low")
    expect(Config.normalize({ advisorThinking: 5 }).advisorThinking).toBe("xhigh")
  })

  test("falls back to an empty teams object when invalid", () => {
    expect(Config.normalize({ teams: [] }).teams).toEqual({})
    expect(Config.normalize({ teams: "x" }).teams).toEqual({})
    expect(Config.normalize({ teams: { a: ["coder"] } }).teams).toEqual({ a: ["coder"] })
  })

  test("clamps numeric minimums per key", () => {
    const normalized = Config.normalize({ maxConcurrent: 0, maxDepth: -1, advisorContextChars: 10, transcriptLimit: 1, activityChars: 1, widgetLimit: 0 })
    expect(normalized.maxConcurrent).toBe(1)
    expect(normalized.maxDepth).toBe(0)
    expect(normalized.advisorContextChars).toBe(1000)
    expect(normalized.transcriptLimit).toBe(10)
    expect(normalized.activityChars).toBe(20)
    expect(normalized.widgetLimit).toBe(1)
  })
})

describe("Config.fromLayers", () => {
  test("project overrides home overrides shipped", () => {
    const result = Config.fromLayers(
      { maxDepth: 2, maxConcurrent: 8, advisorModel: "shipped" },
      { subagents: { maxConcurrent: 5, advisorModel: "home" } },
      { subagents: { advisorModel: "project" } }
    )
    expect(result.maxDepth).toBe(2)
    expect(result.maxConcurrent).toBe(5)
    expect(result.advisorModel).toBe("project")
  })

  test("ignores layers without a subagents section", () => {
    const result = Config.fromLayers({ maxConcurrent: 4 }, { other: { maxConcurrent: 99 } }, null)
    expect(result.maxConcurrent).toBe(4)
  })

  test("deep merges nested teams across layers", () => {
    const result = Config.fromLayers(
      { teams: { a: ["coder"] } },
      { subagents: { teams: { b: ["tester"] } } },
      null
    )
    expect(result.teams).toEqual({ a: ["coder"], b: ["tester"] })
  })
})
