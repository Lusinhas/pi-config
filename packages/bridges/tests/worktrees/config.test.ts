import { describe, expect, test } from "bun:test"
import { Config, FALLBACK } from "../../src/worktrees/render.ts"

describe("Config.overlayFrom", () => {
  test("extracts the worktrees section from a plain object", () => {
    expect(Config.overlayFrom({ worktrees: { dir: "wt" } })).toEqual({ dir: "wt" })
  })

  test("returns undefined for arrays, primitives, and null", () => {
    expect(Config.overlayFrom([1, 2])).toBeUndefined()
    expect(Config.overlayFrom("string")).toBeUndefined()
    expect(Config.overlayFrom(null)).toBeUndefined()
    expect(Config.overlayFrom(undefined)).toBeUndefined()
  })
})

describe("Config.deepMerge", () => {
  test("merges nested objects recursively", () => {
    const merged = Config.deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } })
    expect(merged).toEqual({ a: { x: 1, y: 3 } })
  })

  test("arrays replace rather than merge", () => {
    const merged = Config.deepMerge({ list: [1, 2, 3] }, { list: [9] })
    expect(merged).toEqual({ list: [9] })
  })

  test("undefined values are skipped", () => {
    const merged = Config.deepMerge({ keep: 1 }, { keep: undefined })
    expect(merged).toEqual({ keep: 1 })
  })

  test("non-object overrides leave base untouched", () => {
    expect(Config.deepMerge({ a: 1 }, null)).toEqual({ a: 1 })
    expect(Config.deepMerge({ a: 1 }, "nope")).toEqual({ a: 1 })
    expect(Config.deepMerge({ a: 1 }, [1])).toEqual({ a: 1 })
  })
})

describe("Config defaults and sanitize", () => {
  test("empty layers produce the shipped fallback", () => {
    expect(new Config([]).value).toEqual(FALLBACK)
  })

  test("project layer wins over home layer over shipped", () => {
    const value = new Config([
      { dir: "shipped" },
      { dir: "home" },
      { dir: "project" }
    ]).value
    expect(value.dir).toBe("project")
  })

  test("trims string values and falls back when blank", () => {
    const value = new Config([{ dir: "  custom  ", includeFile: "   " }]).value
    expect(value.dir).toBe("custom")
    expect(value.includeFile).toBe(FALLBACK.includeFile)
  })

  test("branchPrefix matching the pattern is kept", () => {
    expect(new Config([{ branchPrefix: "feature/" }]).value.branchPrefix).toBe("feature/")
    expect(new Config([{ branchPrefix: "wt_" }]).value.branchPrefix).toBe("wt_")
  })

  test("branchPrefix failing the pattern falls back, including empty string", () => {
    expect(new Config([{ branchPrefix: "" }]).value.branchPrefix).toBe(FALLBACK.branchPrefix)
    expect(new Config([{ branchPrefix: "/leading-slash" }]).value.branchPrefix).toBe(FALLBACK.branchPrefix)
    expect(new Config([{ branchPrefix: "has space" }]).value.branchPrefix).toBe(FALLBACK.branchPrefix)
  })

  test("booleans coerce only real booleans", () => {
    expect(new Config([{ allowSpawn: true, confirmRemove: false }]).value.allowSpawn).toBe(true)
    expect(new Config([{ confirmRemove: false }]).value.confirmRemove).toBe(false)
    expect(new Config([{ allowSpawn: "yes" }]).value.allowSpawn).toBe(FALLBACK.allowSpawn)
  })

  test("numbers must be finite, positive, and are floored", () => {
    expect(new Config([{ maxIncludeFiles: 12.9 }]).value.maxIncludeFiles).toBe(12)
    expect(new Config([{ gitTimeoutMs: 0 }]).value.gitTimeoutMs).toBe(FALLBACK.gitTimeoutMs)
    expect(new Config([{ maxIncludeFiles: -5 }]).value.maxIncludeFiles).toBe(FALLBACK.maxIncludeFiles)
    expect(new Config([{ gitTimeoutMs: Number.POSITIVE_INFINITY }]).value.gitTimeoutMs).toBe(FALLBACK.gitTimeoutMs)
    expect(new Config([{ maxIncludeFiles: "100" }]).value.maxIncludeFiles).toBe(FALLBACK.maxIncludeFiles)
  })
})
