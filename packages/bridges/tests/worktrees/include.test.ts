import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "../../src/worktrees/index.ts"
import type { ExecResult } from "../../src/worktrees/index.ts"
import { Include, Patterns, Walker } from "../../src/worktrees/include.ts"
import { FALLBACK } from "../../src/worktrees/render.ts"

function lsFilesRunner(untracked: string[], ignored: string[]) {
  return async (_command: string, args: string[]): Promise<ExecResult> => {
    const stripped = args[0] === "-C" ? args.slice(2) : args

    if (stripped.includes("--ignored")) {
      return { code: 0, stdout: ignored.map(file => `${file}\0`).join("") }
    }

    if (stripped.includes("ls-files")) {
      return { code: 0, stdout: untracked.map(file => `${file}\0`).join("") }
    }

    return { code: 1, stdout: "" }
  }
}

function compiledFrom(include: Include, raw: string) {
  return include.compilePatterns(raw)
}

describe("Include.globToSource and matching", () => {
  const include = new Include(new Git(async () => ({ code: 1 })))

  test("decides last-match-wins with negation", () => {
    const patterns = compiledFrom(include, ["*.log", "!keep.log"].join("\n"))
    expect(include.decide(patterns, "debug.log", false)).toBe(true)
    expect(include.decide(patterns, "keep.log", false)).toBe(false)
  })

  test("trailing slash means directory only", () => {
    const patterns = compiledFrom(include, "build/")
    expect(include.decide(patterns, "build", true)).toBe(true)
    expect(include.decide(patterns, "build", false)).toBe(false)
  })

  test("anchored patterns only match from the root", () => {
    const patterns = compiledFrom(include, "/config.json")
    expect(include.decide(patterns, "config.json", false)).toBe(true)
    expect(include.decide(patterns, "nested/config.json", false)).toBe(false)
  })

  test("unanchored basenames match at any depth", () => {
    const patterns = compiledFrom(include, ".env")
    expect(include.decide(patterns, ".env", false)).toBe(true)
    expect(include.decide(patterns, "deep/nested/.env", false)).toBe(true)
  })

  test("globstar matches across path segments", () => {
    const patterns = compiledFrom(include, "src/**/*.ts")
    expect(include.decide(patterns, "src/a/b/c.ts", false)).toBe(true)
    expect(include.decide(patterns, "src/x.ts", false)).toBe(true)
  })

  test("question mark matches a single non-slash character", () => {
    const patterns = compiledFrom(include, "/file?.txt")
    expect(include.decide(patterns, "file1.txt", false)).toBe(true)
    expect(include.decide(patterns, "file12.txt", false)).toBe(false)
  })

  test("comments and blank lines are ignored", () => {
    const result = include.compilePatterns("# comment\n\n  \n.env")
    expect(result).toHaveLength(1)
  })

  test("regex metacharacters in patterns are treated as literals", () => {
    const patterns = compiledFrom(include, "a[b]c.txt")
    expect(patterns).toHaveLength(1)
    expect(include.decide(patterns, "a[b]c.txt", false)).toBe(true)
    expect(include.decide(patterns, "abc.txt", false)).toBe(false)
  })
})

describe("Patterns", () => {
  const patterns = new Patterns()

  test("compiled patterns delegate identically through Include", () => {
    const direct = patterns.compilePatterns("*.log")
    expect(patterns.decide(direct, "debug.log", false)).toBe(true)
    expect(patterns.shouldDescend(patterns.compilePatterns("/src/lib.ts"), "src")).toBe(true)
  })

  test("toPosix and isInside operate on relative paths", () => {
    expect(patterns.toPosix("a/b/c")).toBe("a/b/c")
    expect(patterns.isInside("/repo/sub", "/repo")).toBe(true)
    expect(patterns.isInside("/other", "/repo")).toBe(false)
  })
})

describe("Walker", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-walk-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("walks files name-sorted, skips .git and honors the cap", () => {
    mkdirSync(join(root, ".git"), { recursive: true })
    mkdirSync(join(root, "b"), { recursive: true })
    writeFileSync(join(root, "a.txt"), "a")
    writeFileSync(join(root, "b", "z.txt"), "z")
    writeFileSync(join(root, "b", "m.txt"), "m")
    writeFileSync(join(root, ".git", "config"), "x")
    const out: string[] = []
    new Walker().walkFiles(root, "", out, 100, 0)
    expect(out).toEqual(["a.txt", "b/m.txt", "b/z.txt"])
  })

  test("stops collecting once the cap is reached", () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `f${i}.txt`), `${i}`)
    }
    const out: string[] = []
    new Walker().walkFiles(root, "", out, 2, 0)
    expect(out).toHaveLength(2)
  })
})

