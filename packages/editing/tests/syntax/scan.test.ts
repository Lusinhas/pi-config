import { describe, expect, test } from "bun:test"
import { ScanSession } from "../../src/syntax/scan.ts"
import type { MatchEdit, MatchNode, MatchRange, ParsedSource, ReadSource, RootNode } from "../../src/syntax/scan.ts"
import type { TargetFile } from "../../src/syntax/discovery.ts"

function node(text: string, line = 0): MatchNode {
  const range: MatchRange = {
    start: { line, column: 0, index: 0 },
    end: { line, column: text.length, index: text.length }
  }

  return {
    range: () => range,
    text: () => text,
    getMatch: () => null,
    getMultipleMatches: () => [],
    replace: (): MatchEdit => ({ startPos: 0, endPos: text.length })
  }
}

function root(matches: MatchNode[], onFind?: () => void): ParsedSource {
  const r: RootNode = {
    range: () => ({ start: { line: 0, column: 0, index: 0 }, end: { line: 0, column: 0, index: 0 } }),
    findAll: () => {
      if (onFind) {
        onFind()
      }

      return matches
    },
    commitEdits: () => ""
  }

  return { root: () => r }
}

function file(rel: string, lang: string): TargetFile {
  return { abs: `/repo/${rel}`, rel, lang }
}

class StubSource implements ReadSource {
  private readonly contents: Map<string, string>
  private readonly matches: Map<string, MatchNode[]>
  private readonly failParse: Set<string>
  private readonly failRead: Set<string>
  private readonly throwFind: Set<string>

  constructor(opts: {
    contents?: Record<string, string>
    matches?: Record<string, MatchNode[]>
    failParse?: string[]
    failRead?: string[]
    throwFind?: string[]
  }) {
    this.contents = new Map(Object.entries(opts.contents ?? {}))
    this.matches = new Map(Object.entries(opts.matches ?? {}))
    this.failParse = new Set(opts.failParse ?? [])
    this.failRead = new Set(opts.failRead ?? [])
    this.throwFind = new Set(opts.throwFind ?? [])
  }

  read(target: TargetFile): string {
    if (this.failRead.has(target.rel)) {
      throw new Error("read fail")
    }

    return this.contents.get(target.rel) ?? "source"
  }

  async parse(_lang: string, _content: string): Promise<ParsedSource> {
    const rel = [...this.contents.entries()].find(([, value]) => value === _content)?.[0]

    if (rel && this.failParse.has(rel)) {
      throw new Error("parse fail")
    }

    const m = rel ? this.matches.get(rel) ?? [] : []

    return root(m, () => {
      if (rel && this.throwFind.has(rel)) {
        throw new Error("bad pattern")
      }
    })
  }
}

