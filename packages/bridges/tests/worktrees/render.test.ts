import { describe, expect, test } from "bun:test"
import { Git, Worktrees } from "../../src/worktrees/index.ts"
import type { RepoInfo } from "../../src/worktrees/index.ts"
import { FALLBACK, Renderer } from "../../src/worktrees/render.ts"

function makeRenderer(): { renderer: Renderer; repo: Worktrees } {
  const repo = new Worktrees(new Git(async () => ({ code: 1 })))
  return { renderer: new Renderer(repo), repo }
}

describe("Renderer.shortHead", () => {
  const { renderer } = makeRenderer()

  test("truncates to nine characters", () => {
    expect(renderer.shortHead("abcdef1234567890")).toBe("abcdef123")
  })

  test("returns a dash for the empty head", () => {
    expect(renderer.shortHead("")).toBe("-")
  })
})

describe("Renderer.usage", () => {
  test("interpolates dir, branchPrefix and defaultRef across six lines", () => {
    const { renderer } = makeRenderer()
    const text = renderer.usage({ ...FALLBACK, dir: ".wt", branchPrefix: "x/", defaultRef: "main" })
    const lines = text.split("\n")
    expect(lines).toHaveLength(6)
    expect(lines[2]).toBe("  new <name> [ref]   create .wt/<name> on branch x/<name> (ref defaults to main)")
  })
})

describe("Renderer.renderList", () => {
  test("renders headers, markers, kinds and trailing legend", () => {
    const { renderer, repo } = makeRenderer()
    const entries = repo.parseList(
      [
        "worktree /repo/main",
        "HEAD aaaaaaaaaaaaaaaa",
        "branch refs/heads/main",
        "",
        "worktree /repo/.worktrees/feature",
        "HEAD bbbbbbbbbbbbbbbb",
        "branch refs/heads/wt/feature",
        "",
        "worktree /elsewhere/linked",
        "HEAD cccccccccccccccc",
        "detached",
        "locked busy",
        ""
      ].join("\n")
    )
    const info: RepoInfo = { currentRoot: "/repo", mainRoot: "/repo/main", commonDir: "/repo/.git", entries }
    const out = renderer.renderList(info, "/repo/.worktrees", "/repo/.worktrees/feature")
    const lines = out.split("\n")
    expect(lines[0]).toBe("Worktrees (3):")
    expect(lines[lines.length - 1]).toBe("* = contains the current session cwd")
    expect(lines[2].startsWith("* ")).toBe(true)
    expect(lines[1]).toContain("main")
    expect(lines[2]).toContain("managed")
    expect(lines[3]).toContain("linked")
    expect(lines[3]).toContain("(detached cccccccccc".slice(0, 19))
    expect(lines[3]).toContain("[locked: busy]")
  })
})
