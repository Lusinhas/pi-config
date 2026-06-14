import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git, Lifecycle, Worktrees } from "../../src/worktrees/index.ts"
import type { ExecResult } from "../../src/worktrees/index.ts"
import { Include } from "../../src/worktrees/include.ts"
import { Launcher } from "../../src/worktrees/launch.ts"
import { FALLBACK } from "../../src/worktrees/render.ts"

type Handler = (args: string[]) => ExecResult

class ScriptedRunner {
  readonly calls: string[][] = []
  private readonly handlers: { match: (args: string[]) => boolean; respond: Handler }[] = []

  on(prefix: string[], respond: Handler | ExecResult): this {
    const handler = typeof respond === "function" ? respond : () => respond
    this.handlers.push({
      match: args => prefix.every((token, i) => args[i] === token),
      respond: handler
    })
    return this
  }

  run = async (command: string, args: string[]): Promise<ExecResult> => {
    this.calls.push([command, ...args])
    const stripped = command === "git" && args[0] === "-C" ? args.slice(2) : args

    for (const handler of this.handlers) {
      if (handler.match(stripped)) {
        return handler.respond(stripped)
      }
    }

    return { code: 1, stdout: "", stderr: `unhandled: ${stripped.join(" ")}` }
  }
}

function build(runner: ScriptedRunner) {
  const git = new Git(runner.run)
  const repo = new Worktrees(git)
  const include = new Include(git)
  const lifecycle = new Lifecycle(git, repo, include)
  const launcher = new Launcher(git, repo)
  return { git, repo, include, lifecycle, launcher }
}

function porcelain(root: string, extras: string[] = []): string {
  return [`worktree ${root}`, "HEAD aaaaaaaaaaaaaaaa", "branch refs/heads/main", "", ...extras].join("\n")
}

describe("Lifecycle.createWorktree", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-life-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("creates a new branch worktree from the default ref", async () => {
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], { code: 0, stdout: porcelain(root) })
      .on(["rev-parse", "--verify", "--quiet", "refs/heads/wt/feature"], { code: 1, stdout: "" })
      .on(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { code: 0, stdout: "abc\n" })
      .on(["worktree", "add", "-b", "wt/feature"], { code: 0, stdout: "" })
    const { lifecycle } = build(runner)
    const outcome = await lifecycle.createWorktree(root, FALLBACK, "feature", undefined)
    expect(outcome.created).toBe(true)
    expect(outcome.branch).toBe("wt/feature")
    expect(outcome.ref).toBe("HEAD")
    expect(outcome.path).toBe(join(root, ".worktrees", "feature"))
  })

  test("reuses an existing branch and notes the ignored ref", async () => {
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], { code: 0, stdout: porcelain(root) })
      .on(["rev-parse", "--verify", "--quiet", "refs/heads/wt/feature"], { code: 0, stdout: "abc\n" })
      .on(["worktree", "add", join(root, ".worktrees", "feature"), "wt/feature"], { code: 0, stdout: "" })
    const { lifecycle } = build(runner)
    const outcome = await lifecycle.createWorktree(root, FALLBACK, "feature", "ignored-ref")
    expect(outcome.created).toBe(true)
    expect(outcome.notes).toContain("Reused existing branch wt/feature; the [ref] argument was ignored.")
  })

  test("rejects an unknown ref", async () => {
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], { code: 0, stdout: porcelain(root) })
      .on(["rev-parse", "--verify", "--quiet", "refs/heads/wt/feature"], { code: 1, stdout: "" })
      .on(["rev-parse", "--verify", "--quiet", "missing^{commit}"], { code: 1, stdout: "" })
    const { lifecycle } = build(runner)
    await expect(lifecycle.createWorktree(root, FALLBACK, "feature", "missing")).rejects.toThrow(/Unknown ref "missing"/)
  })

  test("returns the existing entry without creating when already registered", async () => {
    const wtPath = join(root, ".worktrees", "feature")
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], {
        code: 0,
        stdout: porcelain(root, [`worktree ${wtPath}`, "HEAD bbbbbbbbbbbbbbbb", "branch refs/heads/wt/feature", ""])
      })
    const { lifecycle } = build(runner)
    const outcome = await lifecycle.createWorktree(root, FALLBACK, "feature", undefined)
    expect(outcome.created).toBe(false)
    expect(outcome.path).toBe(wtPath)
    expect(outcome.branch).toBe("wt/feature")
  })

  test("refuses when the name resolves to the main worktree", async () => {
    const mainPath = join(root, "main", "main")
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${mainPath}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], { code: 0, stdout: porcelain(mainPath) })
    const { lifecycle } = build(runner)
    await expect(
      lifecycle.createWorktree(mainPath, { ...FALLBACK, dir: root }, "main", undefined)
    ).rejects.toThrow(/resolves to the main worktree/)
  })

  test("rejects an existing unregistered path", async () => {
    mkdirSync(join(root, ".worktrees", "feature"), { recursive: true })
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], { code: 0, stdout: porcelain(root) })
    const { lifecycle } = build(runner)
    await expect(lifecycle.createWorktree(root, FALLBACK, "feature", undefined)).rejects.toThrow(/exists but is not a registered worktree/)
  })
})

