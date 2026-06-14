import type { Git, WorktreeEntry, Worktrees } from "./index.ts";
import type { WorktreeConfig } from "./render.ts";

export interface LaunchOutcome {
  text: string;
  severity: "info" | "warning";
}

export interface OpenSession {
  cwd: string;
  hasUI: boolean;
  confirm: (title: string, message: string) => Promise<boolean>;
}

const SPAWN_TIMEOUT_MS = 10000;

export class Launcher {
  private readonly git: Git;
  private readonly worktrees: Worktrees;

  constructor(git: Git, worktrees: Worktrees) {
    this.git = git;
    this.worktrees = worktrees;
  }

  async openWorktree(session: OpenSession, config: WorktreeConfig, name: string): Promise<LaunchOutcome> {
    const repo = await this.worktrees.detectRepo(session.cwd, config);
    const base = this.worktrees.worktreeBase(config, repo.mainRoot);
    const entry = this.worktrees.findEntry(repo.entries, base, name);

    if (!entry) {
      throw new Error(`No worktree named "${name}"; create it with /worktree new ${name}`);
    }

    if (entry.isMain) {
      throw new Error(`"${name}" is the main worktree at ${entry.path}; this session already manages it`);
    }

    if (this.worktrees.isInside(session.cwd, entry.path)) {
      return { text: `Already inside worktree "${name}" at ${entry.path}.`, severity: "info" };
    }

    if (entry.prunable) {
      return {
        text: `Worktree "${name}" is prunable (${entry.prunableReason || "directory missing"}); run /worktree clean and recreate it.`,
        severity: "warning"
      };
    }

    const lines = [this.launchInstructions(entry)];

    if (config.allowSpawn && session.hasUI) {
      const confirmed = await session.confirm(
        "Spawn shell",
        `Start a detached shell running "${config.spawnCommand}" in ${entry.path}?`
      );

      if (confirmed) {
        lines.push(await this.spawnShell(config, entry.path));
      } else {
        lines.push("Spawn declined; run the command above manually.");
      }
    } else if (config.allowSpawn) {
      lines.push("allowSpawn is enabled but no UI is available; run the command above manually.");
    }

    return { text: lines.join("\n"), severity: "info" };
  }

  launchInstructions(entry: WorktreeEntry): string {
    const branch = entry.branch ?? `detached at ${entry.head.slice(0, 9)}`;

    return [
      `Worktree ready at ${entry.path} (${branch}).`,
      "pi cannot change its working directory mid-session, so start a fresh session inside the worktree yourself:",
      `  cd ${this.shellQuote(entry.path)} && pi`,
      "or resume a previous session that already lives there:",
      `  cd ${this.shellQuote(entry.path)} && pi --resume`
    ].join("\n");
  }

  async spawnShell(config: WorktreeConfig, path: string): Promise<string> {
    const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL.trim() : "/bin/sh";
    const command = `cd ${this.shellQuote(path)} && nohup ${this.shellQuote(shell)} -lc ${this.shellQuote(config.spawnCommand)} >/dev/null 2>&1 &`;
    const result = await this.git.raw("/bin/sh", ["-c", command], SPAWN_TIMEOUT_MS);

    if (result.code !== 0) {
      throw new Error(`Failed to spawn shell: ${this.detail(result) || `exit code ${result.code}`}`);
    }

    return `Spawned a detached ${shell} running "${config.spawnCommand}" in ${path}. It has no terminal attached, so prefer running the printed command in your own terminal.`;
  }

  shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private detail(result: { stderr: string; stdout: string }): string {
    return (result.stderr || result.stdout).trim();
  }
}
