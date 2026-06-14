import { describe, expect, test } from "bun:test"
import { Config } from "../../src/syntax/settings.ts"
import {
  CommitGuard,
  EditPlanner,
  Hashing,
  RewriteFormatter,
  StagedStore,
  Substitution
} from "../../src/syntax/rewrite.ts"
import type { Planned, StagedSet } from "../../src/syntax/rewrite.ts"
import type { FileMatch, MatchEdit, MatchNode, MatchRange, ParsedSource, RootNode } from "../../src/syntax/scan.ts"
import type { Collected, TargetFile } from "../../src/syntax/discovery.ts"

const config = new Config([]).resolve()
const choices = Config.langChoices(config.langMap)

function capture(text: string, start: number, end: number): MatchNode {
  const range: MatchRange = {
    start: { line: 0, column: start, index: start },
    end: { line: 0, column: end, index: end }
  }

  return {
    range: () => range,
    text: () => text,
    getMatch: () => null,
    getMultipleMatches: () => [],
    replace: () => ({ startPos: start, endPos: end })
  }
}

describe("Substitution", () => {
  test("substitutes single metavariable capture", () => {
    const m: MatchNode = {
      ...capture("console.log(msg)", 0, 16),
      getMatch: (name) => (name === "MSG" ? capture("msg", 12, 15) : null)
    }
    const sub = new Substitution("console.log($MSG)")

    expect(sub.apply("logger.info($MSG)", m, "console.log(msg)")).toBe("logger.info(msg)")
  })

  test("leaves token unchanged when capture is missing", () => {
    const m = capture("x", 0, 1)
    const sub = new Substitution("$MSG")

    expect(sub.apply("$MSG", m, "x")).toBe("$MSG")
  })

  test("does not substitute a token absent from the pattern", () => {
    const m: MatchNode = { ...capture("x", 0, 1), getMatch: () => capture("y", 0, 1) }
    const sub = new Substitution("$KNOWN")

    expect(sub.apply("$OTHER", m, "x")).toBe("$OTHER")
  })

  test("substitutes multi metavariable by slicing source span", () => {
    const source = "fn(a, b, c)"
    const m: MatchNode = {
      ...capture(source, 0, source.length),
      getMultipleMatches: (name) => (name === "ARGS" ? [capture("a", 3, 4), capture("c", 9, 10)] : [])
    }
    const sub = new Substitution("fn($$$ARGS)")

    expect(sub.apply("call($$$ARGS)", m, source)).toBe("call(a, b, c)")
  })

  test("multi metavariable with no nodes yields empty", () => {
    const m: MatchNode = { ...capture("fn()", 0, 4), getMultipleMatches: () => [] }
    const sub = new Substitution("fn($$$ARGS)")

    expect(sub.apply("call($$$ARGS)", m, "fn()")).toBe("call()")
  })

  test("returns token unchanged when accessor throws", () => {
    const m: MatchNode = {
      ...capture("x", 0, 1),
      getMatch: () => {
        throw new Error("boom")
      }
    }
    const sub = new Substitution("$MSG")

    expect(sub.apply("$MSG", m, "x")).toBe("$MSG")
  })
})

function rootFor(content: string, edits: Array<{ from: number; to: number; text: string }>): ParsedSource {
  const r: RootNode = {
    range: () => ({ start: { line: 0, column: 0, index: 0 }, end: { line: 0, column: 0, index: content.length } }),
    findAll: () => [],
    commitEdits: (committed) => {
      const sorted = [...committed].sort((a, b) => a.startPos - b.startPos)
      let out = ""
      let cursor = 0

      for (const edit of sorted) {
        const replacement = edits.find((e) => e.from === edit.startPos && e.to === edit.endPos)
        out += content.slice(cursor, edit.startPos) + (replacement?.text ?? "")
        cursor = edit.endPos
      }

      out += content.slice(cursor)

      return out
    }
  }

  return { root: () => r }
}

function matchEdit(from: number, to: number): MatchNode {
  return { ...capture("", from, to), replace: (): MatchEdit => ({ startPos: from, endPos: to }) }
}

function fileMatchFor(rel: string, content: string, matches: MatchNode[], root: ParsedSource): FileMatch {
  const file: TargetFile = { abs: `/repo/${rel}`, rel, lang: "TypeScript" }

  return { file, content, root, matches }
}

