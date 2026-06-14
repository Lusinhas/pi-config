import { describe, expect, test } from "bun:test"
import { deepMerge, FALLBACK, overlayFrom, sanitizeConfig } from "../../src/usage/config.ts"

function fromLayers(layers: unknown[]): { statsDays: number; costDecimals: number; fellBack: string[] } {
  let merged: Record<string, unknown> = { ...FALLBACK }

  for (const layer of layers) merged = deepMerge(merged, layer)

  const result = sanitizeConfig(merged)

  return { ...result.value, fellBack: result.fellBack }
}

describe("Config defaults and merge", () => {
  test("empty layers yield the fallback defaults", () => {
    const config = fromLayers([])

    expect(config.statsDays).toBe(30)
    expect(config.costDecimals).toBe(4)
  })

  test("FALLBACK matches the original byte-for-byte", () => {
    expect(FALLBACK).toEqual({ statsDays: 30, costDecimals: 4 })
  })

  test("later layers win over earlier layers", () => {
    expect(fromLayers([{ statsDays: 7 }, { statsDays: 14 }]).statsDays).toBe(14)
  })

  test("shipped over home over project merge order", () => {
    const shipped = { statsDays: 30, costDecimals: 4 }
    const home = { statsDays: 10 }
    const project = { statsDays: 5 }
    const config = fromLayers([shipped, home, project])

    expect(config.statsDays).toBe(5)
    expect(config.costDecimals).toBe(4)
  })

  test("undefined override values are skipped", () => {
    const merged = deepMerge({ a: 1 }, { a: undefined, b: 2 })

    expect(merged.a).toBe(1)
    expect(merged.b).toBe(2)
  })

  test("nested plain objects merge while arrays replace wholesale", () => {
    const merged = deepMerge({ a: { x: 1, y: 2 }, list: [1, 2, 3] }, { a: { y: 9, z: 3 }, list: [4] })

    expect(merged.a).toEqual({ x: 1, y: 9, z: 3 })
    expect(merged.list).toEqual([4])
  })

  test("non-object override leaves base untouched", () => {
    expect(deepMerge({ a: 1 }, null)).toEqual({ a: 1 })
    expect(deepMerge({ a: 1 }, [1, 2])).toEqual({ a: 1 })
    expect(deepMerge({ a: 1 }, "x")).toEqual({ a: 1 })
  })

  test("overlayFrom extracts the usage section only", () => {
    expect(overlayFrom({ usage: { statsDays: 7 } })).toEqual({ statsDays: 7 })
    expect(overlayFrom({ other: 1 })).toBeUndefined()
    expect(overlayFrom([1, 2])).toBeUndefined()
    expect(overlayFrom("x")).toBeUndefined()
    expect(overlayFrom(undefined)).toBeUndefined()
  })
})

describe("Config statsDays validation", () => {
  test("valid integer kept", () => {
    expect(fromLayers([{ statsDays: 90 }]).statsDays).toBe(90)
  })

  test("fractional value floored", () => {
    const result = fromLayers([{ statsDays: 12.9 }])

    expect(result.statsDays).toBe(12)
    expect(result.fellBack).not.toContain("statsDays")
  })

  test("value below 1 falls back", () => {
    const result = fromLayers([{ statsDays: 0 }])

    expect(result.statsDays).toBe(30)
    expect(result.fellBack).toContain("statsDays")
  })

  test("negative, NaN, Infinity, and non-number fall back", () => {
    expect(fromLayers([{ statsDays: -3 }]).statsDays).toBe(30)
    expect(fromLayers([{ statsDays: Number.NaN }]).statsDays).toBe(30)
    expect(fromLayers([{ statsDays: Infinity }]).statsDays).toBe(30)
    expect(fromLayers([{ statsDays: "10" }]).statsDays).toBe(30)
  })

  test("exactly 1 is accepted", () => {
    expect(fromLayers([{ statsDays: 1 }]).statsDays).toBe(1)
  })
})

describe("Config costDecimals validation", () => {
  test("valid integer kept", () => {
    expect(fromLayers([{ costDecimals: 2 }]).costDecimals).toBe(2)
  })

  test("zero is accepted", () => {
    const result = fromLayers([{ costDecimals: 0 }])

    expect(result.costDecimals).toBe(0)
    expect(result.fellBack).not.toContain("costDecimals")
  })

  test("eight is accepted, nine falls back", () => {
    expect(fromLayers([{ costDecimals: 8 }]).costDecimals).toBe(8)
    expect(fromLayers([{ costDecimals: 9 }]).costDecimals).toBe(4)
  })

  test("fractional floored", () => {
    expect(fromLayers([{ costDecimals: 5.7 }]).costDecimals).toBe(5)
  })

  test("negative, NaN, non-number fall back", () => {
    expect(fromLayers([{ costDecimals: -1 }]).costDecimals).toBe(4)
    expect(fromLayers([{ costDecimals: Number.NaN }]).costDecimals).toBe(4)
    expect(fromLayers([{ costDecimals: null }]).costDecimals).toBe(4)
  })
})
