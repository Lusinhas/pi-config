import { describe, expect, test } from "bun:test"
import { Config } from "../../src/syntax/settings.ts"
import { FileLines, Phrase, SearchFormatter } from "../../src/syntax/format.ts"
import type { ToolOutput } from "../../src/syntax/format.ts"
import { ScanSession } from "../../src/syntax/scan.ts"
import type { FileMatch, MatchNode, MatchRange, ScanResult } from "../../src/syntax/scan.ts"
import type { Collected, TargetFile } from "../../src/syntax/discovery.ts"

const config = new Config([]).resolve()
const choices = Config.langChoices(config.langMap)

function match(text: string, startLine: number, startCol: number, endLine: number, endCol: number): MatchNode {
  const range: MatchRange = {
    start: { line: startLine, column: startCol, index: 0 },
    end: { line: endLine, column: endCol, index: 0 }
  }

  return {
    range: () => range,
    text: () => text,
    getMatch: () => null,
    getMultipleMatches: () => [],
    replace: () => ({ startPos: 0, endPos: 0 })
  }
}

function fileMatch(rel: string, lang: string, content: string, matches: MatchNode[]): FileMatch {
  const file: TargetFile = { abs: `/repo/${rel}`, rel, lang }

  return {
    file,
    content,
    root: { root: () => ({ range: () => match("", 0, 0, 0, 0).range(), findAll: () => [], commitEdits: () => "" }) },
    matches
  }
}

function scanWith(results: FileMatch[], extra: Partial<ScanResult> = {}): ScanResult {
  const total = results.reduce((sum, r) => sum + r.matches.length, 0)

  return { ...ScanSession.empty(), results, total, scanned: results.length, ...extra }
}

function collectedWith(files: TargetFile[], extra: Partial<Collected> = {}): Collected {
  return { files, missing: [], skippedNoLang: 0, skippedLarge: 0, capped: false, ...extra }
}

describe("Phrase", () => {
  test("plural switches between singular and plural", () => {
    expect(Phrase.plural(1, "file")).toBe("1 file")
    expect(Phrase.plural(2, "file")).toBe("2 files")
    expect(Phrase.plural(2, "match", "matches")).toBe("2 matches")
    expect(Phrase.plural(1, "match", "matches")).toBe("1 match")
  })

  test("clip truncates long strings with ellipsis", () => {
    expect(Phrase.clip("abcdef", 3)).toBe("abc…")
    expect(Phrase.clip("ab", 3)).toBe("ab")
  })

  test("clampInt floors and clamps, falls back for invalid", () => {
    expect(Phrase.clampInt(12.9, 5, 1, 100)).toBe(12)
    expect(Phrase.clampInt(0, 5, 1, 100)).toBe(1)
    expect(Phrase.clampInt(undefined, 5, 1, 100)).toBe(5)
    expect(Phrase.clampInt(Number.NaN, 5, 1, 100)).toBe(5)
  })
})

describe("SearchFormatter helpers", () => {
  test("snippetOf trims and annotates multiline", () => {
    expect(SearchFormatter.snippetOf("  hello  ")).toBe("hello")
    expect(SearchFormatter.snippetOf("a\nb\nc")).toBe("a … (+2 more lines)")
  })

  test("endLineOf drops trailing line when match ends at column 0", () => {
    expect(SearchFormatter.endLineOf(match("", 2, 0, 5, 0).range())).toBe(4)
    expect(SearchFormatter.endLineOf(match("", 2, 0, 5, 3).range())).toBe(5)
    expect(SearchFormatter.endLineOf(match("", 2, 0, 2, 0).range())).toBe(2)
  })
})

describe("FileLines.contextBlock", () => {
  test("marks matched lines and pads line numbers", () => {
    const lines = new FileLines("l0\nl1\nl2\nl3\nl4\n")
    const block = lines.contextBlock(1, 2, 1)

    expect(block).toEqual([
      "      1 | l0",
      "    > 2 | l1",
      "    > 3 | l2",
      "      4 | l3"
    ])
  })
})

