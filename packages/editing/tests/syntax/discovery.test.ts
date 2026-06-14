import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "../../src/syntax/settings.ts"
import { FileDiscovery } from "../../src/syntax/discovery.ts"
import type { GitFiles } from "../../src/syntax/discovery.ts"

const config = new Config([]).resolve()
const noGit: GitFiles = async () => undefined

describe("FileDiscovery.toRel", () => {
  test("returns forward-slash relative path", () => {
    expect(FileDiscovery.toRel("/repo", "/repo/src/a.ts")).toBe("src/a.ts")
  })

  test("returns absolute forward-slash path when outside cwd", () => {
    expect(FileDiscovery.toRel("/repo", "/other/a.ts")).toBe("/other/a.ts")
  })

  test("returns absolute when rel is empty", () => {
    expect(FileDiscovery.toRel("/repo", "/repo")).toBe("/repo")
  })
})

describe("FileDiscovery.inferLang", () => {
  test("maps known extension", () => {
    expect(FileDiscovery.inferLang("x.ts", config.langMap)).toBe("TypeScript")
    expect(FileDiscovery.inferLang("X.TSX", config.langMap)).toBe("Tsx")
  })

  test("returns undefined for unknown or missing extension", () => {
    expect(FileDiscovery.inferLang("x.unknownext", config.langMap)).toBeUndefined()
    expect(FileDiscovery.inferLang("Makefile", config.langMap)).toBeUndefined()
  })
})

describe("FileDiscovery.collect", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "astgrep-disc-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("walks directory and infers languages, skipping node_modules and dot dirs", async () => {
    writeFileSync(join(root, "a.ts"), "const a = 1\n")
    writeFileSync(join(root, "b.py"), "x = 1\n")
    writeFileSync(join(root, "readme.txt"), "nope\n")
    mkdirSync(join(root, "node_modules"))
    writeFileSync(join(root, "node_modules", "dep.ts"), "skip\n")
    mkdirSync(join(root, ".hidden"))
    writeFileSync(join(root, ".hidden", "x.ts"), "skip\n")

    const discovery = new FileDiscovery(config, noGit)
    const result = await discovery.collect(root, [root], undefined)
    const rels = result.files.map((f) => f.rel).sort()

    expect(rels).toEqual(["a.ts", "b.py"])
    expect(result.skippedNoLang).toBe(1)
  })

  test("uses injected git listing when available", async () => {
    writeFileSync(join(root, "tracked.ts"), "const a = 1\n")
    writeFileSync(join(root, "untracked.ts"), "const b = 2\n")
    const git: GitFiles = async (dir) => [join(dir, "tracked.ts")]

    const discovery = new FileDiscovery(config, git)
    const result = await discovery.collect(root, [root], undefined)

    expect(result.files.map((f) => f.rel)).toEqual(["tracked.ts"])
  })

  test("explicit single file is forced past extension filter", async () => {
    const target = join(root, "data.unknownext")
    writeFileSync(target, "x\n")

    const discovery = new FileDiscovery(config, noGit)
    const result = await discovery.collect(root, [target], "JavaScript")

    expect(result.files).toHaveLength(1)
    expect(result.files[0].lang).toBe("JavaScript")
  })

  test("explicit lang filters non-matching inferred files in a directory", async () => {
    writeFileSync(join(root, "a.ts"), "const a = 1\n")
    writeFileSync(join(root, "b.py"), "x = 1\n")

    const discovery = new FileDiscovery(config, noGit)
    const result = await discovery.collect(root, [root], "TypeScript")

    expect(result.files.map((f) => f.rel)).toEqual(["a.ts"])
  })

  test("records missing paths", async () => {
    const discovery = new FileDiscovery(config, noGit)
    const result = await discovery.collect(root, [join(root, "nope")], undefined)

    expect(result.missing).toEqual([join(root, "nope")])
    expect(result.files).toHaveLength(0)
  })

  test("skips files larger than maxFileBytes", async () => {
    const tiny = new Config([{ maxFileBytes: 1024 }]).resolve()
    writeFileSync(join(root, "big.ts"), "x".repeat(2048))
    writeFileSync(join(root, "small.ts"), "y\n")

    const discovery = new FileDiscovery(tiny, noGit)
    const result = await discovery.collect(root, [root], undefined)

    expect(result.files.map((f) => f.rel)).toEqual(["small.ts"])
    expect(result.skippedLarge).toBe(1)
  })

  test("caps file collection at fileLimit", async () => {
    const limited = new Config([{ fileLimit: 2 }]).resolve()

    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(root, `f${i}.ts`), "x\n")
    }

    const discovery = new FileDiscovery(limited, noGit)
    const result = await discovery.collect(root, [root], undefined)

    expect(result.files).toHaveLength(2)
    expect(result.capped).toBe(true)
  })

  test("dedupes overlapping roots", async () => {
    writeFileSync(join(root, "a.ts"), "x\n")

    const discovery = new FileDiscovery(config, noGit)
    const result = await discovery.collect(root, [root, root], undefined)

    expect(result.files).toHaveLength(1)
  })

  test("blank and non-string roots are skipped", async () => {
    writeFileSync(join(root, "a.ts"), "x\n")

    const discovery = new FileDiscovery(config, noGit)
    const result = await discovery.collect(root, ["   ", root], undefined)

    expect(result.files.map((f) => f.rel)).toEqual(["a.ts"])
    expect(result.missing).toHaveLength(0)
  })
})
