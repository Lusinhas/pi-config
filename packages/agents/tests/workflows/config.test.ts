import { describe, expect, test } from "bun:test"
import { Config } from "../../src/workflows/index.ts"

describe("Config", () => {
  test("defaults when nothing supplied", () => {
    const config = new Config(undefined)

    expect(config.value).toEqual({ timeoutSec: 1800, maxAgents: 250 })
  })

  test("shipped record overrides defaults", () => {
    const config = new Config({ timeoutSec: 600, maxAgents: 50 })

    expect(config.value).toEqual({ timeoutSec: 600, maxAgents: 50 })
  })

  test("later overrides win over earlier (project beats user)", () => {
    const config = new Config({ timeoutSec: 1800, maxAgents: 250 }, { maxAgents: 100 }, { maxAgents: 42 })

    expect(config.value.maxAgents).toBe(42)
    expect(config.value.timeoutSec).toBe(1800)
  })

  test("non-record overrides are ignored", () => {
    const config = new Config({ timeoutSec: 900 }, null, [1, 2], "x", { maxAgents: 7 })

    expect(config.value).toEqual({ timeoutSec: 900, maxAgents: 7 })
  })

  test("invalid scalar values fall back to default for that key", () => {
    const config = new Config({ timeoutSec: "nope", maxAgents: Number.NaN })

    expect(config.value).toEqual({ timeoutSec: 1800, maxAgents: 250 })
  })

  test("toCount floors and clamps to minimum 1", () => {
    const config = new Config({ timeoutSec: 0, maxAgents: 3.9 })

    expect(config.value.timeoutSec).toBe(1)
    expect(config.value.maxAgents).toBe(3)
  })

  test("negative coerces to minimum", () => {
    expect(Config.toCount(-5, 100, 1)).toBe(1)
  })

  test("infinity falls back", () => {
    expect(Config.toCount(Number.POSITIVE_INFINITY, 100, 1)).toBe(100)
  })

  test("section extracts workflows key only", () => {
    expect(Config.section({ workflows: { maxAgents: 9 }, other: 1 })).toEqual({ maxAgents: 9 })
    expect(Config.section({ nothing: true })).toBeUndefined()
    expect(Config.section([1, 2])).toBeUndefined()
    expect(Config.section("x")).toBeUndefined()
  })

  test("shallow merge does not deepen nested objects", () => {
    const config = new Config({ timeoutSec: 1800, maxAgents: 250 }, { maxAgents: 5, extra: { nested: 1 } })

    expect(config.value).toEqual({ timeoutSec: 1800, maxAgents: 5 })
  })

  test("unknown keys are dropped from the effective config", () => {
    const config = new Config({ timeoutSec: 100, maxAgents: 10, bogus: "x" } as Record<string, unknown>)

    expect(Object.keys(config.value).sort()).toEqual(["maxAgents", "timeoutSec"])
  })
})