describe("SearchFormatter.hits", () => {
  const formatter = new SearchFormatter(config, choices, ["TypeScript"])

  test("renders found header, per-file matches, and detail payload", () => {
    const fm = fileMatch("a.ts", "TypeScript", "const x = 1\nconst y = 2\n", [
      match("const x = 1", 0, 0, 0, 11),
      match("const y = 2", 1, 0, 1, 11)
    ])
    const out = formatter.hits(scanWith([fm]), "const $N = $V", 50, 0, [])

    expect(out.content[0].text.split("\n")[0]).toBe("Found 2 matches in 1 file.")
    expect(out.content[0].text).toContain("a.ts (2 matches)")
    expect(out.content[0].text).toContain("  1:1  const x = 1")
    expect(out.content[0].text).toContain("  2:1  const y = 2")
    expect(out.details).toMatchObject({ pattern: "const $N = $V", total: 2, shown: 2, truncated: false })
    expect((out.details.files as Array<Record<string, unknown>>)[0]).toMatchObject({ path: "a.ts", lang: "TypeScript" })
  })

  test("singular header for single match", () => {
    const fm = fileMatch("a.ts", "TypeScript", "x\n", [match("x", 0, 0, 0, 1)])
    const out = formatter.hits(scanWith([fm]), "p", 50, 0, [])

    expect(out.content[0].text.split("\n")[0]).toBe("Found 1 match in 1 file.")
  })

  test("truncated header with unscanned shows plus and showing-first", () => {
    const fm = fileMatch("a.ts", "TypeScript", "x\n", [match("x", 0, 0, 0, 1)])
    const out = formatter.hits(scanWith([fm], { total: 80, truncated: true, unscanned: 4 }), "p", 50, 0, [])

    expect(out.content[0].text.split("\n")[0]).toBe("Found 80+ matches in 1 file; showing first 50.")
    expect(out.details.truncated).toBe(true)
  })

  test("total over limit without truncation still marks detail truncated", () => {
    const fm = fileMatch("a.ts", "TypeScript", "x\n", [match("x", 0, 0, 0, 1)])
    const out = formatter.hits(scanWith([fm], { total: 60, truncated: false, unscanned: 0 }), "p", 50, 0, [])

    expect(out.content[0].text.split("\n")[0]).toBe("Found 60 matches in 1 file; showing first 50.")
    expect(out.details.truncated).toBe(true)
  })

  test("budget exhaustion omits remaining matches in a file", () => {
    const fm = fileMatch("a.ts", "TypeScript", "x\ny\n", [match("x", 0, 0, 0, 1), match("y", 1, 0, 1, 1)])
    const out = formatter.hits(scanWith([fm]), "p", 1, 0, [])

    expect(out.content[0].text).toContain("  … remaining matches in this file omitted")
  })

  test("appends notes block", () => {
    const fm = fileMatch("a.ts", "TypeScript", "x\n", [match("x", 0, 0, 0, 1)])
    const out = formatter.hits(scanWith([fm]), "p", 50, 0, ["something happened"])

    expect(out.content[0].text).toContain("Note: something happened")
  })

  test("includes context block when context > 0", () => {
    const fm = fileMatch("a.ts", "TypeScript", "l0\nl1\nl2\n", [match("l1", 1, 0, 1, 2)])
    const out = formatter.hits(scanWith([fm]), "p", 50, 1, [])

    expect(out.content[0].text).toContain("    > 2 | l1")
    expect(out.content[0].text).toContain("      1 | l0")
  })
})

