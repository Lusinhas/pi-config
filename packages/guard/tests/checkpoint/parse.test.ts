import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BashScanner, GitPorcelain } from "../../src/checkpoint/parse.ts"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "checkpoint-parse-"))
  writeFileSync(join(dir, "alpha.txt"), "a")
  writeFileSync(join(dir, "beta.txt"), "b")
  mkdirSync(join(dir, "sub"), { recursive: true })
  writeFileSync(join(dir, "sub", "gamma.txt"), "g")
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("BashScanner.tokenize", () => {
  const scanner = new BashScanner()

  test("splits on whitespace and control operators", () => {
    expect(scanner.tokenize("rm a b ; rm c | grep d & echo e")).toEqual([
      "rm",
      "a",
      "b",
      "rm",
      "c",
      "grep",
      "d",
      "echo",
      "e"
    ])
  })

  test("honors single and double quotes", () => {
    expect(scanner.tokenize(`echo "a b" 'c d'`)).toEqual(["echo", "a b", "c d"])
  })

  test("handles backslash escapes inside and outside double quotes", () => {
    expect(scanner.tokenize(`echo a\\ b`)).toEqual(["echo", "a b"])
    expect(scanner.tokenize(`echo "a\\"b"`)).toEqual(["echo", 'a"b'])
  })
})

describe("BashScanner.candidates", () => {
  const scanner = new BashScanner()

  test("includes existing files inside cwd", () => {
    const out = scanner.candidates("rm alpha.txt beta.txt", dir, 20)

    expect(out.map(c => c.path).sort()).toEqual([join(dir, "alpha.txt"), join(dir, "beta.txt")].sort())
    expect(out.every(c => c.existing)).toBe(true)
  })

  test("skips non-existent non-redirect tokens", () => {
    const out = scanner.candidates("rm missing.txt alpha.txt", dir, 20)

    expect(out.map(c => c.path)).toEqual([join(dir, "alpha.txt")])
  })

  test("includes redirect targets even when they do not exist", () => {
    const out = scanner.candidates("echo hi > newfile.txt", dir, 20)

    expect(out.map(c => c.path)).toEqual([join(dir, "newfile.txt")])
    expect(out[0].existing).toBe(false)
  })

  test("handles attached redirect operators like 2>out", () => {
    const out = scanner.candidates("cmd 2>err.log", dir, 20)

    expect(out.map(c => c.path)).toEqual([join(dir, "err.log")])
  })

  test("skips leading-dash flags unless redirect targets", () => {
    const out = scanner.candidates("rm -rf alpha.txt", dir, 20)

    expect(out.map(c => c.path)).toEqual([join(dir, "alpha.txt")])
  })

  test("skips paths outside cwd", () => {
    const out = scanner.candidates("rm ../escape.txt /etc/passwd", dir, 20)

    expect(out).toEqual([])
  })

  test("dedupes repeated paths", () => {
    const out = scanner.candidates("rm alpha.txt alpha.txt", dir, 20)

    expect(out).toHaveLength(1)
  })

  test("respects the limit", () => {
    const out = scanner.candidates("rm alpha.txt beta.txt sub/gamma.txt", dir, 1)

    expect(out).toHaveLength(1)
  })
})

describe("GitPorcelain.parse", () => {
  const porcelain = new GitPorcelain()

  test("parses simple status codes", () => {
    expect(porcelain.parse(" M src/a.ts\n?? src/b.ts\nA  src/c.ts")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts"
    ])
  })

  test("skips lines shorter than four chars", () => {
    expect(porcelain.parse("xx\n M ok.ts")).toEqual(["ok.ts"])
  })

  test("splits rename and copy into both paths", () => {
    expect(porcelain.parse("R  old.ts -> new.ts")).toEqual(["old.ts", "new.ts"])
    expect(porcelain.parse("C  base.ts -> copy.ts")).toEqual(["base.ts", "copy.ts"])
  })

  test("strips trailing slashes and dedupes preserving order", () => {
    expect(porcelain.parse(" M dir/\n M dir/\n M other")).toEqual(["dir", "other"])
  })

  test("decodes quoted paths with octal byte escapes", () => {
    const decoded = porcelain.parse(' M "src/caf\\303\\251.ts"')

    expect(decoded).toEqual(["src/café.ts"])
  })

  test("decodes quoted paths with control escapes", () => {
    const decoded = porcelain.parse(' M "tab\\there.ts"')

    expect(decoded).toEqual(["tab\there.ts"])
  })

  test("handles quoted rename source", () => {
    const decoded = porcelain.parse('R  "old name.ts" -> new.ts')

    expect(decoded).toEqual(["old name.ts", "new.ts"])
  })
})