describe("Lifecycle.removeWorktree", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-rm-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function entriesWith(wtPath: string): string[] {
    return [`worktree ${wtPath}`, "HEAD bbbbbbbbbbbbbbbb", "branch refs/heads/wt/feature", ""]
  }

  test("removes a clean worktree and deletes its prefixed branch", async () => {
    const wtPath = join(root, ".worktrees", "feature")
    mkdirSync(wtPath, { recursive: true })
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], { code: 0, stdout: porcelain(root, entriesWith(wtPath)) })
      .on(["status", "--porcelain"], { code: 0, stdout: "" })
      .on(["worktree", "remove", wtPath], { code: 0, stdout: "" })
      .on(["branch", "-d", "wt/feature"], { code: 0, stdout: "" })
    const { lifecycle } = build(runner)
    const outcome = await lifecycle.removeWorktree(
      { cwd: root, hasUI: false, confirm: async () => true },
      FALLBACK,
      "feature"
    )
    expect(outcome.removed).toBe(true)
    expect(outcome.message).toBe(`Removed worktree "feature" at ${wtPath}. Branch wt/feature deleted.`)
  })

  test("notes a kept branch when delete fails", async () => {
    const wtPath = join(root, ".worktrees", "feature")
    mkdirSync(wtPath, { recursive: true })
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], { code: 0, stdout: porcelain(root, entriesWith(wtPath)) })
      .on(["status", "--porcelain"], { code: 0, stdout: "" })
      .on(["worktree", "remove", wtPath], { code: 0, stdout: "" })
      .on(["branch", "-d", "wt/feature"], { code: 1, stdout: "" })
    const { lifecycle } = build(runner)
    const outcome = await lifecycle.removeWorktree(
      { cwd: root, hasUI: false, confirm: async () => true },
      { ...FALLBACK, confirmRemove: false },
      "feature"
    )
    expect(outcome.message).toContain("Branch wt/feature kept (not fully merged")
  })

  test("refuses a dirty worktree without a UI", async () => {
    const wtPath = join(root, ".worktrees", "feature")
    mkdirSync(wtPath, { recursive: true })
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], { code: 0, stdout: porcelain(root, entriesWith(wtPath)) })
      .on(["status", "--porcelain"], { code: 0, stdout: " M file.ts\n" })
    const { lifecycle } = build(runner)
    await expect(
      lifecycle.removeWorktree({ cwd: root, hasUI: false, confirm: async () => true }, FALLBACK, "feature")
    ).rejects.toThrow(/has uncommitted changes; refusing to remove it without a UI/)
  })

  test("keeps a clean worktree when confirmation is declined", async () => {
    const wtPath = join(root, ".worktrees", "feature")
    mkdirSync(wtPath, { recursive: true })
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], { code: 0, stdout: porcelain(root, entriesWith(wtPath)) })
      .on(["status", "--porcelain"], { code: 0, stdout: "" })
    const { lifecycle } = build(runner)
    const outcome = await lifecycle.removeWorktree(
      { cwd: root, hasUI: true, confirm: async () => false },
      FALLBACK,
      "feature"
    )
    expect(outcome.removed).toBe(false)
    expect(outcome.message).toBe(`Kept worktree "feature" at ${wtPath}.`)
  })

  test("prunes a vanished worktree directory", async () => {
    const wtPath = join(root, ".worktrees", "gone")
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], {
        code: 0,
        stdout: porcelain(root, [`worktree ${wtPath}`, "HEAD cccccccccccccccc", "branch refs/heads/wt/gone", ""])
      })
      .on(["worktree", "prune"], { code: 0, stdout: "" })
    const { lifecycle } = build(runner)
    const outcome = await lifecycle.removeWorktree(
      { cwd: root, hasUI: false, confirm: async () => true },
      FALLBACK,
      "gone"
    )
    expect(outcome.removed).toBe(true)
    expect(outcome.message).toContain("directory was already gone; pruned its stale registration")
  })

  test("lists known worktrees when the name is missing", async () => {
    const wtPath = join(root, ".worktrees", "other")
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], {
        code: 0,
        stdout: porcelain(root, [`worktree ${wtPath}`, "HEAD dddddddddddddddd", "branch refs/heads/wt/other", ""])
      })
    const { lifecycle } = build(runner)
    await expect(
      lifecycle.removeWorktree({ cwd: root, hasUI: false, confirm: async () => true }, FALLBACK, "missing")
    ).rejects.toThrow(/No worktree named "missing"\. Known worktrees: other\./)
  })
})

