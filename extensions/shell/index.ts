import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type JobSnapshot, JobManager } from "./manager";
import type { SandboxNetwork } from "./profiles";
import {
  buildPlan,
  type ExecFn,
  type SandboxMode,
  type SandboxSettings,
  splitEscape,
  wrapperAvailable,
} from "./sandbox";
import { clip, formatJobList, formatRuntime, normalize, renderJobs } from "./widget";

interface ShellConfig {
  shell: string;
  widget: boolean;
  widgetLimit: number;
  outputBytes: number;
  outputLines: number;
  sandbox: SandboxSettings;
  jobs: {
    autoBackgroundMs: number;
    capBytes: number;
    defaultWaitSec: number;
    keepFinished: number;
    notify: boolean;
  };
}

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

const DEFAULTS: ShellConfig = {
  shell: "",
  widget: true,
  widgetLimit: 6,
  outputBytes: 24576,
  outputLines: 800,
  sandbox: { enabled: false, mode: "loose", network: "full", writePaths: [], escape: true },
  jobs: { autoBackgroundMs: 30000, capBytes: 2097152, defaultWaitSec: 30, keepFinished: 20, notify: true },
};

function cleanOutput(raw: string): string {
  const stripped = raw
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\][^]*(?:|\\)/g, "")
    .replace(/[@-Z\\-_]/g, "");
  if (!stripped.includes("\r")) return stripped;
  return stripped
    .split("\n")
    .map((line) => {
      const body = line.endsWith("\r") ? line.slice(0, -1) : line;
      const at = body.lastIndexOf("\r");
      return at === -1 ? body : body.slice(at + 1);
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function posInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function sanitizeConfig(merged: Record<string, unknown>): ShellConfig {
  const sandboxRaw = isRecord(merged.sandbox) ? merged.sandbox : {};
  const jobsRaw = isRecord(merged.jobs) ? merged.jobs : {};
  const mode: SandboxMode =
    sandboxRaw.mode === "off" || sandboxRaw.mode === "loose" || sandboxRaw.mode === "strict"
      ? sandboxRaw.mode
      : DEFAULTS.sandbox.mode;
  const network: SandboxNetwork =
    sandboxRaw.network === "full" || sandboxRaw.network === "none" ? sandboxRaw.network : DEFAULTS.sandbox.network;
  const writePaths = Array.isArray(sandboxRaw.writePaths)
    ? sandboxRaw.writePaths.filter((path): path is string => typeof path === "string" && path.trim() !== "")
    : DEFAULTS.sandbox.writePaths;
  return {
    shell: typeof merged.shell === "string" ? merged.shell : DEFAULTS.shell,
    widget: typeof merged.widget === "boolean" ? merged.widget : DEFAULTS.widget,
    widgetLimit: posInt(merged.widgetLimit, DEFAULTS.widgetLimit),
    outputBytes: posInt(merged.outputBytes, DEFAULTS.outputBytes),
    outputLines: posInt(merged.outputLines, DEFAULTS.outputLines),
    sandbox: {
      enabled: typeof sandboxRaw.enabled === "boolean" ? sandboxRaw.enabled : DEFAULTS.sandbox.enabled,
      mode,
      network,
      writePaths,
      escape: typeof sandboxRaw.escape === "boolean" ? sandboxRaw.escape : DEFAULTS.sandbox.escape,
    },
    jobs: {
      autoBackgroundMs: nonNegInt(jobsRaw.autoBackgroundMs, DEFAULTS.jobs.autoBackgroundMs),
      capBytes: posInt(jobsRaw.capBytes, DEFAULTS.jobs.capBytes),
      defaultWaitSec: posInt(jobsRaw.defaultWaitSec, DEFAULTS.jobs.defaultWaitSec),
      keepFinished: nonNegInt(jobsRaw.keepFinished, DEFAULTS.jobs.keepFinished),
      notify: typeof jobsRaw.notify === "boolean" ? jobsRaw.notify : DEFAULTS.jobs.notify,
    },
  };
}

function loadConfig(): ShellConfig {
  let merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULTS)) as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = JSON.parse(JSON.stringify(DEFAULTS)) as Record<string, unknown>;
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "suite.json"));
  if (globalConfig && isRecord(globalConfig.shell)) merged = deepMerge(merged, globalConfig.shell);
  const projectConfig = readJson(join(process.cwd(), ".pi", "suite.json"));
  if (projectConfig && isRecord(projectConfig.shell)) merged = deepMerge(merged, projectConfig.shell);
  return sanitizeConfig(merged);
}

