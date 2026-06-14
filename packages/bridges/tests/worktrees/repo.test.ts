import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { Git, Worktrees } from "../../src/worktrees/index.ts"
import type { ExecResult } from "../../src/worktrees/index.ts"
import { FALLBACK } from "../../src/worktrees/render.ts"

class FakeRunner {
  readonly calls: string[][] = []
  private readonly responses: Map<string, ExecResult>

  constructor(responses: Record<string, ExecResult>) {
    this.responses = new Map(Object.entries(responses))
  }

  run = async (command: string, args: string[]): Promise<ExecResult> => {
    this.calls.push([command, ...args])
    const stripped = args[0] === "-C" ? args.slice(2) : args
    const key = stripped.join(" ")
    const response = this.responses.get(key)

    if (!response) {
      return { code: 1, stdout: "", stderr: `no fake for: ${key}` }
    }

    return response
  }
}

const PORCELAIN = [
  "worktree /repo/main",
  "HEAD abcdef1234567890",
  "branch refs/heads/main",
  "",
  "worktree /repo/.worktrees/feature",
  "HEAD 1122334455667788",
  "branch refs/heads/wt/feature",
  "",
  "worktree /repo/.worktrees/detached",
  "HEAD 99aabbccddeeff00",
  "detached",
  "locked needs review",
  "",
  "worktree /repo/.worktrees/gone",
  "HEAD 0000000000000000",
  "branch refs/heads/wt/gone",
  "prunable gitdir file points to non-existent location",
  ""
].join("\n")

function makeWorktrees(): Worktrees {
  return new Worktrees(new Git(async () => ({ code: 1 })))
}

describe("Worktrees.parseList", () => {
  test("parses worktree porcelain into entries", () => {
    const entries = makeWorktrees().parseList(PORCELAIN)
    expect(entries).toHaveLength(4)
    expect(entries[0].isMain).toBe(true)
    expect(entries[0].branch).toBe("main")
    expect(entries[1].branch).toBe("wt/feature")
    expect(entries[2].detached).toBe(true)
    expect(entries[2].locked).toBe(true)
    expect(entries[2].lockedReason).toBe("needs review")
    expect(entries[3].prunable).toBe(true)
    expect(entries[3].prunableReason).toBe("gitdir file points to non-existent location")
  })

  test("only the first entry is marked main", () => {
    const entries = makeWorktrees().parseList(PORCELAIN)
    expect(entries.filter(entry => entry.isMain)).toHaveLength(1)
  })

  test("empty output yields no entries", () => {
    expect(makeWorktrees().parseList("")).toHaveLength(0)
  })

  test("strips the refs/heads/ prefix from branches", () => {
    const entries = makeWorktrees().parseList("worktree /a\nbranch refs/heads/topic/x\n")
    expect(entries[0].branch).toBe("topic/x")
  })
})

describe("Worktrees.isInside", () => {
  const wt = makeWorktrees()

  test("identical paths count as inside", () => {
    expect(wt.isInside("/repo", "/repo")).toBe(true)
  })

  test("child is inside parent", () => {
    expect(wt.isInside("/repo/sub/dir", "/repo")).toBe(true)
  })

  test("sibling and parent are not inside", () => {
    expect(wt.isInside("/repo", "/repo/sub")).toBe(false)
    expect(wt.isInside("/other", "/repo")).toBe(false)
  })
})

describe("Worktrees.worktreeBase", () => {
  const wt = makeWorktrees()

  test("relative dir resolves against mainRoot", () => {
    expect(wt.worktreeBase({ ...FALLBACK, dir: ".worktrees" }, "/repo")).toBe(resolve("/repo", ".worktrees"))
  })

  test("absolute dir joins the repo basename", () => {
    expect(wt.worktreeBase({ ...FALLBACK, dir: "/wt" }, "/home/me/repo")).toBe(resolve("/wt", "repo"))
  })
})

describe("Worktrees.validateName", () => {
  const wt = makeWorktrees()

  test("accepts safe names", () => {
    expect(() => wt.validateName("feature-1")).not.toThrow()
    expect(() => wt.validateName("a.b_c")).not.toThrow()
  })

  test("rejects leading punctuation, dot-dot, slashes and empties", () => {
    expect(() => wt.validateName("")).toThrow()
    expect(() => wt.validateName(".hidden")).toThrow()
    expect(() => wt.validateName("a/b")).toThrow()
    expect(() => wt.validateName("a..b")).toThrow()
    expect(() => wt.validateName("..")).toThrow()
  })

  test("rejects names longer than 100 characters", () => {
    expect(() => wt.validateName("a".repeat(101))).toThrow()
    expect(() => wt.validateName("a".repeat(100))).not.toThrow()
  })
})