describe("SearchFormatter.noMatch", () => {
  const formatter = new SearchFormatter(config, choices, ["TypeScript"])

  test("lists searched languages and lang choices", () => {
    const collected = collectedWith([{ abs: "/r/a.ts", rel: "a.ts", lang: "TypeScript" }])
    const out = formatter.noMatch(collected, scanWith([], { scanned: 3 }), "p", [])

    const text = out.content[0].text
    expect(text).toContain('No matches for pattern "p".')
    expect(text).toContain("Searched 3 files (inferred languages: TypeScript).")
    expect(text).toContain(`If the inferred language is wrong, pass lang explicitly (choices: ${choices.join(", ")}).`)
    expect(out.details).toMatchObject({ pattern: "p", total: 0, scanned: 3 })
  })

  test("none for empty searched languages", () => {
    const out = formatter.noMatch(collectedWith([]), scanWith([], { scanned: 0 }), "p", [])

    expect(out.content[0].text).toContain("inferred languages: none")
  })
})

describe("SearchFormatter.emptyFiles", () => {
  const formatter = new SearchFormatter(config, choices, ["TypeScript"])

  test("reports no searchable files under cwd", () => {
    const collected = collectedWith([], { skippedNoLang: 4 })
    const out = formatter.emptyFiles(collected, ScanSession.empty(), "/repo", undefined, 50)

    expect(out.content[0].text).toContain("No searchable files found under /repo.")
    expect(out.content[0].text).toContain("4 files had no mapped language.")
    expect(out.details).toEqual({ total: 0, files: [] })
  })

  test("reports paths when provided", () => {
    const out = formatter.emptyFiles(collectedWith([]), ScanSession.empty(), "/repo", ["src", "lib"], 50)

    expect(out.content[0].text).toContain("No searchable files found under: src, lib.")
  })
})

describe("SearchFormatter.notes", () => {
  test("orders truncated, capped, unsupported, patternErrors, parse, missing, large", () => {
    const formatter = new SearchFormatter(config, choices, ["JavaScript", "TypeScript"])
    const collected = collectedWith([], { capped: true, missing: ["x"], skippedLarge: 2 })
    const scan: ScanResult = {
      ...ScanSession.empty(),
      truncated: true,
      unscanned: 3,
      parseErrorCount: 2,
      parseErrors: ["p1.ts", "p2.ts"],
      unsupported: new Map([["Rust", 4]]),
      patternErrors: new Map([["Python", "boom"]])
    }
    const notes = formatter.notes(collected, scan, 50)

    expect(notes[0]).toBe("Match limit 50 reached; 3 files not scanned yet. Narrow paths or raise limit to see more.")
    expect(notes[1]).toBe("File scan capped at 2000 files (fileLimit config).")
    expect(notes[2]).toBe("Skipped 4 Rust files: language not available in this @ast-grep/napi build (available: JavaScript, TypeScript).")
    expect(notes[3]).toBe("Pattern failed to parse as Python: boom")
    expect(notes[4]).toBe("2 files could not be read or parsed (e.g. p1.ts, p2.ts).")
    expect(notes[5]).toBe("Paths not found: x.")
    expect(notes[6]).toBe("Skipped 2 files larger than 1048576 bytes (maxFileBytes config).")
  })

  test("truncated note without unscanned omits tail", () => {
    const formatter = new SearchFormatter(config, choices, [])
    const notes = formatter.notes(collectedWith([]), { ...ScanSession.empty(), truncated: true, unscanned: 0 }, 25)

    expect(notes[0]).toBe("Match limit 25 reached. Narrow paths or raise limit to see more.")
  })
})

function textOf(out: ToolOutput): string {
  return out.content[0].text
}

describe("integration text shape", () => {
  test("hits output text ends without trailing note when no notes", () => {
    const formatter = new SearchFormatter(config, choices, ["TypeScript"])
    const fm = fileMatch("a.ts", "TypeScript", "x\n", [match("x", 0, 0, 0, 1)])
    const out = formatter.hits(scanWith([fm]), "p", 50, 0, [])

    expect(textOf(out).includes("Note:")).toBe(false)
  })
})
