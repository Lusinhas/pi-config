import { existsSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Include } from "./include.ts";
import type { WorktreeConfig } from "./render.ts";

export interface ExecOptions {
  timeout: number;
}

export interface ExecResult {
  code?: number;
  stdout?: string;
  stderr?: string;
}

export type ExecRunner = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason: string;
  prunable: boolean;
  prunableReason: string;
  isMain: boolean;
}

export interface RepoInfo {
  currentRoot: string;
  mainRoot: string;
  commonDir: string;
  entries: WorktreeEntry[];
}

export interface CreateOutcome {
  name: string;
  path: string;
  branch: string;
  ref: string;
  created: boolean;
  copied: number;
  copyFailed: number;
  copyTruncated: boolean;
  notes: string[];
}

export interface RemoveOutcome {
  removed: boolean;
  message: string;
}

export interface RemoveSession {
  cwd: string;
  hasUI: boolean;
  confirm: (title: string, message: string) => Promise<boolean>;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class Git {
  private readonly runner: ExecRunner;

  constructor(runner: ExecRunner) {
    this.runner = runner;
  }

  async git(cwd: string, args: string[], timeoutMs: number): Promise<GitResult> {
    try {
      const result = await this.runner("git", ["-C", cwd, ...args], { timeout: timeoutMs });
      const code = typeof result.code === "number" ? result.code : -1;

      return { ok: code === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        stdout: "",
        stderr: `git ${args.join(" ")} (in ${cwd}) failed: ${message}`,
        code: -1
      };
    }
  }

  async raw(command: string, args: string[], timeoutMs: number): Promise<GitResult> {
    try {
      const result = await this.runner(command, args, { timeout: timeoutMs });
      const code = typeof result.code === "number" ? result.code : -1;

      return { ok: code === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        stdout: "",
        stderr: `${command} ${args.join(" ")} failed: ${message}`,
        code: -1
      };
    }
  }
}

export class Worktrees {
  private readonly git: Git;

  constructor(git: Git) {
    this.git = git;
  }

  isInside(child: string, parent: string): boolean {
    const rel = relative(resolve(parent), resolve(child));

    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  worktreeBase(config: WorktreeConfig, mainRoot: string): string {
    if (isAbsolute(config.dir)) {
      return join(config.dir, basename(mainRoot));
    }

    return resolve(mainRoot, config.dir);
  }

  validateName(name: string): void {
    if (!NAME_PATTERN.test(name) || name.includes("..")) {
      throw new Error(
        `Invalid worktree name "${name}": use letters, digits, dots, dashes, and underscores, starting with a letter or digit`
      );
    }
  }

  parseList(stdout: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | null = null;

    for (const line of stdout.split("\n")) {
      if (!line.trim()) {
        if (current) {
          entries.push(current);
        }

        current = null;
        continue;
      }

      if (line.startsWith("worktree ")) {
        if (current) {
          entries.push(current);
        }

        current = this.blankEntry(line.slice("worktree ".length));
        continue;
      }

      if (!current) {
        continue;
      }

      this.applyAttribute(current, line);
    }

    if (current) {
      entries.push(current);
    }

    if (entries.length > 0) {
      entries[0].isMain = true;
    }

    return entries;
  }

  async listWorktrees(cwd: string, config: WorktreeConfig): Promise<WorktreeEntry[]> {
    const result = await this.git.git(cwd, ["worktree", "list", "--porcelain"], config.gitTimeoutMs);

    if (!result.ok) {
      throw new Error(`git worktree list failed: ${this.detail(result) || "unknown error"}`);
    }

    return this.parseList(result.stdout);
  }

  async detectRepo(cwd: string, config: WorktreeConfig): Promise<RepoInfo> {
    const probe = await this.git.git(
      cwd,
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--path-format=absolute", "--git-common-dir"],
      config.gitTimeoutMs
    );

    let inside = false;
    let currentRoot = "";
    let commonDir = "";

    if (probe.ok) {
      const lines = probe.stdout.split("\n").map(line => line.trim()).filter(Boolean);
      inside = lines[0] === "true";
      currentRoot = lines[1] ?? "";
      commonDir = lines[2] ?? "";
    }

    if (!inside) {
      const fallbackInside = await this.git.git(cwd, ["rev-parse", "--is-inside-work-tree"], config.gitTimeoutMs);

      if (!fallbackInside.ok || fallbackInside.stdout.trim() !== "true") {
        throw new Error(`Not a git repository: ${cwd}. Worktree operations only work inside a git checkout.`);
      }

      inside = true;
    }

    if (!currentRoot) {
      const top = await this.git.git(cwd, ["rev-parse", "--show-toplevel"], config.gitTimeoutMs);

      if (!top.ok || !top.stdout.trim()) {
        throw new Error(`Could not resolve the repository root: ${top.stderr.trim() || "git rev-parse failed"}`);
      }

      currentRoot = top.stdout.trim();
    }

    if (!commonDir || !isAbsolute(commonDir)) {
      const fallback = await this.git.git(cwd, ["rev-parse", "--git-common-dir"], config.gitTimeoutMs);

      if (!fallback.ok || !fallback.stdout.trim()) {
        throw new Error(`Could not resolve the git common dir: ${fallback.stderr.trim() || "git rev-parse failed"}`);
      }

      commonDir = resolve(cwd, fallback.stdout.trim());
    }

    const entries = await this.listWorktrees(cwd, config);
    const mainRoot = entries.length > 0 ? entries[0].path : currentRoot;

    return { currentRoot, mainRoot, commonDir, entries };
  }

  findEntry(entries: WorktreeEntry[], base: string, name: string): WorktreeEntry | undefined {
    const target = resolve(base, name);
    const exact = entries.find(entry => resolve(entry.path) === target);

    if (exact) {
      return exact;
    }

    const named = entries.filter(entry => !entry.isMain && basename(entry.path) === name);

    if (named.length <= 1) {
      return named[0];
    }

    const managed = named.filter(entry => this.isInside(entry.path, base));

    if (managed.length === 1) {
      return managed[0];
    }

    throw new Error(
      `Multiple worktrees are named "${name}": ${named.map(entry => entry.path).join(", ")}. Remove the extras with git worktree remove <path>.`
    );
  }

  private blankEntry(path: string): WorktreeEntry {
    return {
      path,
      head: "",
      branch: null,
      detached: false,
      bare: false,
      locked: false,
      lockedReason: "",
      prunable: false,
      prunableReason: "",
      isMain: false
    };
  }

  private applyAttribute(entry: WorktreeEntry, line: string): void {
    if (line.startsWith("HEAD ")) {
      entry.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      entry.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      entry.detached = true;
    } else if (line === "bare") {
      entry.bare = true;
    } else if (line === "locked") {
      entry.locked = true;
    } else if (line.startsWith("locked ")) {
      entry.locked = true;
      entry.lockedReason = line.slice("locked ".length);
    } else if (line === "prunable") {
      entry.prunable = true;
    } else if (line.startsWith("prunable ")) {
      entry.prunable = true;
      entry.prunableReason = line.slice("prunable ".length);
    }
  }

  private detail(result: GitResult): string {
    return (result.stderr || result.stdout).trim();
  }
}

export class Lifecycle {
  private readonly git: Git;
  private readonly worktrees: Worktrees;
  private readonly include: Include;