describe("EditPlanner", () => {
  test("plans non-overlapping edits and reports replaced count", () => {
    const content = "aXbYc"
    const root = rootFor(content, [
      { from: 1, to: 2, text: "1" },
      { from: 3, to: 4, text: "2" }
    ])
    const fm = fileMatchFor("a.ts", content, [matchEdit(1, 2), matchEdit(3, 4)], root)
    const planner = new EditPlanner("p", "r")

    const result = planner.plan([fm])

    expect(result.planned).toHaveLength(1)
    expect(result.planned[0].after).toBe("a1b2c")
    expect(result.replaced).toBe(2)
    expect(result.overlapped).toBe(0)
  })

  test("drops overlapping nested matches and counts them", () => {
    const content = "abcdef"
    const root = rootFor(content, [
      { from: 0, to: 4, text: "X" },
      { from: 2, to: 6, text: "Y" }
    ])
    const fm = fileMatchFor("a.ts", content, [matchEdit(0, 4), matchEdit(2, 6)], root)
    const planner = new EditPlanner("p", "r")

    const result = planner.plan([fm])

    expect(result.overlapped).toBe(1)
    expect(result.replaced).toBe(1)
    expect(result.planned[0].after).toBe("Xef")
  })

  test("skips files where the rewrite output is identical", () => {
    const content = "abc"
    const root = rootFor(content, [{ from: 0, to: 1, text: "a" }])
    const fm = fileMatchFor("a.ts", content, [matchEdit(0, 1)], root)
    const planner = new EditPlanner("p", "r")

    const result = planner.plan([fm])

    expect(result.planned).toHaveLength(0)
    expect(result.replaced).toBe(0)
  })

  test("records failures when replace throws", () => {
    const content = "abc"
    const root = rootFor(content, [])
    const throwing: MatchNode = {
      ...capture("", 0, 1),
      replace: () => {
        throw new Error("nope")
      }
    }
    const fm = fileMatchFor("a.ts", content, [throwing], root)
    const planner = new EditPlanner("p", "r")

    const result = planner.plan([fm])

    expect(result.planned).toHaveLength(0)
    expect(result.failures).toEqual(["a.ts: nope"])
  })

  test("sorts edits by start position before committing", () => {
    const content = "0123456789"
    const root = rootFor(content, [
      { from: 0, to: 1, text: "A" },
      { from: 5, to: 6, text: "B" }
    ])
    const fm = fileMatchFor("a.ts", content, [matchEdit(5, 6), matchEdit(0, 1)], root)
    const planner = new EditPlanner("p", "r")

    const result = planner.plan([fm])

    expect(result.planned[0].after).toBe("A1234B6789")
  })
})

describe("Hashing", () => {
  test("sha is deterministic", () => {
    expect(Hashing.sha("abc")).toBe(Hashing.sha("abc"))
    expect(Hashing.sha("abc")).not.toBe(Hashing.sha("abd"))
  })
})

function plannedFile(rel: string, content: string, after: string, matchCount: number): Planned {
  return { abs: `/repo/${rel}`, rel, hash: Hashing.sha(content), content, after, matchCount }
}

describe("StagedStore", () => {
  test("makeId returns 6-hex-char id", () => {
    const store = new StagedStore(8)
    expect(store.makeId()).toMatch(/^[0-9a-f]{6}$/)
  })

  test("stage and retrieve, then LRU evict oldest beyond maxStaged", () => {
    const store = new StagedStore(2)
    store.stage(store.build("a", "p", "r", 1, [plannedFile("x.ts", "a", "b", 1)]))
    store.stage(store.build("b", "p", "r", 1, [plannedFile("y.ts", "a", "b", 1)]))
    store.stage(store.build("c", "p", "r", 1, [plannedFile("z.ts", "a", "b", 1)]))

    expect(store.has("a")).toBe(false)
    expect(store.has("b")).toBe(true)
    expect(store.has("c")).toBe(true)
    expect(store.ids()).toEqual(["b", "c"])
  })

  test("guardBytes throws when staged bytes exceed limit", () => {
    const store = new StagedStore(8)
    const big = "x".repeat(40000000)
    const planned = [plannedFile("x.ts", big, big, 1)]

    expect(() => store.guardBytes(planned)).toThrow(/staging would hold/)
  })

  test("guardBytes passes for small content", () => {
    const store = new StagedStore(8)
    expect(() => store.guardBytes([plannedFile("x.ts", "a", "b", 1)])).not.toThrow()
  })
})