describe("Include.copyIncludes", () => {
  let mainRoot: string
  let base: string
  let target: string

  beforeEach(() => {
    mainRoot = mkdtempSync(join(tmpdir(), "wt-main-"))
    base = join(mainRoot, ".worktrees")
    target = join(base, "feature")
    mkdirSync(target, { recursive: true })
  })

  afterEach(() => {
    rmSync(mainRoot, { recursive: true, force: true })
  })

  function write(rel: string, content: string): void {
    const abs = join(mainRoot, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, content)
  }

  test("returns the empty outcome when the include manifest is missing", async () => {
    const include = new Include(new Git(lsFilesRunner([], [])))
    const outcome = await include.copyIncludes(FALLBACK, mainRoot, base, target)
    expect(outcome).toEqual({ copied: 0, failed: 0, truncated: false })
  })

  test("copies matched untracked files and skips the manifest itself", async () => {
    write(".worktreeinclude", ".env\nconfig/*.json\n")
    write(".env", "SECRET=1")
    write("config/app.json", "{}")
    write("config/readme.md", "ignore me")
    const include = new Include(new Git(lsFilesRunner([".worktreeinclude", ".env", "config/app.json", "config/readme.md"], [])))
    const outcome = await include.copyIncludes(FALLBACK, mainRoot, base, target)
    expect(outcome.copied).toBe(2)
    expect(outcome.failed).toBe(0)
    expect(existsSync(join(target, ".env"))).toBe(true)
    expect(existsSync(join(target, "config/app.json"))).toBe(true)
    expect(existsSync(join(target, "config/readme.md"))).toBe(false)
    expect(existsSync(join(target, ".worktreeinclude"))).toBe(false)
  })

  test("expands matched ignored directories into their files", async () => {
    write(".worktreeinclude", "node_modules/\n")
    write("node_modules/pkg/index.js", "x")
    write("node_modules/pkg/lib/util.js", "y")
    const include = new Include(new Git(lsFilesRunner([".worktreeinclude"], ["node_modules/"])))
    const outcome = await include.copyIncludes(FALLBACK, mainRoot, base, target)
    expect(outcome.copied).toBe(2)
    expect(existsSync(join(target, "node_modules/pkg/index.js"))).toBe(true)
    expect(existsSync(join(target, "node_modules/pkg/lib/util.js"))).toBe(true)
  })

  test("never copies files living under the worktree base", async () => {
    write(".worktreeinclude", "**/*.txt\n")
    write("keep.txt", "outside")
    mkdirSync(join(base, "feature"), { recursive: true })
    writeFileSync(join(base, "feature", "inside.txt"), "inside")
    const include = new Include(new Git(lsFilesRunner([".worktreeinclude", "keep.txt", ".worktrees/feature/inside.txt"], [])))
    const outcome = await include.copyIncludes(FALLBACK, mainRoot, base, target)
    expect(outcome.copied).toBe(1)
    expect(existsSync(join(target, "keep.txt"))).toBe(true)
  })

  test("truncates the selection at maxIncludeFiles and flags it", async () => {
    write(".worktreeinclude", "*.dat\n")
    const names: string[] = []

    for (let i = 0; i < 5; i++) {
      const name = `file${i}.dat`
      write(name, `${i}`)
      names.push(name)
    }

    const include = new Include(new Git(lsFilesRunner([".worktreeinclude", ...names], [])))
    const outcome = await include.copyIncludes({ ...FALLBACK, maxIncludeFiles: 3 }, mainRoot, base, target)
    expect(outcome.truncated).toBe(true)
    expect(outcome.copied).toBe(3)
  })

  test("does not flag truncation when the count equals the cap", async () => {
    write(".worktreeinclude", "*.dat\n")

    for (let i = 0; i < 3; i++) {
      write(`file${i}.dat`, `${i}`)
    }

    const include = new Include(new Git(lsFilesRunner([".worktreeinclude", "file0.dat", "file1.dat", "file2.dat"], [])))
    const outcome = await include.copyIncludes({ ...FALLBACK, maxIncludeFiles: 3 }, mainRoot, base, target)
    expect(outcome.truncated).toBe(false)
    expect(outcome.copied).toBe(3)
  })

})

describe("Include.ensureExcluded", () => {
  let mainRoot: string
  let commonDir: string

  beforeEach(() => {
    mainRoot = mkdtempSync(join(tmpdir(), "wt-excl-"))
    commonDir = join(mainRoot, ".git")
    mkdirSync(commonDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(mainRoot, { recursive: true, force: true })
  })

  test("appends the posix base line and dedupes on a second call", () => {
    const include = new Include(new Git(async () => ({ code: 1 })))
    const repo = { currentRoot: mainRoot, mainRoot, commonDir, entries: [] }
    const base = join(mainRoot, ".worktrees")
    expect(include.ensureExcluded(repo, base)).toBeUndefined()
    const excludePath = join(commonDir, "info", "exclude")
    const first = readFileSync(excludePath, "utf8")
    expect(first).toContain("/.worktrees/")
    include.ensureExcluded(repo, base)
    expect(readFileSync(excludePath, "utf8")).toBe(first)
  })

  test("does nothing when the base is outside the main root", () => {
    const include = new Include(new Git(async () => ({ code: 1 })))
    const repo = { currentRoot: mainRoot, mainRoot, commonDir, entries: [] }
    expect(include.ensureExcluded(repo, "/elsewhere/wt")).toBeUndefined()
    expect(existsSync(join(commonDir, "info", "exclude"))).toBe(false)
  })
})