  constructor(git: Git, worktrees: Worktrees, include: Include) {
    this.git = git;
    this.worktrees = worktrees;
    this.include = include;
  }

  async createWorktree(
    cwd: string,
    config: WorktreeConfig,
    name: string,
    ref: string | undefined
  ): Promise<CreateOutcome> {
    this.worktrees.validateName(name);
    const repo = await this.worktrees.detectRepo(cwd, config);
    const base = this.worktrees.worktreeBase(config, repo.mainRoot);
    const existing = this.worktrees.findEntry(repo.entries, base, name);

    if (existing) {
      if (existing.isMain) {
        throw new Error(`"${name}" resolves to the main worktree at ${existing.path}; refusing to touch it`);
      }

      return {
        name,
        path: existing.path,
        branch: existing.branch ?? `(detached ${existing.head.slice(0, 9)})`,
        ref: existing.head.slice(0, 9),
        created: false,
        copied: 0,
        copyFailed: 0,
        copyTruncated: false,
        notes: []
      };
    }

    const target = join(base, name);

    if (existsSync(target)) {
      throw new Error(`Path ${target} exists but is not a registered worktree; remove it or pick another name`);
    }

    const branch = `${config.branchPrefix}${name}`;
    const holder = repo.entries.find(entry => entry.branch === branch);

    if (holder) {
      throw new Error(`Branch ${branch} is already checked out at ${holder.path}`);
    }

    const baseRef = (ref ?? "").trim() || config.defaultRef;
    const branchExists = (
      await this.git.git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], config.gitTimeoutMs)
    ).ok;

    mkdirSync(base, { recursive: true });
    const excludeNote = this.include.ensureExcluded(repo, base);
    const notes: string[] = [];

    if (excludeNote) {
      notes.push(excludeNote);
    }

    let added: GitResult;