function resolveShell(configured: string): string {
  const explicit = configured.trim();
  if (explicit !== "" && existsSync(explicit)) return explicit;
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  const env = (process.env.SHELL ?? "").trim();
  if (env !== "" && existsSync(env)) return env;
  if (existsSync("/bin/bash")) return "/bin/bash";
  return "/bin/sh";
}

function requireId(id: string | undefined, op: string): string {
  const trimmed = (id ?? "").trim();
  if (trimmed === "") throw new Error(`op "${op}" requires a job id`);
  return trimmed;
}

function describeEnd(job: JobSnapshot): string {
  if (job.status === "done") return "completed successfully (exit 0)";
  if (job.status === "killed") return `was killed${job.exitSignal !== null ? ` (${job.exitSignal})` : ""}`;
  if (job.exitCode !== null) return `failed (exit ${job.exitCode})`;
  return `failed${job.exitSignal !== null ? ` (signal ${job.exitSignal})` : ""}`;
}

export default function shell(pi: ExtensionAPI): void {
  const config = loadConfig();
  const userShell = resolveShell(config.shell);
  const execAdapter: ExecFn = (cmd, args, options) => pi.exec(cmd, args, options);

  let lastCtx: ExtensionContext | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const manager = new JobManager(
    {
      capBytes: config.jobs.capBytes,
      autoBackgroundMs: config.jobs.autoBackgroundMs,
      keepFinished: config.jobs.keepFinished,
      onChange: () => refreshWidget(),
      onBackgroundDone: (job, output) => notifyJobDone(job, output),
    },
    join(homedir(), ".pi", "agent", "jobs", `local-${process.pid}`),
  );

  function stopTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function startTicker(): void {
    if (ticker !== null) return;
    ticker = setInterval(() => refreshWidget(), 1000);
    if (typeof ticker.unref === "function") ticker.unref();
  }

  function refreshWidget(): void {
    const ctx = lastCtx;
    if (ctx === null || !ctx.hasUI) {
      stopTicker();
      return;
    }
    try {
      if (!config.widget) {
        ctx.ui.setWidget("shelljobs", undefined);
        stopTicker();
        return;
      }
      const running = manager.list().filter((job) => job.status === "running" && job.background);
      const lines = renderJobs(running, Date.now(), config.widgetLimit);
      ctx.ui.setWidget("shelljobs", lines.length > 0 ? lines : undefined);
      if (lines.length > 0) startTicker();
      else stopTicker();
    } catch {
      stopTicker();
    }
  }

  function notifyJobDone(job: JobSnapshot, output: string): void {
    if (!config.jobs.notify) return;
    const tail = truncateTail(cleanOutput(output), { maxBytes: 4096, maxLines: 20 });
    const runtime = formatRuntime((job.endedAt ?? Date.now()) - job.startedAt);
    const log = job.spillPath !== null ? `\nFull log: ${job.spillPath}` : "";
    const body = tail.content.trim() === "" ? "(no output)" : tail.content;
    const content = `Background job ${job.id} ${describeEnd(job)} after ${runtime}.\nCommand: ${clip(normalize(job.command), 160)}${log}\nLast output:\n${body}`;
    try {
      pi.sendMessage({ customType: "shelljob", content, display: true }, { deliverAs: "followUp" });
    } catch {
      return;
    }
  }

  function persistSandbox(): string | null {
    try {
      const path = join(homedir(), ".pi", "agent", "suite.json");
      const root = readJson(path) ?? {};
      const shellSection = isRecord(root.shell) ? { ...root.shell } : {};
      const sandboxSection = isRecord(shellSection.sandbox) ? { ...shellSection.sandbox } : {};
      sandboxSection.enabled = config.sandbox.enabled;
      sandboxSection.mode = config.sandbox.mode;
      sandboxSection.network = config.sandbox.network;
      shellSection.sandbox = sandboxSection;
      root.shell = shellSection;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  function effectiveMode(): SandboxMode {
    return config.sandbox.enabled ? config.sandbox.mode : "off";
  }

  function sandboxStatus(): string {
    const paths = config.sandbox.writePaths.length > 0 ? config.sandbox.writePaths.join(", ") : "(none)";
    return `Sandbox mode: ${effectiveMode()} | network: ${config.sandbox.network} | escape prefix: ${config.sandbox.escape ? "allowed" : "blocked"} | extra write paths: ${paths}`;
  }

  async function applySandboxMode(mode: SandboxMode, ctx: ExtensionCommandContext): Promise<void> {
    config.sandbox.mode = mode;
    config.sandbox.enabled = mode !== "off";
    const persistError = persistSandbox();
    const notify = (message: string, level: "info" | "warning" | "error"): void => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
    };
    if (persistError !== null) {
      notify(`Sandbox set to ${mode} for this session, but saving to suite.json failed: ${persistError}`, "warning");
    } else {
      notify(`Sandbox mode set to ${mode} (saved to ~/.pi/agent/suite.json).`, "info");
    }
    if (mode !== "off") {
      const available = await wrapperAvailable(execAdapter);
      if (!available) {
        const tool = process.platform === "darwin" ? "sandbox-exec" : "bwrap";
        notify(`Warning: ${tool} is not available on this system; commands will run unsandboxed.`, "warning");
      }
    }
  }

  function applySandboxNetwork(network: SandboxNetwork, ctx: ExtensionCommandContext): void {
    config.sandbox.network = network;
    const persistError = persistSandbox();
    if (!ctx.hasUI) return;
    if (persistError !== null) {
      ctx.ui.notify(`Sandbox network set to ${network} for this session, but saving failed: ${persistError}`, "warning");
    } else {
      ctx.ui.notify(`Sandbox network set to ${network} (saved).`, "info");
    }
  }

  function renderOutput(raw: string, spillPath: string | null): string {
    const trunc = truncateTail(cleanOutput(raw), { maxBytes: config.outputBytes, maxLines: config.outputLines });
    if (trunc.content.trim() === "") return "(no output)";
    if (trunc.truncated === true) {
      const where = spillPath !== null ? `; full output: ${spillPath}` : "";
      return `[output truncated: showing the tail of ${trunc.totalLines} lines / ${trunc.totalBytes} bytes${where}]\n${trunc.content}`;
    }
    return trunc.content;
  }

  const bashParameters = Type.Object({
    command: Type.String({ description: "The shell command to execute" }),
    timeout: Type.Optional(
      Type.Number({ description: "Optional timeout in seconds; the command is killed when it is exceeded" }),
    ),
  });

  const autoNote =
    config.jobs.autoBackgroundMs > 0
      ? ` Commands without a timeout that run longer than ${Math.round(config.jobs.autoBackgroundMs / 1000)}s are moved to a background job; the call returns a job id and you manage it with the jobs tool (list, peek, kill, wait).`
      : "";

  pi.registerTool({
    name: "bash",
    label: "Bash",
    description: `Execute a command through the user's shell and return interleaved stdout/stderr (truncated to the last ${Math.round(config.outputBytes / 1024)}KB / ${config.outputLines} lines; longer output is spilled to a readable log file). Optional timeout in seconds kills the command when exceeded.${autoNote} When sandboxing is enabled, commands run with restricted filesystem writes; prefixing a command with "unsandboxed:" bypasses the sandbox only if the escape hatch is enabled in config.`,
    parameters: bashParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<ToolResult> {
      lastCtx = ctx;
      const args = params as BashArgs;
      const raw = typeof args.command === "string" ? args.command : "";
      if (raw.trim() === "") throw new Error("command must be a non-empty string");
      const escape = splitEscape(raw, config.sandbox.escape);
      const wantSandbox = !escape.bypass && config.sandbox.enabled && config.sandbox.mode !== "off";
      const available = wantSandbox ? await wrapperAvailable(execAdapter) : false;
      const settings: SandboxSettings = escape.bypass ? { ...config.sandbox, enabled: false } : config.sandbox;
      const plan = buildPlan(userShell, escape.command, ctx.cwd, settings, available);
      const timeoutSec =
        typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0
          ? Math.min(Math.ceil(args.timeout), 86400)
          : null;
      const sendUpdate = (text: string): void => {
        if (typeof onUpdate !== "function") return;
        const trunc = truncateTail(cleanOutput(text), { maxBytes: 8192, maxLines: 200 });
        onUpdate({ content: [{ type: "text", text: trunc.content }], details: {} });
      };
      const outcome = await manager.run({
        argv: plan.argv,
        command: escape.command,
        cwd: ctx.cwd,
        sandboxed: plan.sandboxed,
        timeoutSec,
        signal: signal ?? new AbortController().signal,
        onUpdate: sendUpdate,
        cleanup: plan.cleanup,
      });
      refreshWidget();
      const job = outcome.job;
      const prefix = plan.note !== "" && !plan.sandboxed ? `[${plan.note}]\n` : "";
      if (outcome.backgrounded) {
        const seconds = Math.round(config.jobs.autoBackgroundMs / 1000);
        const tail = truncateTail(cleanOutput(outcome.output), { maxBytes: 8192, maxLines: 50 });
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
      const text = prefix + renderOutput(outcome.output, job.spillPath);
      if (outcome.aborted) throw new Error(`${text}\n\nCommand aborted`);
      if (outcome.timedOut) throw new Error(`${text}\n\nCommand timed out after ${timeoutSec ?? 0}s`);
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

  const jobsParameters = Type.Object({
    op: StringEnum(["list", "peek", "kill", "wait"], {
      description: "list all jobs, peek at recent output, kill a running job, or wait for one to finish",
    }),
    id: Type.Optional(Type.String({ description: "job id (e.g. j1); required for peek, kill, and wait" })),
    lines: Type.Optional(Type.Number({ description: "peek: number of trailing output lines to return (default 50)" })),
    waitSec: Type.Optional(
      Type.Number({ description: `wait: maximum seconds to block (default ${config.jobs.defaultWaitSec}, max 600)` }),
    ),
  });

  pi.registerTool({
    name: "jobs",
    label: "Jobs",
    description:
      "Manage shell jobs started by the bash tool. Ops: list (all jobs with status and runtime), peek (id; recent output, optional lines), kill (id; terminates the whole process group, escalating SIGTERM to SIGKILL), wait (id; block until the job finishes or waitSec elapses, then report status and output tail).",
    parameters: jobsParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      lastCtx = ctx;
      const args = params as JobsArgs;
      switch (args.op) {
        case "list": {
          const jobs = manager.list();
          return {
            content: [{ type: "text", text: formatJobList(jobs, Date.now()) }],
            details: { jobs },
          };
        }
        case "peek": {
          const id = requireId(args.id, "peek");
          const peeked = manager.peek(id);
          if (peeked === null) throw new Error(`No such job: ${id}`);
          const lines = posInt(args.lines, 50);
          const trunc = truncateTail(cleanOutput(peeked.output), { maxBytes: config.outputBytes, maxLines: Math.min(lines, config.outputLines) });
          const body = trunc.content.trim() === "" ? "(no output)" : trunc.content;
          const runtime = formatRuntime((peeked.job.endedAt ?? Date.now()) - peeked.job.startedAt);
          const head = `${peeked.job.id} [${peeked.job.status}] runtime ${runtime} — ${clip(normalize(peeked.job.command), 120)}`;
          return {
            content: [{ type: "text", text: `${head}\n${body}` }],
            details: { job: peeked.job },
          };
        }
        case "kill": {
          const id = requireId(args.id, "kill");
          const existing = manager.get(id);
          if (existing === null) throw new Error(`No such job: ${id}`);
          if (existing.status !== "running") {
            return {
              content: [{ type: "text", text: `Job ${id} is not running (status: ${existing.status}).` }],
              details: { job: existing },
            };
          }
          manager.kill(id);
          const waited = await manager.wait(id, 3000);
          const job = waited?.job ?? manager.get(id) ?? existing;
          const text =
            job.status === "running"
              ? `Sent SIGTERM to job ${id} (process group ${job.pid ?? "?"}); SIGKILL follows shortly if it does not exit.`
              : `Killed job ${id}; it ${describeEnd(job)}.`;
          refreshWidget();
          return { content: [{ type: "text", text }], details: { job } };
        }
        case "wait": {
          const id = requireId(args.id, "wait");
          const seconds = Math.min(posInt(args.waitSec, config.jobs.defaultWaitSec), 600);
          const waited = await manager.wait(id, seconds * 1000);
          if (waited === null) throw new Error(`No such job: ${id}`);
          const peeked = manager.peek(id);
          const tail = truncateTail(cleanOutput(peeked?.output ?? ""), { maxBytes: 8192, maxLines: 40 });
          const body = tail.content.trim() === "" ? "(no output)" : tail.content;
          const text = waited.completed
            ? `Job ${id} ${describeEnd(waited.job)}.\nOutput tail:\n${body}`
            : `Job ${id} is still running after ${seconds}s.\nOutput tail:\n${body}`;
          refreshWidget();
          return { content: [{ type: "text", text }], details: { job: waited.job, completed: waited.completed } };
        }
        default:
          throw new Error(`unknown op "${String(args.op)}"`);
      }
    },
  });

  pi.registerCommand("jobs", {
    description: "List shell jobs; /jobs peek <id> [lines], /jobs kill <id>, or interactive with no arguments",
    getArgumentCompletions: (argumentPrefix: string): CompletionItem[] | null => {
      const prefix = argumentPrefix.trimStart();
      const candidates: CompletionItem[] = [{ value: "list", label: "list", description: "list all jobs" }];
      for (const job of manager.list()) {
        candidates.push({
          value: `peek ${job.id}`,
          label: `peek ${job.id}`,
          description: clip(normalize(job.command), 60),
        });
        if (job.status === "running") {
          candidates.push({
            value: `kill ${job.id}`,
            label: `kill ${job.id}`,
            description: clip(normalize(job.command), 60),
          });
        }
      }
      const matches = candidates.filter((candidate) => candidate.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx): Promise<void> => {
      lastCtx = ctx;
      const notify = (message: string, level: "info" | "warning" | "error"): void => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
      };
      const peekText = (id: string, lines: number): string => {
        const peeked = manager.peek(id);
        if (peeked === null) return `No such job: ${id}`;
        const trunc = truncateTail(cleanOutput(peeked.output), { maxBytes: 16384, maxLines: lines });
        const body = trunc.content.trim() === "" ? "(no output)" : trunc.content;
        return `${peeked.job.id} [${peeked.job.status}] ${clip(normalize(peeked.job.command), 100)}\n${body}`;
      };
      const trimmed = (args ?? "").trim();
      if (trimmed === "" && ctx.hasUI) {
        const jobs = manager.list();
        if (jobs.length === 0) {
          notify("No jobs.", "info");
          return;
        }
        const now = Date.now();
        const options = jobs.map(
          (job) =>
            `${job.id} · ${job.status} · ${formatRuntime((job.endedAt ?? now) - job.startedAt)} · ${clip(normalize(job.command), 48)}`,
        );
        const picked = await ctx.ui.select("Shell jobs", options);
        if (picked === undefined) return;
        const id = picked.split(" ")[0];
        const job = manager.get(id);
        if (job === null) return;
        const actions = job.status === "running" ? ["peek", "kill", "cancel"] : ["peek", "cancel"];
        const action = await ctx.ui.select(`Job ${id}`, actions);
        if (action === "peek") {
          notify(peekText(id, 15), "info");
        } else if (action === "kill") {
          const killed = manager.kill(id);
          notify(killed ? `Sent SIGTERM to job ${id}.` : `Job ${id} is not running.`, "info");
          refreshWidget();
        }
        return;
      }
      if (trimmed === "" || trimmed === "list") {
        notify(formatJobList(manager.list(), Date.now()), "info");
        return;
      }
      const [sub, ...rest] = trimmed.split(/\s+/);
      if (sub === "peek") {
        const id = (rest[0] ?? "").trim();
        if (id === "") {
          notify("Usage: /jobs peek <id> [lines]", "error");
          return;
        }
        const lines = posInt(Number(rest[1]), 15);
        notify(peekText(id, lines), "info");
        return;
      }
      if (sub === "kill") {
        const id = (rest[0] ?? "").trim();
        if (id === "") {
          notify("Usage: /jobs kill <id>", "error");
          return;
        }
        const existing = manager.get(id);
        if (existing === null) {
          notify(`No such job: ${id}`, "error");
          return;
        }
        const killed = manager.kill(id);
        notify(killed ? `Sent SIGTERM to job ${id}.` : `Job ${id} is not running (status: ${existing.status}).`, "info");
        refreshWidget();
        return;
      }
      notify(`Unknown subcommand "${sub}". Usage: /jobs | /jobs list | /jobs peek <id> [lines] | /jobs kill <id>`, "error");
    },
  });

  pi.registerCommand("sandbox", {
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
      lastCtx = ctx;
      const trimmed = (args ?? "").trim().toLowerCase();
      if (trimmed === "" && ctx.hasUI) {
        const otherNetwork: SandboxNetwork = config.sandbox.network === "full" ? "none" : "full";
        const options = ["off", "loose", "strict", `network ${otherNetwork}`, "cancel"];
        const picked = await ctx.ui.select(
          `Sandbox (current: ${effectiveMode()}, network ${config.sandbox.network})`,
          options,
        );
        if (picked === undefined || picked === "cancel") return;
        if (picked === "off" || picked === "loose" || picked === "strict") {
          await applySandboxMode(picked, ctx);
        } else {
          applySandboxNetwork(otherNetwork, ctx);
        }
        return;
      }
      if (trimmed === "" || trimmed === "status") {
        if (ctx.hasUI) ctx.ui.notify(sandboxStatus(), "info");
        return;
      }
      if (trimmed === "off" || trimmed === "loose" || trimmed === "strict") {
        await applySandboxMode(trimmed, ctx);
        return;
      }
      if (trimmed === "network full" || trimmed === "network none") {
        applySandboxNetwork(trimmed.endsWith("none") ? "none" : "full", ctx);
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(`Unknown argument "${trimmed}". Usage: /sandbox [status|off|loose|strict|network full|network none]`, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    let key = `local-${process.pid}`;
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (typeof file === "string" && file !== "") {
        const clean = basename(file)
          .replace(/\.[^.]+$/, "")
          .replace(/[^A-Za-z0-9._-]/g, "");
        if (clean !== "") key = clean;
      }
    } catch {
      key = `local-${process.pid}`;
    }
    manager.setSpillDir(join(homedir(), ".pi", "agent", "jobs", key));
    refreshWidget();
  });

  pi.on("session_shutdown", () => {
    manager.killAll();
    stopTicker();
    const ctx = lastCtx;
    if (ctx !== null && ctx.hasUI) {
      try {
        ctx.ui.setWidget("shelljobs", undefined);
      } catch {
        stopTicker();
      }
    }
  });
}