describe("ScanSession.run", () => {
  test("counts matches across files", async () => {
    const files = [file("a.ts", "TypeScript"), file("b.ts", "TypeScript")]
    const source = new StubSource({
      contents: { "a.ts": "ca", "b.ts": "cb" },
      matches: { "a.ts": [node("x"), node("y")], "b.ts": [node("z")] }
    })

    const result = await new ScanSession(files, "p", 100, new Set(["TypeScript"]), source, undefined).run()

    expect(result.total).toBe(3)
    expect(result.scanned).toBe(2)
    expect(result.results).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })

  test("skips files with zero matches", async () => {
    const files = [file("a.ts", "TypeScript"), file("b.ts", "TypeScript")]
    const source = new StubSource({
      contents: { "a.ts": "ca", "b.ts": "cb" },
      matches: { "a.ts": [node("x")] }
    })

    const result = await new ScanSession(files, "p", 100, new Set(["TypeScript"]), source, undefined).run()

    expect(result.results).toHaveLength(1)
    expect(result.scanned).toBe(2)
  })

  test("truncates when match limit reached at loop top", async () => {
    const files = [file("a.ts", "TypeScript"), file("b.ts", "TypeScript")]
    const source = new StubSource({
      contents: { "a.ts": "ca", "b.ts": "cb" },
      matches: { "a.ts": [node("x"), node("y"), node("z")], "b.ts": [node("w")] }
    })

    const result = await new ScanSession(files, "p", 2, new Set(["TypeScript"]), source, undefined).run()

    expect(result.total).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.unscanned).toBe(1)
  })

  test("sets truncated when total exceeds max within a file", async () => {
    const files = [file("a.ts", "TypeScript")]
    const source = new StubSource({
      contents: { "a.ts": "ca" },
      matches: { "a.ts": [node("x"), node("y"), node("z")] }
    })

    const result = await new ScanSession(files, "p", 2, new Set(["TypeScript"]), source, undefined).run()

    expect(result.total).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.unscanned).toBe(0)
  })

  test("counts unsupported languages when supported set is non-empty", async () => {
    const files = [file("a.rs", "Rust"), file("b.rs", "Rust")]
    const source = new StubSource({ contents: { "a.rs": "x", "b.rs": "y" } })

    const result = await new ScanSession(files, "p", 100, new Set(["TypeScript"]), source, undefined).run()

    expect(result.scanned).toBe(0)
    expect(result.unsupported.get("Rust")).toBe(2)
  })

  test("empty supported set disables the gate", async () => {
    const files = [file("a.rs", "Rust")]
    const source = new StubSource({ contents: { "a.rs": "x" }, matches: { "a.rs": [node("m")] } })

    const result = await new ScanSession(files, "p", 100, new Set(), source, undefined).run()

    expect(result.scanned).toBe(1)
    expect(result.total).toBe(1)
    expect(result.unsupported.size).toBe(0)
  })

  test("records read failures as parse errors with samples", async () => {
    const files = [file("a.ts", "TypeScript")]
    const source = new StubSource({ contents: { "a.ts": "x" }, failRead: ["a.ts"] })

    const result = await new ScanSession(files, "p", 100, new Set(["TypeScript"]), source, undefined).run()

    expect(result.parseErrorCount).toBe(1)
    expect(result.parseErrors).toEqual(["a.ts"])
    expect(result.scanned).toBe(0)
  })

  test("records parse failures", async () => {
    const files = [file("a.ts", "TypeScript")]
    const source = new StubSource({ contents: { "a.ts": "x" }, failParse: ["a.ts"] })

    const result = await new ScanSession(files, "p", 100, new Set(["TypeScript"]), source, undefined).run()

    expect(result.parseErrorCount).toBe(1)
    expect(result.scanned).toBe(0)
  })

  test("caps parse-error samples at 10", async () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`f${i}.ts`, "TypeScript"))
    const contents: Record<string, string> = {}

    for (const f of files) {
      contents[f.rel] = `c-${f.rel}`
    }

    const source = new StubSource({ contents, failRead: files.map((f) => f.rel) })
    const result = await new ScanSession(files, "p", 100, new Set(["TypeScript"]), source, undefined).run()

    expect(result.parseErrorCount).toBe(12)
    expect(result.parseErrors).toHaveLength(10)
  })

  test("skips content containing NUL", async () => {
    const files = [file("a.ts", "TypeScript")]
    const source = new StubSource({ contents: { "a.ts": "before\0after" }, matches: { "a.ts": [node("m")] } })

    const result = await new ScanSession(files, "p", 100, new Set(["TypeScript"]), source, undefined).run()

    expect(result.scanned).toBe(0)
    expect(result.total).toBe(0)
  })

  test("records pattern errors per language and skips later files of that language", async () => {
    const files = [file("a.ts", "TypeScript"), file("b.ts", "TypeScript")]
    const source = new StubSource({
      contents: { "a.ts": "ca", "b.ts": "cb" },
      matches: { "a.ts": [node("x")], "b.ts": [node("y")] },
      throwFind: ["a.ts"]
    })

    const result = await new ScanSession(files, "p", 100, new Set(["TypeScript"]), source, undefined).run()

    expect(result.patternErrors.get("TypeScript")).toBe("bad pattern")
    expect(result.scanned).toBe(1)
    expect(result.total).toBe(0)
  })

  test("throws when signal already aborted", async () => {
    const files = [file("a.ts", "TypeScript")]
    const source = new StubSource({ contents: { "a.ts": "x" } })
    const controller = new AbortController()
    controller.abort()

    await expect(
      new ScanSession(files, "p", 100, new Set(["TypeScript"]), source, controller.signal).run()
    ).rejects.toThrow("ast-grep scan aborted")
  })

  test("empty result helper has zeroed counters", () => {
    const empty = ScanSession.empty()

    expect(empty.total).toBe(0)
    expect(empty.scanned).toBe(0)
    expect(empty.results).toHaveLength(0)
    expect(empty.unsupported.size).toBe(0)
  })
})
