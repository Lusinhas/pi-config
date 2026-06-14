import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Git, Lifecycle, Worktrees, type ExecResult } from "../worktrees/index.ts";
import { Include } from "../worktrees/include.ts";
import { Launcher, type OpenSession } from "../worktrees/launch.ts";
import { Renderer, type WorktreeConfig } from "../worktrees/render.ts";
import type { LifecycleHub } from "./lifecycle.ts";

interface SessionStartEvent {
  reason?: string;
  previousSessionFile?: string;
}

const SUBCOMMANDS = ["list", "new", "open", "rm", "clean"];

function emit(ctx: ExtensionContext, text: string, severity: "info" | "warning" | "error"): void {
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

export class WorktreesRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: WorktreeConfig;
  private readonly hub: LifecycleHub;
  private readonly git: Git;
  private readonly worktrees: Worktrees;
  private readonly include: Include;
  private readonly lifecycle: Lifecycle;
  private readonly launcher: Launcher;
  private readonly renderer: Renderer;

  constructor(pi: ExtensionAPI, config: WorktreeConfig, hub: LifecycleHub) {
    this.pi = pi;
    this.config = config;
    this.hub = hub;
    this.git = new Git((command, args, options) => pi.exec(command, args, options) as Promise<ExecResult>);
    this.worktrees = new Worktrees(this.git);
    this.include = new Include(this.git);
    this.lifecycle = new Lifecycle(this.git, this.worktrees, this.include);
    this.launcher = new Launcher(this.git, this.worktrees);
    this.renderer = new Renderer(this.worktrees);
  }

  register(): void {
    this.pi.registerFlag("worktree", {
      description:
        "Create or reuse the named git worktree at startup; prints restart instructions if the session is not already inside it",
      type: "string",
      default: "",
    });

    this.hub.on<SessionStartEvent, undefined>("session_start", async (_event, ctx) => {
      await this.autoCreate(ctx);

      return undefined;
    });

    this.registerCommand();
  }

  private async autoCreate(ctx: ExtensionContext): Promise<void> {
    const value = this.pi.getFlag("worktree");

    if (typeof value !== "string") {
      return;
    }

    const name = value.trim();

    if (!name) {
      return;
    }

    try {
      const outcome = await this.lifecycle.createWorktree(ctx.cwd, this.config, name, undefined);

      if (this.worktrees.isInside(ctx.cwd, outcome.path)) {
        emit(ctx, `Worktree "${name}" active: this session is running inside ${outcome.path}.`, "info");
        return;
      }

      const verb = outcome.created ? "created" : "already exists";
      const copyNote = outcome.copied > 0 ? ` Copied ${outcome.copied} file(s) matching ${this.config.includeFile}.` : "";
      emit(
        ctx,
        `Worktree "${name}" ${verb} at ${outcome.path} (branch ${outcome.branch}).${copyNote} This session runs in ${ctx.cwd} and pi cannot relocate its cwd mid-session; restart inside the worktree:\n  cd ${outcome.path} && pi`,
        "warning",
      );
    } catch (error) {
      emit(ctx, `--worktree ${name}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private registerCommand(): void {
    this.pi.registerCommand("worktree", {
      description: "Manage git worktrees: list | new <name> [ref] | open <name> | rm <name> | clean",
      getArgumentCompletions: (prefix: string) => {
        const head = (prefix ?? "").trim().split(/\s+/)[0] ?? "";
        const matches = SUBCOMMANDS.filter((sub) => sub.startsWith(head));

        return matches.length > 0 ? matches.map((sub) => ({ value: sub, label: sub })) : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
        const sub = tokens[0] ?? "list";

        try {
          if (sub === "list" || sub === "ls") {
            emit(ctx, await this.renderList(ctx), "info");
          } else if (sub === "new" || sub === "add" || sub === "create") {
            await this.handleNew(ctx, tokens);
          } else if (sub === "open") {
            await this.handleOpen(ctx, tokens);
          } else if (sub === "rm" || sub === "remove") {
            await this.handleRemove(ctx, tokens);
          } else if (sub === "clean" || sub === "prune") {
            emit(ctx, await this.lifecycle.pruneWorktrees(ctx.cwd, this.config), "info");
          } else {
            emit(ctx, `Unknown subcommand "${sub}".\n${this.renderer.usage(this.config)}`, "warning");
          }
        } catch (error) {
          emit(ctx, error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  }

  private async renderList(ctx: ExtensionContext): Promise<string> {
    const repo = await this.worktrees.detectRepo(ctx.cwd, this.config);
    const base = this.worktrees.worktreeBase(this.config, repo.mainRoot);

    return this.renderer.renderList(repo, base, ctx.cwd);
  }

  private async handleNew(ctx: ExtensionCommandContext, tokens: string[]): Promise<void> {
    const name = tokens[1];

    if (!name) {
      emit(ctx, `Missing worktree name.\n${this.renderer.usage(this.config)}`, "warning");
      return;
    }

    const outcome = await this.lifecycle.createWorktree(ctx.cwd, this.config, name, tokens[2]);
    const lines: string[] = [];

    if (outcome.created) {
      lines.push(`Created worktree "${outcome.name}" at ${outcome.path} on branch ${outcome.branch} from ${outcome.ref}.`);

      if (outcome.copied > 0) {
        lines.push(`Copied ${outcome.copied} file(s) matching ${this.config.includeFile}.`);
      }

      if (outcome.copyFailed > 0) {
        lines.push(`${outcome.copyFailed} include file(s) failed to copy.`);
      }
    } else {
      lines.push(`Worktree "${outcome.name}" already exists at ${outcome.path} (branch ${outcome.branch}).`);
    }

    lines.push(...outcome.notes);
    lines.push(`Open it with: cd ${outcome.path} && pi`);
    lines.push(`Subagent isolation: pass the path as task context, e.g. context: "Work only inside ${outcome.path}".`);
    emit(ctx, lines.join("\n"), outcome.copyFailed > 0 ? "warning" : "info");
  }

  private async handleOpen(ctx: ExtensionCommandContext, tokens: string[]): Promise<void> {
    const name = tokens[1];

    if (!name) {
      emit(ctx, `Missing worktree name.\n${this.renderer.usage(this.config)}`, "warning");
      return;
    }

    const session = this.openSession(ctx);
    const result = await this.launcher.openWorktree(session, this.config, name);
    emit(ctx, result.text, result.severity);
  }

  private async handleRemove(ctx: ExtensionCommandContext, tokens: string[]): Promise<void> {
    const name = tokens[1];

    if (!name) {
      emit(ctx, `Missing worktree name.\n${this.renderer.usage(this.config)}`, "warning");
      return;
    }

    const session = this.openSession(ctx);
    const outcome = await this.lifecycle.removeWorktree(session, this.config, name);
    emit(ctx, outcome.message, outcome.removed ? "info" : "warning");
  }

  private openSession(ctx: ExtensionCommandContext): OpenSession {
    return {
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      confirm: async (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : false),
    };
  }
}
