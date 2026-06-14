import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CheckpointConfig } from "../checkpoint/config.ts";
import { SnapshotStore } from "../checkpoint/index.ts";
import { Sqlite } from "../checkpoint/sqlite.ts";
import { BashScanner, GitPorcelain } from "../checkpoint/parse.ts";
import { CheckpointPlanner } from "../checkpoint/planner.ts";
import { RewindEngine, type RewindSeverity } from "../checkpoint/rewind.ts";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface GitRoot {
  root: string;
  error: string | undefined;
}

interface ToolStartEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  isError?: boolean;
}

interface PromptEvent {
  prompt: string;
}

interface SessionStartEvent {
  reason: string;
}

const WRITE_TOOLS = new Set(["write", "edit"]);

function pathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") {
    return null;
  }

  const record = args as Record<string, unknown>;

  for (const key of ["path", "file_path", "filePath", "filename"]) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

function commandFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") {
    return null;
  }

  const value = (args as Record<string, unknown>)["command"];

  return typeof value === "string" && value.trim() ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CheckpointRegistrar {
  private readonly store: SnapshotStore;
  private readonly scanner = new BashScanner();
  private readonly porcelain = new GitPorcelain();
  private readonly planner: CheckpointPlanner;
  private readonly rewind: RewindEngine;
  private pendingLabel = "";

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: CheckpointConfig,
  ) {
    this.store = new SnapshotStore(config, new Sqlite());
    this.planner = new CheckpointPlanner(this.store, config);
    this.rewind = new RewindEngine(this.store, config, withFileMutationQueue);
  }

  register(): void {
    this.bindEvents();

    this.pi.registerCommand("checkpoint", {
      description: "Snapshot every file in the git working set (usage: /checkpoint [label])",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        await this.runCheckpoint(args ?? "", ctx);
      },
    });

    this.pi.registerCommand("rewind", {
      description: "Rewind files to a previous checkpoint (usage: /rewind [n] [dry])",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        await this.runRewind(args ?? "", ctx);
      },
    });
  }

  private bindEvents(): void {
    this.pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
      this.store.ensureSession(ctx.sessionManager.getSessionFile());
      this.store.resetLabel();
      this.pendingLabel = "";

      try {
        this.store.prune();
      } catch {}
    });

    this.pi.on("before_agent_start", (event: PromptEvent) => {
      this.pendingLabel = typeof event.prompt === "string" ? this.store.excerpt(event.prompt) : "";

      return undefined;
    });

    this.pi.on("agent_start", () => {
      if (this.pendingLabel) {
        this.store.setLabel(this.pendingLabel);
        this.pendingLabel = "";
      }
    });

    this.pi.on("tool_execution_start", (event: ToolStartEvent, ctx: ExtensionContext) => {
      try {
        if (WRITE_TOOLS.has(event.toolName)) {
          const target = pathFromArgs(event.args);

          if (target) {
            this.store.capture(event.toolCallId, target, ctx.cwd);
          }
        } else if (event.toolName === "bash") {
          const command = commandFromArgs(event.args);

          if (command && this.store.matchesBashHeuristic(command)) {
            for (const candidate of this.scanner.candidates(command, ctx.cwd, this.config.maxBashFiles)) {
              this.store.capture(event.toolCallId, candidate.path, ctx.cwd);
            }
          }
        }
      } catch {}
    });

    this.pi.on("tool_result", (event: ToolResultEvent) => {
      try {
        if (WRITE_TOOLS.has(event.toolName) || event.toolName === "bash") {
          if (event.isError) {
            this.store.discard(event.toolCallId);
          } else {
            this.store.commit(event.toolCallId);
          }
        }
      } catch {}

      return undefined;
    });

    this.pi.on("turn_end", () => {
      this.store.discardAll();
    });

    this.pi.on("agent_end", () => {
      this.store.discardAll();
    });
  }

  private async runCheckpoint(args: string, ctx: ExtensionCommandContext): Promise<void> {
    this.store.ensureSession(ctx.sessionManager.getSessionFile());

    const label = (args ?? "").trim() || `manual checkpoint ${new Date().toISOString()}`;
    const resolved = await this.resolveGitRoot(ctx);

    if (resolved.error !== undefined) {
      this.emit(ctx, resolved.error, "warning");

      return;
    }

    const paths = await this.collectPorcelain(ctx);

    if (typeof paths === "string") {
      this.emit(ctx, paths, "warning");

      return;
    }

    if (paths.length === 0) {
      this.emit(ctx, "Git working set is clean; nothing to checkpoint.", "warning");

      return;
    }

    const collected = this.planner.collectTargets(resolved.root, paths);
    const toolCallId = `manual-${randomUUID().slice(0, 8)}`;
    const summary = this.planner.snapshot(toolCallId, collected.targets, ctx.cwd, label, collected.truncated);
    const rendered = this.planner.summaryText(label, summary);

    this.emit(ctx, rendered.text, rendered.severity);
  }

  private async runRewind(args: string, ctx: ExtensionCommandContext): Promise<void> {
    this.store.ensureSession(ctx.sessionManager.getSessionFile());

    const groups = this.store.groups();

    if (groups.length === 0) {
      this.emit(ctx, "No checkpoints recorded for this session yet.", "info");

      return;
    }

    const parsed = this.rewind.parseArgs(args, groups.length);

    if (parsed.numericPresent && parsed.index === -1) {
      this.emit(
        ctx,
        `Checkpoint ${parsed.numericValue} not found; ${groups.length} available.\n${this.rewind.listing(groups)}`,
        "warning",
      );

      return;
    }

    if (!parsed.numericPresent && parsed.unknown.length > 0) {
      this.emit(ctx, `Usage: /rewind [n] [dry]\n${this.rewind.listing(groups)}`, "warning");

      return;
    }

    let index = parsed.index;

    if (index === -1) {
      if (!ctx.hasUI) {
        this.emit(
          ctx,
          `Available checkpoints (newest first):\n${this.rewind.listing(groups)}\nRun /rewind <n> to restore or /rewind <n> dry to preview.`,
          "info",
        );

        return;
      }

      const options = groups.map((group, i) => this.rewind.optionLabel(group, i));
      const choice = await ctx.ui.select("Rewind to before…", options);

      if (choice === undefined) {
        return;
      }

      index = options.indexOf(choice);

      if (index === -1) {
        return;
      }
    }

    const group = groups[index];
    const entries = this.store.readManifest();
    const plan = this.rewind.buildPlan(entries, group.firstIndex, ctx.cwd);
    const actionable = plan.filter((item) => item.action === "restore" || item.action === "delete");
    const lines = this.rewind.planLines(plan);

    if (parsed.dry) {
      this.emit(ctx, `Dry run for "${group.label}":\n${lines}`, "info");

      return;
    }

    if (actionable.length === 0) {
      this.emit(ctx, `Nothing to restore for "${group.label}":\n${lines}`, "info");

      return;
    }

    if (ctx.hasUI) {
      const restoreOption = `Restore ${actionable.length} file(s)`;
      const previewOption = "Preview (dry run)";
      const picked = await ctx.ui.select(`Rewind: ${group.label}`, [restoreOption, previewOption, "Cancel"]);

      if (picked === undefined || picked === "Cancel") {
        return;
      }

      if (picked === previewOption) {
        this.emit(ctx, `Dry run for "${group.label}":\n${lines}`, "info");

        return;
      }

      const confirmed = await ctx.ui.confirm(
        `Restore ${actionable.length} file(s)?`,
        `${lines}\n\nProceed with restore?`,
      );

      if (!confirmed) {
        return;
      }
    } else {
      this.emit(ctx, `Restoring "${group.label}":\n${lines}`, "info");
    }

    const result = await this.rewind.applyPlan(plan);
    const rendered: { text: string; severity: RewindSeverity } = this.rewind.summarize(result);

    this.emit(ctx, rendered.text, rendered.severity);
  }

  private emit(ctx: ExtensionContext, text: string, severity: "info" | "warning" | "error"): void {
    if (ctx.hasUI) {
      ctx.ui.notify(text, severity);

      return;
    }

    if (ctx.mode === "rpc" || ctx.mode === "json") {
      process.stderr.write(`${text}\n`);

      return;
    }

    process.stdout.write(`${text}\n`);
  }

  private async resolveGitRoot(ctx: ExtensionCommandContext): Promise<GitRoot> {
    let top: ExecResult;

    try {
      top = await this.pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 10000 });
    } catch (error) {
      return { root: "", error: `git unavailable: ${errorMessage(error)}` };
    }

    if (top.code !== 0) {
      return { root: "", error: "Not inside a git repository; nothing to checkpoint." };
    }

    const root = top.stdout.trim();

    if (!root) {
      return { root: "", error: "Could not resolve the git repository root." };
    }

    return { root, error: undefined };
  }

  private async collectPorcelain(ctx: ExtensionCommandContext): Promise<string[] | string> {
    let status: ExecResult;

    try {
      status = await this.pi.exec("git", ["-C", ctx.cwd, "status", "--porcelain"], { timeout: 30000 });
    } catch (error) {
      return `git status failed: ${errorMessage(error)}`;
    }

    if (status.code !== 0) {
      return `git status failed: ${status.stderr.trim() || `exit code ${status.code}`}`;
    }

    return this.porcelain.parse(status.stdout);
  }
}