describe("Launcher.openWorktree", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-open-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("prints shell-quoted launch instructions", async () => {
    const wtPath = join(root, ".worktrees", "feature")
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], {
        code: 0,
        stdout: porcelain(root, [`worktree ${wtPath}`, "HEAD eeeeeeeeeeeeeeee", "branch refs/heads/wt/feature", ""])
      })
    const { launcher } = build(runner)
    const outcome = await launcher.openWorktree(
      { cwd: root, hasUI: false, confirm: async () => false },
      FALLBACK,
      "feature"
    )
    expect(outcome.severity).toBe("info")
    expect(outcome.text).toContain(`Worktree ready at ${wtPath} (wt/feature).`)
    expect(outcome.text).toContain(`  cd '${wtPath}' && pi`)
    expect(outcome.text).toContain(`  cd '${wtPath}' && pi --resume`)
  })

  test("reports already-inside when cwd is the worktree", async () => {
    const wtPath = join(root, ".worktrees", "feature")
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${wtPath}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], {
        code: 0,
        stdout: porcelain(root, [`worktree ${wtPath}`, "HEAD eeeeeeeeeeeeeeee", "branch refs/heads/wt/feature", ""])
      })
    const { launcher } = build(runner)
    const outcome = await launcher.openWorktree(
      { cwd: wtPath, hasUI: false, confirm: async () => false },
      FALLBACK,
      "feature"
    )
    expect(outcome.text).toBe(`Already inside worktree "feature" at ${wtPath}.`)
  })

  test("adds a no-UI spawn note when allowSpawn is on without a UI", async () => {
    const wtPath = join(root, ".worktrees", "feature")
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], {
        code: 0,
        stdout: porcelain(root, [`worktree ${wtPath}`, "HEAD eeeeeeeeeeeeeeee", "branch refs/heads/wt/feature", ""])
      })
    const { launcher } = build(runner)
    const outcome = await launcher.openWorktree(
      { cwd: root, hasUI: false, confirm: async () => false },
      { ...FALLBACK, allowSpawn: true },
      "feature"
    )
    expect(outcome.text).toContain("allowSpawn is enabled but no UI is available")
  })

  test("warns on a prunable worktree", async () => {
    const wtPath = join(root, ".worktrees", "feature")
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { code: 0, stdout: `true\n${root}\n${root}/.git\n` })
      .on(["worktree", "list", "--porcelain"], {
        code: 0,
        stdout: porcelain(root, [
          `worktree ${wtPath}`,
          "HEAD eeeeeeeeeeeeeeee",
          "branch refs/heads/wt/feature",
          "prunable gitdir missing",
          ""
        ])
      })
    const { launcher } = build(runner)
    const outcome = await launcher.openWorktree(
      { cwd: root, hasUI: false, confirm: async () => false },
      FALLBACK,
      "feature"
    )
    expect(outcome.severity).toBe("warning")
    expect(outcome.text).toContain("is prunable (gitdir missing)")
  })
})

describe("Lifecycle.pruneWorktrees", () => {
  test("returns the clean message when nothing was pruned", async () => {
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree"], { code: 0, stdout: "true\n" })
      .on(["worktree", "prune", "--verbose"], { code: 0, stdout: "", stderr: "" })
    const { lifecycle } = build(runner)
    expect(await lifecycle.pruneWorktrees("/repo", FALLBACK)).toBe(
      "Nothing to prune; every registered worktree is intact."
    )
  })

  test("lists pruned records from stdout and stderr", async () => {
    const runner = new ScriptedRunner()
      .on(["rev-parse", "--is-inside-work-tree"], { code: 0, stdout: "true\n" })
      .on(["worktree", "prune", "--verbose"], { code: 0, stdout: "Removing worktrees/old\n", stderr: "" })
    const { lifecycle } = build(runner)
    expect(await lifecycle.pruneWorktrees("/repo", FALLBACK)).toBe(
      "Pruned stale worktree records:\n  Removing worktrees/old"
    )
  })

  test("rejects outside a git repository", async () => {
    const runner = new ScriptedRunner().on(["rev-parse", "--is-inside-work-tree"], { code: 128, stdout: "" })
    const { lifecycle } = build(runner)
    await expect(lifecycle.pruneWorktrees("/tmp", FALLBACK)).rejects.toThrow(/Not a git repository/)
  })
})
