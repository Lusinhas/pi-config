import { describe, expect, test } from "bun:test"
import { Config } from "../../src/syntax/settings.ts"

describe("Config.resolve", () => {
  test("returns shipped defaults when no overlays", () => {
    const config = new Config([]).resolve()

    expect(config.fileLimit).toBe(2000)
    expect(config.defaultLimit).toBe(50)
    expect(config.contextLines).toBe(2)
    expect(config.maxHunks).toBe(20)
    expect(config.maxFileBytes).toBe(1048576)
    expect(config.maxStaged).toBe(8)
    expect(config.execTimeout).toBe(10000)
    expect(config.protectGlobs).toContain("**/node_modules/**")
    expect(config.langMap.ts).toBe("TypeScript")
    expect(config.langMap.tsx).toBe("Tsx")
  })

  test("project layer wins over user layer", () => {
    const config = new Config([{ fileLimit: 100 }, { fileLimit: 200 }]).resolve()

    expect(config.fileLimit).toBe(200)
  })

  test("deep-merges langMap entries", () => {
    const config = new Config([{ langMap: { foo: "Foo" } }]).resolve()

    expect(config.langMap.foo).toBe("Foo")
    expect(config.langMap.ts).toBe("TypeScript")
  })

  test("clamps numeric values to range", () => {
    const config = new Config([
      { fileLimit: 0, defaultLimit: 99999, contextLines: -5, maxFileBytes: 1, execTimeout: 999999999 }
    ]).resolve()

    expect(config.fileLimit).toBe(1)
    expect(config.defaultLimit).toBe(1000)
    expect(config.contextLines).toBe(0)
    expect(config.maxFileBytes).toBe(1024)
    expect(config.execTimeout).toBe(120000)
  })

  test("floors fractional numbers", () => {
    const config = new Config([{ defaultLimit: 12.9 }]).resolve()

    expect(config.defaultLimit).toBe(12)
  })

  test("falls back per-key for non-numeric and non-finite", () => {
    const config = new Config([{ fileLimit: "lots", contextLines: Number.POSITIVE_INFINITY }]).resolve()

    expect(config.fileLimit).toBe(2000)
    expect(config.contextLines).toBe(2)
  })

  test("protectGlobs empty array disables protection", () => {
    const config = new Config([{ protectGlobs: [] }]).resolve()

    expect(config.protectGlobs).toEqual([])
  })

  test("protectGlobs filters non-string and blank entries", () => {
    const config = new Config([{ protectGlobs: ["**/a/**", 5, "", "  ", "**/b/**"] }]).resolve()

    expect(config.protectGlobs).toEqual(["**/a/**", "**/b/**"])
  })

  test("protectGlobs non-array falls back to default", () => {
    const config = new Config([{ protectGlobs: "nope" }]).resolve()

    expect(config.protectGlobs).toContain("**/node_modules/**")
  })

  test("langMap lowercases and trims keys and values", () => {
    const config = new Config([{ langMap: { "  TS ": "  TypeScript  ", JS: "JavaScript" } }]).resolve()

    expect(config.langMap.ts).toBe("TypeScript")
    expect(config.langMap.js).toBe("JavaScript")
  })

  test("langMap drops empty key or value entries", () => {
    const config = new Config([{ langMap: { good: "Good", "": "Bad", bad: "" } }]).resolve()

    expect(config.langMap.good).toBe("Good")
    expect(config.langMap[""]).toBeUndefined()
    expect(config.langMap.bad).toBeUndefined()
  })

  test("langMap that collapses to empty falls back to default", () => {
    const config = new Config([{ langMap: { "": "" } }]).resolve()

    expect(config.langMap.ts).toBe("TypeScript")
  })

  test("langMap non-record falls back to default", () => {
    const config = new Config([{ langMap: ["nope"] }]).resolve()

    expect(config.langMap.ts).toBe("TypeScript")
  })

  test("ignores undefined override values", () => {
    const config = new Config([{ fileLimit: undefined }]).resolve()

    expect(config.fileLimit).toBe(2000)
  })

  test("non-record layers are skipped", () => {
    const config = new Config([undefined, null, 5, "x", ["a"]]).resolve()

    expect(config.fileLimit).toBe(2000)
  })
})

describe("Config.overlay", () => {
  test("extracts the astgrep section", () => {
    expect(Config.overlay({ astgrep: { fileLimit: 9 } })).toEqual({ fileLimit: 9 })
  })

  test("returns undefined for non-record", () => {
    expect(Config.overlay(undefined)).toBeUndefined()
    expect(Config.overlay(["x"])).toBeUndefined()
    expect(Config.overlay(42)).toBeUndefined()
  })

  test("returns undefined when astgrep key absent", () => {
    expect(Config.overlay({ other: 1 })).toBeUndefined()
  })
})

describe("Config.langChoices", () => {
  test("returns sorted unique values", () => {
    expect(Config.langChoices({ ts: "TypeScript", tsx: "Tsx", mts: "TypeScript", js: "JavaScript" })).toEqual([
      "JavaScript",
      "Tsx",
      "TypeScript"
    ])
  })

  test("default langMap yields known sorted choices", () => {
    const choices = Config.langChoices(Config.fallback.langMap)

    expect(choices).toEqual([
      "C",
      "CSharp",
      "Cpp",
      "Css",
      "Go",
      "Html",
      "Java",
      "JavaScript",
      "Json",
      "Kotlin",
      "Python",
      "Ruby",
      "Rust",
      "Swift",
      "Tsx",
      "TypeScript",
      "Yaml"
    ])
  })
})
