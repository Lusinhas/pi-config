import { basename } from "node:path";
import type { RepoInfo, WorktreeEntry, Worktrees } from "./index.ts";

export interface WorktreeConfig {
  dir: string;
  branchPrefix: string;
  includeFile: string;
  defaultRef: string;
  allowSpawn: boolean;
  spawnCommand: string;
  confirmRemove: boolean;
  maxIncludeFiles: number;
  gitTimeoutMs: number;
}

type Plain = Record<string, unknown>;

export const FALLBACK: WorktreeConfig = {
  dir: ".worktrees",
  branchPrefix: "wt/",
  includeFile: ".worktreeinclude",
  defaultRef: "HEAD",
  allowSpawn: false,
  spawnCommand: "pi",
  confirmRemove: true,
  maxIncludeFiles: 500,
  gitTimeoutMs: 30000
};

const BRANCH_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

export class Config {
  private readonly merged: WorktreeConfig;

  constructor(layers: unknown[]) {
    let accumulated: Plain = { ...FALLBACK };

    for (const layer of layers) {
      accumulated = Config.deepMerge(accumulated, layer);
    }

    this.merged = Config.sanitize(accumulated);
  }

  get value(): WorktreeConfig {
    return this.merged;
  }

  static overlayFrom(source: unknown): unknown {
    if (source && typeof source === "object" && !Array.isArray(source)) {
      return (source as Plain)["worktrees"];
    }

    return undefined;
  }

  static deepMerge(base: Plain, override: unknown): Plain {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      return base;
    }

    const out: Plain = { ...base };

    for (const [key, value] of Object.entries(override as Plain)) {
      const existing = out[key];
      const bothPlain =
        existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing) &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);

      if (bothPlain) {
        out[key] = Config.deepMerge(existing as Plain, value);
      } else if (value !== undefined) {
        out[key] = value;
      }
    }

    return out;
  }

  static sanitize(raw: Plain): WorktreeConfig {
    const prefix = typeof raw.branchPrefix === "string" ? raw.branchPrefix.trim() : FALLBACK.branchPrefix;

    return {
      dir: Config.str(raw.dir, FALLBACK.dir),
      branchPrefix: BRANCH_PREFIX_PATTERN.test(prefix) ? prefix : FALLBACK.branchPrefix,
      includeFile: Config.str(raw.includeFile, FALLBACK.includeFile),
      defaultRef: Config.str(raw.defaultRef, FALLBACK.defaultRef),
      allowSpawn: Config.bool(raw.allowSpawn, FALLBACK.allowSpawn),
      spawnCommand: Config.str(raw.spawnCommand, FALLBACK.spawnCommand),
      confirmRemove: Config.bool(raw.confirmRemove, FALLBACK.confirmRemove),
      maxIncludeFiles: Config.num(raw.maxIncludeFiles, FALLBACK.maxIncludeFiles),
      gitTimeoutMs: Config.num(raw.gitTimeoutMs, FALLBACK.gitTimeoutMs)
    };
  }

  private static str(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  private static bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private static num(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }
}

export interface Row {
  marker: string;
  name: string;
  kind: string;
  branch: string;
  head: string;
  path: string;
  flags: string;
}

const HEAD_WIDTH = 9;

export class Table {
  format(rows: Row[]): string[] {
    const nameWidth = Math.max(4, ...rows.map(row => row.name.length));
    const kindWidth = Math.max(4, ...rows.map(row => row.kind.length));
    const branchWidth = Math.max(6, ...rows.map(row => row.branch.length));

    return rows.map(row => {
      const flagText = row.flags ? `  [${row.flags}]` : "";

      return `${row.marker} ${row.name.padEnd(nameWidth)}  ${row.kind.padEnd(kindWidth)}  ${row.branch.padEnd(branchWidth)}  ${row.head.padEnd(HEAD_WIDTH)}  ${row.path}${flagText}`;
    });
  }
}

export class Renderer {
  private readonly worktrees: Worktrees;
  private readonly table: Table;

  constructor(worktrees: Worktrees, table: Table = new Table()) {
    this.worktrees = worktrees;
    this.table = table;
  }

  shortHead(head: string): string {
    return head ? head.slice(0, 9) : "-";
  }

  usage(config: WorktreeConfig): string {
    return [
      "Usage: /worktree <subcommand>",
      "  list               show every worktree registered for this repo",
      `  new <name> [ref]   create ${config.dir}/<name> on branch ${config.branchPrefix}<name> (ref defaults to ${config.defaultRef})`,
      "  open <name>        print how to launch pi inside a worktree",
      "  rm <name>          remove a worktree after a dirty check and confirmation",
      "  clean              prune stale worktree registrations"
    ].join("\n");
  }

  renderList(repo: RepoInfo, base: string, cwd: string): string {
    const rows = repo.entries.map(entry => this.toRow(entry, base, cwd));
    const lines = this.table.format(rows);

    return `Worktrees (${rows.length}):\n${lines.join("\n")}\n* = contains the current session cwd`;
  }

  private toRow(entry: WorktreeEntry, base: string, cwd: string): Row {
    const marker = this.worktrees.isInside(cwd, entry.path) ? "*" : " ";
    const kind = entry.isMain ? "main" : this.worktrees.isInside(entry.path, base) ? "managed" : "linked";
    const branch = entry.bare
      ? "(bare)"
      : entry.detached
        ? `(detached ${this.shortHead(entry.head)})`
        : entry.branch ?? "-";
    const flags: string[] = [];

    if (entry.locked) {
      flags.push(entry.lockedReason ? `locked: ${entry.lockedReason}` : "locked");
    }

    if (entry.prunable) {
      flags.push(entry.prunableReason ? `prunable: ${entry.prunableReason}` : "prunable");
    }

    return {
      marker,
      name: basename(entry.path) || entry.path,
      kind,
      branch,
      head: this.shortHead(entry.head),
      path: entry.path,
      flags: flags.join(", ")
    };
  }
}
