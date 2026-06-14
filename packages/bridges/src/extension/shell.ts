import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionCommandContext,
  type ExtensionContext,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JobManager, type JobSnapshot } from "../shell/index.ts";
import { Config, type ShellConfig, isRecord } from "../shell/config.ts";
import { Sandbox, type ExecFn, type SandboxSettings } from "../shell/sandbox.ts";
import type { SandboxMode, SandboxNetwork } from "../shell/config.ts";
import { Renderer } from "../shell/widget.ts";
import type { LifecycleHub } from "./lifecycle.ts";

interface BashArgs {
  command?: string;
  timeout?: number;
}

interface JobsArgs {
  op: "list" | "peek" | "kill" | "wait";
  id?: string;
  lines?: number;
  waitSec?: number;
}

interface ToolText {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolText[];
  details: Record<string, unknown>;
}

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function requireId(id: string | undefined, op: string): string {
  const trimmed = (id ?? "").trim();

  if (trimmed === "") {
    throw new Error(`op "${op}" requires a job id`);
  }

  return trimmed;
}

export class ShellRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: ShellConfig;
  private readonly hub: LifecycleHub;
  private readonly renderer: Renderer;
  private readonly sandbox: Sandbox;
  private readonly manager: JobManager;
  private readonly execAdapter: ExecFn;
  private readonly userShell: string;

  private lastCtx: ExtensionContext | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(pi: ExtensionAPI, config: ShellConfig, hub: LifecycleHub) {
    this.pi = pi;
    this.config = config;
    this.hub = hub;
    this.renderer = new Renderer((text, options) => truncateTail(text, options));
    this.execAdapter = (cmd, args, options) => pi.exec(cmd, args, options);
    this.sandbox = new Sandbox(this.execAdapter);
    this.userShell = Config.resolveShell(config.shell);
    this.manager = new JobManager(
      {
        capBytes: config.jobs.capBytes,
        autoBackgroundMs: config.jobs.autoBackgroundMs,
        keepFinished: config.jobs.keepFinished,
        onChange: () => this.refreshWidget(),
        onBackgroundDone: (job, output) => this.notifyJobDone(job, output),
      },
      join(homedir(), ".pi", "agent", "jobs", `local-${process.pid}`),
    );
  }

  register(): void {
    this.registerBashTool();
    this.registerJobsTool();
    this.registerJobsCommand();
    this.registerSandboxCommand();

    this.hub.on("session_start", (_event, ctx) => {
      this.lastCtx = ctx;
      this.manager.setSpillDir(join(homedir(), ".pi", "agent", "jobs", this.sessionKey(ctx)));
      this.refreshWidget();

      return undefined;
    });

    this.hub.on("session_shutdown", () => {
      this.manager.killAll();
      this.stopTicker();
      const ctx = this.lastCtx;

      if (ctx !== null && ctx.hasUI) {
        try {
          ctx.ui.setWidget("shelljobs", undefined);
        } catch {
          this.stopTicker();
        }
      }

      return undefined;
    });
  }

  private sessionKey(ctx: ExtensionContext): string {
    let key = `local-${process.pid}`;

    try {
      const file = ctx.sessionManager.getSessionFile();

      if (typeof file === "string" && file !== "") {
        const clean = basename(file)
          .replace(/\.[^.]+$/, "")
          .replace(/[^A-Za-z0-9._-]/g, "");

        if (clean !== "") {
          key = clean;
        }
      }
    } catch {
      key = `local-${process.pid}`;
    }

    return key;
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private startTicker(): void {
    if (this.ticker !== null) {
      return;
    }

    this.ticker = setInterval(() => this.refreshWidget(), 1000);

    if (typeof this.ticker.unref === "function") {
      this.ticker.unref();
    }
  }

  private refreshWidget(): void {
    const ctx = this.lastCtx;

    if (ctx === null || !ctx.hasUI) {
      this.stopTicker();
      return;
    }

    try {
      if (!this.config.widget) {
        ctx.ui.setWidget("shelljobs", undefined);
        this.stopTicker();
        return;
      }

      const running = this.manager.list().filter((job) => job.status === "running" && job.background);
      const lines = this.renderer.renderJobs(running, Date.now(), this.config.widgetLimit);
      ctx.ui.setWidget("shelljobs", lines.length > 0 ? lines : undefined);

      if (lines.length > 0) {
        this.startTicker();
      } else {
        this.stopTicker();
      }
    } catch {
      this.stopTicker();
    }
  }

  private notifyJobDone(job: JobSnapshot, output: string): void {
    if (!this.config.jobs.notify) {
      return;
    }

    const tail = truncateTail(Renderer.cleanOutput(output), { maxBytes: 4096, maxLines: 20 });
    const runtime = Renderer.formatRuntime((job.endedAt ?? Date.now()) - job.startedAt);
    const log = job.spillPath !== null ? `\nFull log: ${job.spillPath}` : "";
    const body = tail.content.trim() === "" ? "(no output)" : tail.content;
    const content = `Background job ${job.id} ${Renderer.describeEnd(job)} after ${runtime}.\nCommand: ${Renderer.clip(Renderer.normalize(job.command), 160)}${log}\nLast output:\n${body}`;

    try {
      this.pi.sendMessage({ customType: "shelljob", content, display: true }, { deliverAs: "followUp" });
    } catch {
      return;
    }
  }

  private persistSandbox(): string | null {
    try {
      const path = join(homedir(), ".pi", "agent", "suite.json");
      const root = readJson(path) ?? {};
      const shellSection = isRecord(root.shell) ? { ...root.shell } : {};
      const sandboxSection = isRecord(shellSection.sandbox) ? { ...shellSection.sandbox } : {};
      sandboxSection.enabled = this.config.sandbox.enabled;
      sandboxSection.mode = this.config.sandbox.mode;
      sandboxSection.network = this.config.sandbox.network;
      shellSection.sandbox = sandboxSection;
      root.shell = shellSection;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");

      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private effectiveMode(): SandboxMode {
    return this.config.sandbox.enabled ? this.config.sandbox.mode : "off";
  }

  private sandboxStatus(): string {
    const paths = this.config.sandbox.writePaths.length > 0 ? this.config.sandbox.writePaths.join(", ") : "(none)";

    return `Sandbox mode: ${this.effectiveMode()} | network: ${this.config.sandbox.network} | escape prefix: ${this.config.sandbox.escape ? "allowed" : "blocked"} | extra write paths: ${paths}`;
  }

  private async applySandboxMode(mode: SandboxMode, ctx: ExtensionCommandContext): Promise<void> {
    this.config.sandbox.mode = mode;
    this.config.sandbox.enabled = mode !== "off";
    const persistError = this.persistSandbox();

    const notify = (message: string, level: "info" | "warning" | "error"): void => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, level);
      }
    };

    if (persistError !== null) {
      notify(`Sandbox set to ${mode} for this session, but saving to suite.json failed: ${persistError}`, "warning");
    } else {
      notify(`Sandbox mode set to ${mode} (saved to ~/.pi/agent/suite.json).`, "info");
    }

    if (mode !== "off") {
      const available = await this.sandbox.wrapperAvailable();

      if (!available) {
        const tool = process.platform === "darwin" ? "sandbox-exec" : "bwrap";
        notify(`Warning: ${tool} is not available on this system; commands will run unsandboxed.`, "warning");
      }
    }
  }

  private applySandboxNetwork(network: SandboxNetwork, ctx: ExtensionCommandContext): void {
    this.config.sandbox.network = network;
    const persistError = this.persistSandbox();

    if (!ctx.hasUI) {
      return;
    }

    if (persistError !== null) {
      ctx.ui.notify(`Sandbox network set to ${network} for this session, but saving failed: ${persistError}`, "warning");
    } else {
      ctx.ui.notify(`Sandbox network set to ${network} (saved).`, "info");
    }
  }

  private renderOutput(raw: string, spillPath: string | null): string {
    return this.renderer.renderOutput(raw, spillPath, this.config.outputBytes, this.config.outputLines);
  }

  private registerBashTool(): void {
    const bashParameters = Type.Object({
      command: Type.String({ description: "The shell command to execute" }),
      timeout: Type.Optional(
        Type.Number({ description: "Optional timeout in seconds; the command is killed when it is exceeded" }),
      ),
    });

    const autoNote =
      this.config.jobs.autoBackgroundMs > 0
        ? ` Commands without a timeout that run longer than ${Math.round(this.config.jobs.autoBackgroundMs / 1000)}s are moved to a background job; the call returns a job id and you manage it with the jobs tool (list, peek, kill, wait).`
        : "";

    this.pi.registerTool({
      name: "bash",
      label: "Bash",
      description: `Execute a command through the user's shell and return interleaved stdout/stderr (truncated to the last ${Math.round(this.config.outputBytes / 1024)}KB / ${this.config.outputLines} lines; longer output is spilled to a readable log file). Optional timeout in seconds kills the command when exceeded.${autoNote} When sandboxing is enabled, commands run with restricted filesystem writes; prefixing a command with "unsandboxed:" bypasses the sandbox only if the escape hatch is enabled in config.`,
      parameters: bashParameters,
      execute: async (_toolCallId, params, signal, onUpdate, ctx): Promise<ToolResult> => {
        this.lastCtx = ctx;
        const args = params as BashArgs;
        const raw = typeof args.command === "string" ? args.command : "";

        if (raw.trim() === "") {
          throw new Error("command must be a non-empty string");
        }

        const escape = this.sandbox.splitEscape(raw, this.config.sandbox.escape);
        const wantSandbox = !escape.bypass && this.config.sandbox.enabled && this.config.sandbox.mode !== "off";
        const available = wantSandbox ? await this.sandbox.wrapperAvailable() : false;
        const rtk = await this.sandbox.rtkAvailable();
        const settings: SandboxSettings = escape.bypass ? { ...this.config.sandbox, enabled: false } : this.config.sandbox;
        const plan = this.sandbox.buildPlan(this.userShell, escape.command, ctx.cwd, settings, available, rtk);
        const timeoutSec =
          typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0
            ? Math.min(Math.ceil(args.timeout), Config.maxTimeoutSec)
            : null;

        const sendUpdate = (text: string): void => {
          if (typeof onUpdate !== "function") {
            return;
          }

          const trunc = truncateTail(Renderer.cleanOutput(text), { maxBytes: 8192, maxLines: 200 });
          onUpdate({ content: [{ type: "text", text: trunc.content }], details: {} });
        };

        const outcome = await this.manager.run({
          argv: plan.argv,
          command: escape.command,
          cwd: ctx.cwd,
          sandboxed: plan.sandboxed,
          timeoutSec,
          signal: signal ?? new AbortController().signal,
          onUpdate: sendUpdate,
          cleanup: plan.cleanup,
        });
        this.refreshWidget();
        const job = outcome.job;
        const prefix = plan.note !== "" && !plan.sandboxed ? `[${plan.note}]\n` : "";

        if (outcome.backgrounded) {
          const seconds = Math.round(this.config.jobs.autoBackgroundMs / 1000);
          const tail = truncateTail(Renderer.cleanOutput(outcome.output), { maxBytes: 8192, maxLines: 50 });
          const body = tail.content.trim() === "" ? "(no output yet)" : tail.content;
          const log = job.spillPath !== null ? `\nFull log: ${job.spillPath}` : "";

          return {
            content: [
              {
                type: "text",
                text: `${prefix}Command is still running after ${seconds}s; it was moved to background job ${job.id} (pid ${job.pid ?? "?"}). Use the jobs tool with id "${job.id}" to peek, wait, or kill it. You will be notified when it finishes.${log}\nOutput so far:\n${body}`,
              },
            ],
            details: {
              backgrounded: true,
              jobId: job.id,
              pid: job.pid,
              spillPath: job.spillPath,
              sandboxed: plan.sandboxed,
            },
          };
        }

        const text = prefix + this.renderOutput(outcome.output, job.spillPath);

        if (outcome.aborted) {
          throw new Error(`${text}\n\nCommand aborted`);
        }

        if (outcome.timedOut) {
          throw new Error(`${text}\n\nCommand timed out after ${timeoutSec ?? 0}s`);
        }

        if (job.exitCode !== 0) {
          const reason =
            job.exitCode !== null
              ? `Exit code ${job.exitCode}`
              : job.exitSignal !== null
                ? `Terminated by signal ${job.exitSignal}`
                : "Command failed to start";

          throw new Error(`${text}\n\n${reason}`);
        }

        return {
          content: [{ type: "text", text }],
          details: { exitCode: 0, jobId: job.id, sandboxed: plan.sandboxed, spillPath: job.spillPath },
        };
      },
    });
  }

  private registerJobsTool(): void {
    const jobsParameters = Type.Object({
      op: StringEnum(["list", "peek", "kill", "wait"], {
        description: "list all jobs, peek at recent output, kill a running job, or wait for one to finish",
      }),
      id: Type.Optional(Type.String({ description: "job id (e.g. j1); required for peek, kill, and wait" })),
      lines: Type.Optional(
        Type.Number({ description: "peek: number of trailing output lines to return (default 50)" }),
      ),
      waitSec: Type.Optional(
        Type.Number({ description: `wait: maximum seconds to block (default ${this.config.jobs.defaultWaitSec}, max 600)` }),
      ),
    });

    this.pi.registerTool({
      name: "jobs",
      label: "Jobs",
      description:
        "Manage shell jobs started by the bash tool. Ops: list (all jobs with status and runtime), peek (id; recent output, optional lines), kill (id; terminates the whole process group, escalating SIGTERM to SIGKILL), wait (id; block until the job finishes or waitSec elapses, then report status and output tail).",
      parameters: jobsParameters,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> => {
        this.lastCtx = ctx;
        const args = params as JobsArgs;

        switch (args.op) {
          case "list": {
            const jobs = this.manager.list();

            return {
              content: [{ type: "text", text: this.renderer.formatJobList(jobs, Date.now()) }],
              details: { jobs },
            };
          }
          case "peek": {
            const id = requireId(args.id, "peek");
            const peeked = this.manager.peek(id);

            if (peeked === null) {
              throw new Error(`No such job: ${id}`);
            }

            const lines = Config.posInt(args.lines, Config.toolPeekLines);
            const trunc = truncateTail(Renderer.cleanOutput(peeked.output), {
              maxBytes: this.config.outputBytes,
              maxLines: Math.min(lines, this.config.outputLines),
            });
            const body = trunc.content.trim() === "" ? "(no output)" : trunc.content;
            const runtime = Renderer.formatRuntime((peeked.job.endedAt ?? Date.now()) - peeked.job.startedAt);
            const head = `${peeked.job.id} [${peeked.job.status}] runtime ${runtime} — ${Renderer.clip(Renderer.normalize(peeked.job.command), 120)}`;

            return {
              content: [{ type: "text", text: `${head}\n${body}` }],
              details: { job: peeked.job },
            };
          }
          case "kill": {
            const id = requireId(args.id, "kill");
            const existing = this.manager.get(id);

            if (existing === null) {
              throw new Error(`No such job: ${id}`);
            }

            if (existing.status !== "running") {
              return {
                content: [{ type: "text", text: `Job ${id} is not running (status: ${existing.status}).` }],
                details: { job: existing },
              };
            }

            this.manager.kill(id);
            const waited = await this.manager.wait(id, 3000);
            const job = waited?.job ?? this.manager.get(id) ?? existing;
            const text =
              job.status === "running"
                ? `Sent SIGTERM to job ${id} (process group ${job.pid ?? "?"}); SIGKILL follows shortly if it does not exit.`
                : `Killed job ${id}; it ${Renderer.describeEnd(job)}.`;
            this.refreshWidget();

            return { content: [{ type: "text", text }], details: { job } };
          }
          case "wait": {
            const id = requireId(args.id, "wait");
            const seconds = Math.min(Config.posInt(args.waitSec, this.config.jobs.defaultWaitSec), Config.maxWaitSec);
            const waited = await this.manager.wait(id, seconds * 1000);

            if (waited === null) {
              throw new Error(`No such job: ${id}`);
            }

            const peeked = this.manager.peek(id);
            const tail = truncateTail(Renderer.cleanOutput(peeked?.output ?? ""), { maxBytes: 8192, maxLines: 40 });
            const body = tail.content.trim() === "" ? "(no output)" : tail.content;
            const text = waited.completed
              ? `Job ${id} ${Renderer.describeEnd(waited.job)}.\nOutput tail:\n${body}`
              : `Job ${id} is still running after ${seconds}s.\nOutput tail:\n${body}`;
            this.refreshWidget();

            return { content: [{ type: "text", text }], details: { job: waited.job, completed: waited.completed } };
          }
          default:
            throw new Error(`unknown op "${String(args.op)}"`);
        }
      },
    });
  }

  private registerJobsCommand(): void {
    this.pi.registerCommand("jobs", {
      description: "List shell jobs; /jobs peek <id> [lines], /jobs kill <id>, or interactive with no arguments",
      getArgumentCompletions: (argumentPrefix: string): CompletionItem[] | null => {
        const prefix = argumentPrefix.trimStart();
        const candidates: CompletionItem[] = [{ value: "list", label: "list", description: "list all jobs" }];

        for (const job of this.manager.list()) {
          candidates.push({
            value: `peek ${job.id}`,
            label: `peek ${job.id}`,
            description: Renderer.clip(Renderer.normalize(job.command), 60),
          });

          if (job.status === "running") {
            candidates.push({
              value: `kill ${job.id}`,
              label: `kill ${job.id}`,
              description: Renderer.clip(Renderer.normalize(job.command), 60),
            });
          }
        }

        const matches = candidates.filter((candidate) => candidate.value.startsWith(prefix));

        return matches.length > 0 ? matches : null;
      },
      handler: async (args, ctx): Promise<void> => {
        this.lastCtx = ctx;

        const notify = (message: string, level: "info" | "warning" | "error"): void => {
          if (ctx.hasUI) {
            ctx.ui.notify(message, level);
          }
        };

        const peekText = (id: string, lines: number): string => {
          const peeked = this.manager.peek(id);

          if (peeked === null) {
            return `No such job: ${id}`;
          }

          const trunc = truncateTail(Renderer.cleanOutput(peeked.output), { maxBytes: 16384, maxLines: lines });
          const body = trunc.content.trim() === "" ? "(no output)" : trunc.content;

          return `${peeked.job.id} [${peeked.job.status}] ${Renderer.clip(Renderer.normalize(peeked.job.command), 100)}\n${body}`;
        };

        const trimmed = (args ?? "").trim();

        if (trimmed === "" && ctx.hasUI) {
          const jobs = this.manager.list();

          if (jobs.length === 0) {
            notify("No jobs.", "info");
            return;
          }

          const now = Date.now();
          const options = jobs.map(
            (job) =>
              `${job.id} · ${job.status} · ${Renderer.formatRuntime((job.endedAt ?? now) - job.startedAt)} · ${Renderer.clip(Renderer.normalize(job.command), 48)}`,
          );
          const picked = await ctx.ui.select("Shell jobs", options);

          if (picked === undefined) {
            return;
          }

          const id = picked.split(" ")[0];
          const job = this.manager.get(id);

          if (job === null) {
            return;
          }

          const actions = job.status === "running" ? ["peek", "kill", "cancel"] : ["peek", "cancel"];
          const action = await ctx.ui.select(`Job ${id}`, actions);

          if (action === "peek") {
            notify(peekText(id, Config.commandPeekLines), "info");
          } else if (action === "kill") {
            const killed = this.manager.kill(id);
            notify(killed ? `Sent SIGTERM to job ${id}.` : `Job ${id} is not running.`, "info");
            this.refreshWidget();
          }

          return;
        }

        if (trimmed === "" || trimmed === "list") {
          notify(this.renderer.formatJobList(this.manager.list(), Date.now()), "info");
          return;
        }

        const [sub, ...rest] = trimmed.split(/\s+/);

        if (sub === "peek") {
          const id = (rest[0] ?? "").trim();

          if (id === "") {
            notify("Usage: /jobs peek <id> [lines]", "error");
            return;
          }

          const lines = Config.posInt(Number(rest[1]), Config.commandPeekLines);
          notify(peekText(id, lines), "info");
          return;
        }

        if (sub === "kill") {
          const id = (rest[0] ?? "").trim();

          if (id === "") {
            notify("Usage: /jobs kill <id>", "error");
            return;
          }

          const existing = this.manager.get(id);

          if (existing === null) {
            notify(`No such job: ${id}`, "error");
            return;
          }

          const killed = this.manager.kill(id);
          notify(killed ? `Sent SIGTERM to job ${id}.` : `Job ${id} is not running (status: ${existing.status}).`, "info");
          this.refreshWidget();
          return;
        }

        notify(`Unknown subcommand "${sub}". Usage: /jobs | /jobs list | /jobs peek <id> [lines] | /jobs kill <id>`, "error");
      },
    });
  }

  private registerSandboxCommand(): void {
    this.pi.registerCommand("sandbox", {
      description: "Show or change shell sandbox mode (off|loose|strict) and network policy; persists to suite.json",
      getArgumentCompletions: (argumentPrefix: string): CompletionItem[] | null => {
        const prefix = argumentPrefix.trimStart();
        const candidates: CompletionItem[] = [
          { value: "status", label: "status", description: "show current sandbox settings" },
          { value: "off", label: "off", description: "disable sandboxing" },
          { value: "loose", label: "loose", description: "read-only filesystem except cwd, tmp, and writePaths" },
          { value: "strict", label: "strict", description: "loose plus a fresh tmpfs /tmp" },
          { value: "network full", label: "network full", description: "allow network inside the sandbox" },
          { value: "network none", label: "network none", description: "block network inside the sandbox" },
        ];
        const matches = candidates.filter((candidate) => candidate.value.startsWith(prefix));

        return matches.length > 0 ? matches : null;
      },
      handler: async (args, ctx): Promise<void> => {
        this.lastCtx = ctx;
        const trimmed = (args ?? "").trim().toLowerCase();

        if (trimmed === "" && ctx.hasUI) {
          const otherNetwork: SandboxNetwork = this.config.sandbox.network === "full" ? "none" : "full";
          const options = ["off", "loose", "strict", `network ${otherNetwork}`, "cancel"];
          const picked = await ctx.ui.select(
            `Sandbox (current: ${this.effectiveMode()}, network ${this.config.sandbox.network})`,
            options,
          );

          if (picked === undefined || picked === "cancel") {
            return;
          }

          if (picked === "off" || picked === "loose" || picked === "strict") {
            await this.applySandboxMode(picked, ctx);
          } else {
            this.applySandboxNetwork(otherNetwork, ctx);
          }

          return;
        }

        if (trimmed === "" || trimmed === "status") {
          if (ctx.hasUI) {
            ctx.ui.notify(this.sandboxStatus(), "info");
          }

          return;
        }

        if (trimmed === "off" || trimmed === "loose" || trimmed === "strict") {
          await this.applySandboxMode(trimmed, ctx);
          return;
        }

        if (trimmed === "network full" || trimmed === "network none") {
          this.applySandboxNetwork(trimmed.endsWith("none") ? "none" : "full", ctx);
          return;
        }

        if (ctx.hasUI) {
          ctx.ui.notify(`Unknown argument "${trimmed}". Usage: /sandbox [status|off|loose|strict|network full|network none]`, "error");
        }
      },
    });
  }
}
