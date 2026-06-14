import { describe, expect, test } from "bun:test"
import { DiffEngine } from "../../src/syntax/diff.ts"

describe("DiffEngine.lines", () => {
  test("marks unchanged, deleted, and added lines", () => {
    const ops = DiffEngine.lines("a\nb\nc\n", "a\nB\nc\n")

    expect(ops).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "same", text: "c" }
    ])
  })

  test("drops single trailing empty line", () => {
    const ops = DiffEngine.lines("a\n", "a\n")

    expect(ops).toEqual([{ type: "same", text: "a" }])
  })

  test("pure insertion", () => {
    const ops = DiffEngine.lines("", "x\ny\n")

    expect(ops).toEqual([
      { type: "add", text: "x" },
      { type: "add", text: "y" }
    ])
  })

  test("pure deletion", () => {
    const ops = DiffEngine.lines("x\ny\n", "")

    expect(ops).toEqual([
      { type: "del", text: "x" },
      { type: "del", text: "y" }
    ])
  })
})

describe("DiffEngine.hunks", () => {
  test("no changes yields no hunks", () => {
    expect(DiffEngine.hunks(DiffEngine.lines("a\nb\n", "a\nb\n"), 3)).toEqual([])
  })

  test("builds a hunk header with correct line ranges", () => {
    const hunks = DiffEngine.hunks(DiffEngine.lines("a\nb\nc\n", "a\nX\nc\n"), 1)

    expect(hunks).toHaveLength(1)
    expect(hunks[0].header).toBe("@@ -1,3 +1,3 @@")
    expect(hunks[0].lines).toEqual([" a", "-b", "+X", " c"])
  })

  test("coalesces nearby changes into one hunk and splits distant ones", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\n"
    const after = "a\nX\nc\nd\ne\nf\ng\nY\n"
    const hunks = DiffEngine.hunks(DiffEngine.lines(before, after), 1)

    expect(hunks).toHaveLength(2)
    expect(hunks[0].header).toBe("@@ -1,3 +1,3 @@")
    expect(hunks[1].header).toBe("@@ -7,2 +7,2 @@")
  })

  test("pure-add hunk uses bStart from preceding context", () => {
    const hunks = DiffEngine.hunks(DiffEngine.lines("a\n", "a\nb\n"), 3)

    expect(hunks[0].header).toBe("@@ -1,1 +1,2 @@")
    expect(hunks[0].lines).toEqual([" a", "+b"])
  })
})

describe("DiffEngine.render", () => {
  test("empty when nothing changed", () => {
    expect(DiffEngine.render("f.ts", "a\n", "a\n", 3, 10)).toEqual({ text: "", total: 0, shown: 0 })
  })

  test("renders headers and hunks within budget", () => {
    const diff = DiffEngine.render("src/f.ts", "a\nb\nc\n", "a\nX\nc\n", 1, 10)

    expect(diff.total).toBe(1)
    expect(diff.shown).toBe(1)
    expect(diff.text).toBe(["--- a/src/f.ts", "+++ b/src/f.ts", "@@ -1,3 +1,3 @@", " a", "-b", "+X", " c"].join("\n"))
  })

  test("zero budget hides all but reports total", () => {
    const diff = DiffEngine.render("f.ts", "a\nb\n", "a\nX\n", 0, 0)

    expect(diff).toEqual({ text: "", total: 1, shown: 0 })
  })

  test("truncates and appends more-hunks notice", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\n"
    const after = "a\nX\nc\nd\ne\nf\ng\nY\n"
    const diff = DiffEngine.render("f.ts", before, after, 0, 1)

    expect(diff.total).toBe(2)
    expect(diff.shown).toBe(1)
    expect(diff.text).toContain("… 1 more hunks in f.ts not shown")
  })

  test("clips very long lines to 400 chars with ellipsis", () => {
    const long = "x".repeat(500)
    const diff = DiffEngine.render("f.ts", `${long}\n`, `${long}y\n`, 0, 10)

    expect(diff.text).toContain(`-${"x".repeat(400)}…`)
  })
})