describe("CommitGuard", () => {
  function setOf(store: StagedStore, id: string, files: Array<{ rel: string; content: string; after: string }>): StagedSet {
    const planned = files.map((f) => plannedFile(f.rel, f.content, f.after, 1))
    const set = store.build(id, "p", "r", planned.length, planned)
    store.stage(set)

    return set
  }

  test("require throws for unknown id with staged list and expiry note", () => {
    const store = new StagedStore(8)
    setOf(store, "abc", [{ rel: "x.ts", content: "a", after: "b" }])
    const guard = new CommitGuard(store, 8)

    expect(() => guard.require("zzz")).toThrow(/no staged rewrite with id "zzz" \(staged: abc\)/)
    expect(() => guard.require("zzz")).toThrow(/after 8 newer stages/)
  })

  test("require returns the set for a known id", () => {
    const store = new StagedStore(8)
    const set = setOf(store, "abc", [{ rel: "x.ts", content: "a", after: "b" }])
    const guard = new CommitGuard(store, 8)

    expect(guard.require("abc")).toBe(set)
  })

  test("checkStale throws and deletes when a file hash differs", () => {
    const store = new StagedStore(8)
    const set = setOf(store, "abc", [{ rel: "x.ts", content: "original", after: "new" }])
    const guard = new CommitGuard(store, 8)

    expect(() => guard.checkStale("abc", set, () => "changed")).toThrow(/staged set abc is stale/)
    expect(store.has("abc")).toBe(false)
  })

  test("checkStale throws when read fails", () => {
    const store = new StagedStore(8)
    const set = setOf(store, "abc", [{ rel: "x.ts", content: "original", after: "new" }])
    const guard = new CommitGuard(store, 8)

    expect(() =>
      guard.checkStale("abc", set, () => {
        throw new Error("gone")
      })
    ).toThrow(/changed on disk since staging: x.ts/)
  })

  test("checkStale passes when hashes match", () => {
    const store = new StagedStore(8)
    const set = setOf(store, "abc", [{ rel: "x.ts", content: "original", after: "new" }])
    const guard = new CommitGuard(store, 8)

    expect(() => guard.checkStale("abc", set, () => "original")).not.toThrow()
  })

  test("partialFailure returns error describing raced and failed files", () => {
    const store = new StagedStore(8)
    const set = setOf(store, "abc", [
      { rel: "x.ts", content: "a", after: "b" },
      { rel: "y.ts", content: "a", after: "b" }
    ])
    const guard = new CommitGuard(store, 8)
    const err = guard.partialFailure("abc", set, { written: ["x.ts"], raced: ["y.ts"], failed: [] })

    expect(err?.message).toContain("applied 1 of 2 files from abc")
    expect(err?.message).toContain("changed during apply: y.ts")
  })

  test("partialFailure returns undefined on clean outcome", () => {
    const store = new StagedStore(8)
    const set = setOf(store, "abc", [{ rel: "x.ts", content: "a", after: "b" }])
    const guard = new CommitGuard(store, 8)

    expect(guard.partialFailure("abc", set, { written: ["x.ts"], raced: [], failed: [] })).toBeUndefined()
  })

  test("applyFailure describes write failures", () => {
    const planned = [plannedFile("x.ts", "a", "b", 1), plannedFile("y.ts", "a", "b", 1)]
    const err = CommitGuard.applyFailure(planned, { written: ["x.ts"], raced: [], failed: ["y.ts: disk full"] })

    expect(err?.message).toContain("wrote 1 of 2 files")
    expect(err?.message).toContain("write failed: y.ts: disk full")
  })

  test("applyFailure returns undefined on clean outcome", () => {
    const planned = [plannedFile("x.ts", "a", "b", 1)]
    expect(CommitGuard.applyFailure(planned, { written: ["x.ts"], raced: [], failed: [] })).toBeUndefined()
  })
})

function collectedWith(files: TargetFile[], extra: Partial<Collected> = {}): Collected {
  return { files, missing: [], skippedNoLang: 0, skippedLarge: 0, capped: false, ...extra }
}

