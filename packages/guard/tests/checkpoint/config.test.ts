import { describe, expect, test } from "bun:test"
import { Config, FALLBACK } from "../../src/checkpoint/config.ts"

describe("Config defaults and merge", () => {
  test("empty layers yield the fallback defaults", () => {
    const config = new Config([]).value

    expect(config.maxMb).toBe(200)
    expect(config.maxAgeDays).toBe(30)
    expect(config.labelMaxChars).toBe(64)
    expect(config.maxFileMb).toBe(25)
    expect(config.maxBashFiles).toBe(20)
    expect(config.maxCheckpointFiles).toBe(500)
    expect(config.confirmListLimit).toBe(20)
    expect(config.bashPatterns).toHaveLength(29)
  })

  test("FALLBACK matches the canonical pattern list", () => {
    expect(FALLBACK.bashPatterns).toHaveLength(29)
    expect(FALLBACK.bashPatterns[0]).toBe("\\brm\\s")
    expect(FALLBACK.bashPatterns).toContain("\\bcargo\\s+fmt\\b")
  })

  test("later layers win over earlier layers", () => {
    const config = new Config([{ maxMb: 100 }, { maxMb: 50 }]).value

    expect(config.maxMb).toBe(50)
  })

  test("nested plain objects merge while arrays replace wholesale", () => {
    const merged = Config.deepMerge(
      { a: { x: 1, y: 2 }, list: [1, 2, 3] },
      { a: { y: 9, z: 3 }, list: [4] }
    )

    expect(merged.a).toEqual({ x: 1, y: 9, z: 3 })
    expect(merged.list).toEqual([4])
  })

  test("undefined override values are skipped", () => {
    const merged = Config.deepMerge({ a: 1 }, { a: undefined, b: 2 })

    expect(merged.a).toBe(1)
    expect(merged.b).toBe(2)
  })

  test("non-object override leaves base untouched", () => {
    expect(Config.deepMerge({ a: 1 }, null)).toEqual({ a: 1 })
    expect(Config.deepMerge({ a: 1 }, [1, 2])).toEqual({ a: 1 })
    expect(Config.deepMerge({ a: 1 }, "x")).toEqual({ a: 1 })
  })
})

describe("Config sanitization", () => {
  test("non-positive and non-finite numbers fall back per key", () => {
    const result = new Config([
      { maxMb: 0, maxAgeDays: -5, labelMaxChars: Number.NaN, maxFileMb: Infinity }
    ])

    expect(result.value.maxMb).toBe(200)
    expect(result.value.maxAgeDays).toBe(30)
    expect(result.value.labelMaxChars).toBe(64)
    expect(result.value.maxFileMb).toBe(25)
    expect(result.diagnostics.fellBack).toContain("maxMb")
    expect(result.diagnostics.fellBack).toContain("maxAgeDays")
    expect(result.diagnostics.fellBack).toContain("labelMaxChars")
    expect(result.diagnostics.fellBack).toContain("maxFileMb")
  })

  test("valid positive numbers are kept and not recorded as fallbacks", () => {
    const result = new Config([{ maxMb: 12, confirmListLimit: 3 }])

    expect(result.value.maxMb).toBe(12)
    expect(result.value.confirmListLimit).toBe(3)
    expect(result.diagnostics.fellBack).not.toContain("maxMb")
    expect(result.diagnostics.fellBack).not.toContain("confirmListLimit")
  })

  test("bashPatterns keeps only string entries", () => {
    const result = new Config([{ bashPatterns: ["a", 5, "b", null, "c"] }])

    expect(result.value.bashPatterns).toEqual(["a", "b", "c"])
    expect(result.diagnostics.fellBack).not.toContain("bashPatterns")
  })

  test("non-array bashPatterns falls back to the canonical list", () => {
    const result = new Config([{ bashPatterns: "rm" }])

    expect(result.value.bashPatterns).toHaveLength(29)
    expect(result.diagnostics.fellBack).toContain("bashPatterns")
  })

  test("overlayFrom extracts the checkpoint section", () => {
    expect(Config.overlayFrom({ checkpoint: { maxMb: 7 } })).toEqual({ maxMb: 7 })
    expect(Config.overlayFrom({ other: 1 })).toBeUndefined()
    expect(Config.overlayFrom([1, 2])).toBeUndefined()
    expect(Config.overlayFrom("x")).toBeUndefined()
    expect(Config.overlayFrom(undefined)).toBeUndefined()
  })

  test("shipped over home over project merge order is preserved", () => {
    const shipped = { maxMb: 200, maxFileMb: 25 }
    const home = { maxMb: 100 }
    const project = { maxMb: 50 }
    const config = new Config([shipped, home, project]).value

    expect(config.maxMb).toBe(50)
    expect(config.maxFileMb).toBe(25)
  })
})