describe("Worktrees.findEntry", () => {
  const wt = makeWorktrees()
  const entries = wt.parseList(PORCELAIN)
  const base = "/repo/.worktrees"

  test("matches an exact resolved path", () => {
    const found = wt.findEntry(entries, base, "feature")
    expect(found?.path).toBe("/repo/.worktrees/feature")
  })

  test("matches a non-main basename when unique", () => {
    const found = wt.findEntry(entries, "/elsewhere", "feature")
    expect(found?.path).toBe("/repo/.worktrees/feature")
  })

  test("returns undefined for a missing name", () => {
    expect(wt.findEntry(entries, base, "nope")).toBeUndefined()
  })

  test("throws on an ambiguous basename across multiple non-managed entries", () => {
    const ambiguous = wt.parseList(
      ["worktree /repo/main", "branch refs/heads/main", "", "worktree /a/dup", "branch refs/heads/x", "", "worktree /b/dup", "branch refs/heads/y", ""].join("\n")
    )
    expect(() => wt.findEntry(ambiguous, "/repo/.worktrees", "dup")).toThrow(/Multiple worktrees/)
  })

  test("disambiguates by managed-under-base when only one is managed", () => {
    const mixed = wt.parseList(
      ["worktree /repo/main", "branch refs/heads/main", "", "worktree /repo/.worktrees/dup", "branch refs/heads/x", "", "worktree /b/dup", "branch refs/heads/y", ""].join("\n")
    )
    const found = mixed && wt.findEntry(mixed, "/repo/.worktrees", "dup")
    expect(found?.path).toBe("/repo/.worktrees/dup")
  })
})

describe("Worktrees.detectRepo", () => {
  test("combines the rev-parse probe into a single call", async () => {
    const runner = new FakeRunner({
      "rev-parse --is-inside-work-tree --show-toplevel --path-format=absolute --git-common-dir":
        { code: 0, stdout: "true\n/repo\n/repo/.git\n" },
      "worktree list --porcelain": { code: 0, stdout: PORCELAIN }
    })
    const repo = new Worktrees(new Git(runner.run))
    const info = await repo.detectRepo("/repo", FALLBACK)
    expect(info.currentRoot).toBe("/repo")
    expect(info.commonDir).toBe("/repo/.git")
    expect(info.mainRoot).toBe("/repo/main")
    expect(info.entries).toHaveLength(4)
    const probeCalls = runner.calls.filter(call => call.includes("--is-inside-work-tree"))
    expect(probeCalls).toHaveLength(1)
  })

  test("throws a friendly error when not inside a work tree", async () => {
    const runner = new FakeRunner({
      "rev-parse --is-inside-work-tree --show-toplevel --path-format=absolute --git-common-dir":
        { code: 128, stdout: "", stderr: "fatal: not a git repository" },
      "rev-parse --is-inside-work-tree": { code: 128, stdout: "", stderr: "fatal" }
    })
    const repo = new Worktrees(new Git(runner.run))
    await expect(repo.detectRepo("/tmp", FALLBACK)).rejects.toThrow(/Not a git repository/)
  })

  test("falls back to the legacy git-common-dir resolution when the combined probe is unavailable", async () => {
    const runner = new FakeRunner({
      "rev-parse --is-inside-work-tree --show-toplevel --path-format=absolute --git-common-dir":
        { code: 129, stdout: "", stderr: "unknown option: --path-format" },
      "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
      "rev-parse --show-toplevel": { code: 0, stdout: "/repo\n" },
      "rev-parse --git-common-dir": { code: 0, stdout: ".git\n" },
      "worktree list --porcelain": { code: 0, stdout: PORCELAIN }
    })
    const repo = new Worktrees(new Git(runner.run))
    const info = await repo.detectRepo("/repo", FALLBACK)
    expect(info.currentRoot).toBe("/repo")
    expect(info.commonDir).toBe(resolve("/repo", ".git"))
  })
})
