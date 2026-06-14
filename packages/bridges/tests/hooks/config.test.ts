import { describe, expect, test } from "bun:test"
import { Config, FALLBACK, isRecord } from "../../src/hooks/index.ts"

const shipped = {
  shell: "/bin/sh",
  defaultTimeoutMs: 60000,
  eventBudgetMs: 120000,
  maxOutputBytes: 16384,
  historySize: 50,
  monitors: [],
  monitorMaxLineLength: 2000,
  killGraceMs: 3000,
  backoff: { initialMs: 1000, maxMs: 30000, resetAfterMs: 30000 },
}

describe("isRecord", () => {
  test("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord("x")).toBe(false)
    expect(isRecord(7)).toBe(false)
  })
})

describe("deepMerge", () => {
  test("override wins for scalars", () => {
    const merged = new Config().deepMerge({ a: 1, b: 2 }, { b: 3 })
    expect(merged).toEqual({ a: 1, b: 3 })
  })

  test("undefined override values are ignored", () => {
    const merged = new Config().deepMerge({ a: 1 }, { a: undefined })
    expect(merged).toEqual({ a: 1 })
  })

  test("nested objects merged recursively", () => {
    const merged = new Config().deepMerge({ backoff: { initialMs: 1, maxMs: 2 } }, { backoff: { maxMs: 9 } })
    expect(merged).toEqual({ backoff: { initialMs: 1, maxMs: 9 } })
  })

  test("array overrides replace, not merge", () => {
    const merged = new Config().deepMerge({ list: [1, 2] }, { list: [3] })
    expect(merged).toEqual({ list: [3] })
  })
})

describe("resolve defaults", () => {
  test("shipped defaults yield FALLBACK values with no problems", () => {
    const config = new Config().resolve(shipped, [])
    expect(config.shell).toBe(FALLBACK.shell)
    expect(config.defaultTimeoutMs).toBe(FALLBACK.defaultTimeoutMs)
    expect(config.eventBudgetMs).toBe(FALLBACK.eventBudgetMs)
    expect(config.maxOutputBytes).toBe(FALLBACK.maxOutputBytes)
    expect(config.historySize).toBe(FALLBACK.historySize)
    expect(config.monitorMaxLineLength).toBe(FALLBACK.monitorMaxLineLength)
    expect(config.killGraceMs).toBe(FALLBACK.killGraceMs)
    expect(config.backoff).toEqual(FALLBACK.backoff)
    expect(config.monitors).toEqual([])
    expect(config.problems).toEqual([])
  })

  test("empty input falls back to FALLBACK", () => {
    const config = new Config().resolve({}, [])
    expect(config.shell).toBe("/bin/sh")
    expect(config.backoff).toEqual(FALLBACK.backoff)
  })

  test("project override wins over home override", () => {
    const config = new Config().resolve(shipped, [{ shell: "/bin/bash" }, { shell: "/usr/bin/zsh" }])
    expect(config.shell).toBe("/usr/bin/zsh")
  })
})

describe("coercion", () => {
  const c = new Config()

  test("text trims and falls back on blank/non-string", () => {
    expect(c.text("  /bin/dash  ", "/bin/sh")).toBe("/bin/dash")
    expect(c.text("   ", "/bin/sh")).toBe("/bin/sh")
    expect(c.text(42, "/bin/sh")).toBe("/bin/sh")
  })

  test("positive rounds finite positives, falls back otherwise", () => {
    expect(c.positive(10.6, 1)).toBe(11)
    expect(c.positive(0, 5)).toBe(5)
    expect(c.positive(-3, 5)).toBe(5)
    expect(c.positive(Number.NaN, 5)).toBe(5)
    expect(c.positive(Number.POSITIVE_INFINITY, 5)).toBe(5)
    expect(c.positive("9", 5)).toBe(5)
  })

  test("backoff maxMs enforced to be at least initialMs", () => {
    const config = new Config().resolve(shipped, [{ backoff: { initialMs: 5000, maxMs: 1000 } }])
    expect(config.backoff.initialMs).toBe(5000)
    expect(config.backoff.maxMs).toBe(5000)
  })
})

describe("normalizeMonitors", () => {
  test("undefined yields empty with no problems", () => {
    const problems: string[] = []
    expect(new Config().normalizeMonitors(undefined, problems)).toEqual([])
    expect(problems).toEqual([])
  })

  test("non-array records a problem", () => {
    const problems: string[] = []
    expect(new Config().normalizeMonitors("nope", problems)).toEqual([])
    expect(problems).toEqual(["config: monitors must be an array"])
  })

  test("valid monitor with default when=always", () => {
    const problems: string[] = []
    const specs = new Config().normalizeMonitors([{ name: "log", command: "tail -f x" }], problems)
    expect(specs).toEqual([{ name: "log", command: "tail -f x", when: "always" }])
    expect(problems).toEqual([])
  })

  test("non-object entry", () => {
    const problems: string[] = []
    new Config().normalizeMonitors([5], problems)
    expect(problems).toEqual(["config: monitors[0] must be an object"])
  })

  test("missing name", () => {
    const problems: string[] = []
    new Config().normalizeMonitors([{ command: "x" }], problems)
    expect(problems).toEqual(["config: monitors[0] is missing a name"])
  })

  test("duplicate name dropped", () => {
    const problems: string[] = []
    const specs = new Config().normalizeMonitors(
      [
        { name: "a", command: "x" },
        { name: "a", command: "y" },
      ],
      problems,
    )
    expect(specs).toEqual([{ name: "a", command: "x", when: "always" }])
    expect(problems).toEqual(['config: monitor "a" is defined more than once'])
  })

  test("missing command", () => {
    const problems: string[] = []
    new Config().normalizeMonitors([{ name: "a", command: "   " }], problems)
    expect(problems).toEqual(['config: monitor "a" is missing a command'])
  })

  test("unsupported when value", () => {
    const problems: string[] = []
    const specs = new Config().normalizeMonitors([{ name: "a", command: "x", when: "never" }], problems)
    expect(specs).toEqual([])
    expect(problems).toEqual([
      'config: monitor "a" has an unsupported when value; only "always" is supported',
    ])
  })

  test("name and command trimmed", () => {
    const problems: string[] = []
    const specs = new Config().normalizeMonitors([{ name: "  a  ", command: "  run  " }], problems)
    expect(specs).toEqual([{ name: "a", command: "run", when: "always" }])
  })
})