describe("RewriteFormatter", () => {
  const formatter = new RewriteFormatter(config, choices)

  test("nothingToRewrite distinguishes protected vs no-lang", () => {
    const protectedOut = formatter.nothingToRewrite("p", ["a.ts", "b.ts"], 0)
    expect(protectedOut.content[0].text).toBe("Nothing to rewrite: all 2 candidate files are protected by protectGlobs config (e.g. a.ts, b.ts).")
    expect(protectedOut.details).toEqual({ pattern: "p", total: 0, protectedFiles: 2 })

    const noLangOut = formatter.nothingToRewrite("p", [], 5)
    expect(noLangOut.content[0].text).toBe("Nothing to rewrite: no files with a mapped language found (5 files had no mapped extension).")
  })

  test("noMatch lists languages and choices", () => {
    const out = formatter.noMatch("p", collectedWith([{ abs: "/r/a.ts", rel: "a.ts", lang: "TypeScript" }]), 3)

    expect(out.content[0].text).toContain('No matches for pattern "p"; nothing to rewrite.')
    expect(out.content[0].text).toContain("Searched 3 files (inferred languages: TypeScript).")
    expect(out.details).toMatchObject({ pattern: "p", total: 0, scanned: 3 })
  })

  test("matchedNoChange explains identical output", () => {
    const out = formatter.matchedNoChange("p", 4, 2, [])

    expect(out.content[0].text).toBe('Pattern "p" matched 4 times in 2 files but produced no changes (the rewrite output is identical to the source).')
    expect(out.details).toEqual({ pattern: "p", total: 4, changedFiles: 0 })
  })

  test("matchedNoChange surfaces failures", () => {
    const out = formatter.matchedNoChange("p", 1, 1, ["a.ts: boom"])

    expect(out.content[0].text).toContain("edit computation failed: a.ts: boom")
  })

  test("notes preserve order protected, overlapped, failures, capped", () => {
    const notes = formatter.notes(["a.ts", "b.ts"], 3, ["c.ts: bad"], true)

    expect(notes[0]).toBe("Skipped 2 protected files (protectGlobs config), e.g. a.ts, b.ts.")
    expect(notes[1]).toBe("Dropped 3 overlapping nested matches; re-run after applying to catch them.")
    expect(notes[2]).toBe("Edit computation failed for 1 file: c.ts: bad.")
    expect(notes[3]).toBe("File scan capped at 2000 files (fileLimit config).")
  })

  test("applied output lists per-file replacements", () => {
    const planned = [plannedFile("a.ts", "x", "y", 2), plannedFile("b.ts", "x", "y", 1)]
    const out = formatter.applied("p", "r", 3, planned, ["a.ts", "b.ts"], [])

    expect(out.content[0].text.split("\n")[0]).toBe("Rewrote 3 matches in 2 files.")
    expect(out.content[0].text).toContain("  a.ts (2 replacements)")
    expect(out.content[0].text).toContain("  b.ts (1 replacement)")
    expect(out.details).toEqual({ pattern: "p", rewrite: "r", files: ["a.ts", "b.ts"], replaced: 3 })
  })

  test("staged output shows diff preview, apply hint, and details", () => {
    const planned = [plannedFile("a.ts", "a\nb\nc\n", "a\nX\nc\n", 1)]
    const out = formatter.staged("ff00aa", "p", "r", 1, planned, [])

    const text = out.content[0].text
    expect(text.split("\n")[0]).toBe("Staged rewrite ff00aa: 1 replacement across 1 file. Nothing has been written yet.")
    expect(text).toContain("--- a/a.ts")
    expect(text).toContain("-b")
    expect(text).toContain("+X")
    expect(text).toContain('To write these changes call astrewrite with {"applyId": "ff00aa"}.')
    expect(out.details).toMatchObject({ applyId: "ff00aa", pattern: "p", rewrite: "r", replaced: 1 })
    expect((out.details.files as Array<Record<string, unknown>>)[0]).toEqual({ path: "a.ts", matches: 1 })
  })

  test("staged output truncates hunks beyond maxHunks budget", () => {
    const tight = new RewriteFormatter(new Config([{ maxHunks: 1 }]).resolve(), choices)
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const before = `${lines.join("\n")}\n`
    const changed = [...lines]
    changed[1] = "X"
    changed[18] = "Y"
    const after = `${changed.join("\n")}\n`
    const planned = [plannedFile("a.ts", before, after, 2)]
    const out = tight.staged("id1234", "p", "r", 2, planned, [])

    expect(out.content[0].text).toContain("Preview truncated at 1 hunks;")
  })

  test("commitSuccess lists written replacements", () => {
    const store = new StagedStore(8)
    const set = store.build("abc", "p", "r", 3, [plannedFile("a.ts", "x", "y", 3)])
    const out = formatter.commitSuccess("abc", set, ["a.ts"])

    expect(out.content[0].text.split("\n")[0]).toBe("Applied rewrite abc: 3 replacements written to 1 file.")
    expect(out.content[0].text).toContain("  a.ts (3 replacements)")
    expect(out.details).toEqual({ applyId: "abc", files: ["a.ts"], replaced: 3 })
  })

  test("patternError builds the prefixed message with clipped detail", () => {
    const err = formatter.patternError("astrewrite", "console.log($X", "TypeScript", "unexpected token")

    expect(err.message).toBe('astrewrite: pattern "console.log($X" failed against TypeScript: unexpected token. Patterns must be complete, parsable TypeScript code.')
  })
})