    if (branchExists) {
      notes.push(`Reused existing branch ${branch}; the [ref] argument was ignored.`);
      added = await this.git.git(cwd, ["worktree", "add", target, branch], config.gitTimeoutMs);
    } else {
      const verified = await this.git.git(
        cwd,
        ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`],
        config.gitTimeoutMs
      );

      if (!verified.ok) {
        throw new Error(
          `Unknown ref "${baseRef}"; it must resolve to a commit (a repository with no commits cannot host worktrees)`
        );
      }

      added = await this.git.git(cwd, ["worktree", "add", "-b", branch, target, baseRef], config.gitTimeoutMs);
    }

    if (!added.ok) {
      throw new Error(`git worktree add failed: ${this.detail(added) || "unknown error"}`);
    }

    const copy = await this.include.copyIncludes(config, repo.mainRoot, base, target);

    if (copy.truncated) {
      notes.push(`Include copy truncated at ${config.maxIncludeFiles} files.`);
    }

    return {
      name,
      path: target,
      branch,
      ref: baseRef,
      created: true,
      copied: copy.copied,
      copyFailed: copy.failed,
      copyTruncated: copy.truncated,
      notes
    };
  }

  async removeWorktree(session: RemoveSession, config: WorktreeConfig, name: string): Promise<RemoveOutcome> {
    const repo = await this.worktrees.detectRepo(session.cwd, config);
    const base = this.worktrees.worktreeBase(config, repo.mainRoot);
    const entry = this.worktrees.findEntry(repo.entries, base, name);

    if (!entry) {
      throw new Error(`No worktree named "${name}".${this.knownHint(repo)}`);
    }

    if (entry.isMain) {
      throw new Error(`"${name}" is the main worktree at ${entry.path}; refusing to touch it`);
    }

    if (this.worktrees.isInside(session.cwd, entry.path)) {
      throw new Error(`Cannot remove ${entry.path}: the current session is running inside it`);
    }

    if (!existsSync(entry.path)) {
      const pruned = await this.git.git(session.cwd, ["worktree", "prune"], config.gitTimeoutMs);

      if (!pruned.ok) {
        throw new Error(`Worktree directory is already gone and prune failed: ${this.detail(pruned)}`);
      }

      return {
        removed: true,
        message: `Worktree "${name}" directory was already gone; pruned its stale registration.`
      };
    }

    const status = await this.git.git(entry.path, ["status", "--porcelain"], config.gitTimeoutMs);

    if (!status.ok) {
      throw new Error(`Could not check worktree status: ${this.detail(status) || "git status failed"}`);
    }

    const dirty = status.stdout.trim().length > 0;
    let force = false;

    if (dirty) {
      if (!session.hasUI) {
        throw new Error(
          `Worktree "${name}" has uncommitted changes; refusing to remove it without a UI. Commit or stash the changes, or remove it interactively.`
        );
      }

      const confirmed = await session.confirm(
        "Remove dirty worktree",
        `"${name}" at ${entry.path} has uncommitted changes. Force remove and discard them?`
      );

      if (!confirmed) {
        return { removed: false, message: `Kept worktree "${name}" at ${entry.path}.` };
      }

      force = true;
    } else if (config.confirmRemove && session.hasUI) {
      const confirmed = await session.confirm("Remove worktree", `Remove "${name}" at ${entry.path}?`);

      if (!confirmed) {
        return { removed: false, message: `Kept worktree "${name}" at ${entry.path}.` };
      }
    }

    const args = force ? ["worktree", "remove", "--force", entry.path] : ["worktree", "remove", entry.path];
    const removed = await this.git.git(session.cwd, args, config.gitTimeoutMs);

    if (!removed.ok) {
      throw new Error(`git worktree remove failed: ${this.detail(removed) || "unknown error"}`);
    }

    const branchNote = await this.deleteBranch(session.cwd, config, entry);

    return { removed: true, message: `Removed worktree "${name}" at ${entry.path}.${branchNote}` };
  }

  async pruneWorktrees(cwd: string, config: WorktreeConfig): Promise<string> {
    const inside = await this.git.git(cwd, ["rev-parse", "--is-inside-work-tree"], config.gitTimeoutMs);

    if (!inside.ok || inside.stdout.trim() !== "true") {
      throw new Error(`Not a git repository: ${cwd}. Worktree operations only work inside a git checkout.`);
    }

    const result = await this.git.git(cwd, ["worktree", "prune", "--verbose"], config.gitTimeoutMs);

    if (!result.ok) {
      throw new Error(`git worktree prune failed: ${this.detail(result) || "unknown error"}`);
    }

    const output = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);

    if (output.length === 0) {
      return "Nothing to prune; every registered worktree is intact.";
    }

    return `Pruned stale worktree records:\n${output.map(line => `  ${line}`).join("\n")}`;
  }

  private async deleteBranch(cwd: string, config: WorktreeConfig, entry: WorktreeEntry): Promise<string> {
    if (!entry.branch || !config.branchPrefix || !entry.branch.startsWith(config.branchPrefix)) {
      return "";
    }

    const deleted = await this.git.git(cwd, ["branch", "-d", entry.branch], config.gitTimeoutMs);

    return deleted.ok
      ? ` Branch ${entry.branch} deleted.`
      : ` Branch ${entry.branch} kept (not fully merged; delete it with git branch -D ${entry.branch}).`;
  }

  private knownHint(repo: RepoInfo): string {
    const known = repo.entries.filter(item => !item.isMain).map(item => basename(item.path));

    return known.length > 0 ? ` Known worktrees: ${known.join(", ")}.` : " No linked worktrees exist.";
  }

  private detail(result: GitResult): string {
    return (result.stderr || result.stdout).trim();
  }
}
