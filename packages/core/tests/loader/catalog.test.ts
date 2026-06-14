import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ResourceCatalog } from "../../src/loader/index.ts"

describe("ResourceCatalog", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loader-catalog-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(rel: string, content: string): string {
    const file = join(root, rel)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, content)
    return file
  }

  test("scans the repo-root resource dirs and sorts records by relative path", () => {
    write("prompts/git/commit.md", "p")
    write("prompts/docs/explain.md", "p")
    write("skills/git/commit/skill.md", "s")
    write("skills/research/deep/skill.md", "s")
    write("themes/dark/abyss.json", "{}")
    write("agents/build/coder.md", "a")

    const loaded = new ResourceCatalog().load(root)

    expect(loaded.root).toBe(root)
    expect(loaded.errors).toEqual([])
    expect(loaded.prompts.map((p) => p.relativePath)).toEqual([
      join("prompts", "docs", "explain.md"),
      join("prompts", "git", "commit.md"),
    ])
    expect(loaded.skills.map((s) => s.relativePath)).toEqual([
      join("skills", "git", "commit", "skill.md"),
      join("skills", "research", "deep", "skill.md"),
    ])
    expect(loaded.themes).toHaveLength(1)
    expect(loaded.agents).toHaveLength(1)
    expect(loaded.warnings).toEqual([])
  })

  test("only collects skill.md files inside the skills tree", () => {
    write("skills/git/commit/skill.md", "s")
    write("skills/git/commit/notes.md", "ignored")
    write("skills/readme.md", "ignored")

    const loaded = new ResourceCatalog().load(root)

    expect(loaded.skills.map((s) => s.relativePath)).toEqual([join("skills", "git", "commit", "skill.md")])
  })

  test("matches themes by extension and ignores non-json files", () => {
    write("themes/dark/abyss.json", "{}")
    write("themes/dark/notes.md", "ignored")

    const loaded = new ResourceCatalog().load(root)

    expect(loaded.themes.map((t) => t.relativePath)).toEqual([join("themes", "dark", "abyss.json")])
  })

  test("surfaces a missing resource dir as a warning, not an error", () => {
    write("prompts/a.md", "p")
    write("skills/x/skill.md", "s")
    write("themes/t.json", "{}")

    const loaded = new ResourceCatalog().load(root)

    expect(loaded.errors).toEqual([])
    expect(loaded.warnings.some((w) => w.message === "agents directory is missing")).toBe(true)
    expect(loaded.agents).toEqual([])
  })

  test("errors when the resource root itself is missing", () => {
    const missing = join(root, "nope")
    const loaded = new ResourceCatalog().load(missing)

    expect(loaded.errors.some((e) => e.message === "resource root directory is missing")).toBe(true)
    expect(loaded.prompts).toEqual([])
  })

  test("records carry an absolute content path for downstream readers", () => {
    const file = write("agents/build/coder.md", "a")
    const loaded = new ResourceCatalog().load(root)

    expect(loaded.agents[0].contentPath).toBe(file)
    expect(loaded.agents[0].path).toBe(file)
    expect(loaded.agents[0].kind).toBe("agent")
  })
})
