import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { IdeBridge } from "./bridge.ts";
import { defaultLockDir, discoverIdes, isAlive, matchesWorkspace, pickIde } from "./discovery.ts";
import { predictAfter } from "./preview.ts";

interface IdeConfig {
  autoConnect: boolean;
  selection: boolean;
  diff: boolean;
  atMentions: boolean;
  lockDir: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  retryMs: number;
  maxSelectionChars: number;
  maxDiagnostics: number;
}

interface EditorSelection {
  filePath: string;
  text: string;
  startLine: number;
  endLine: number;
  isEmpty: boolean;
}

interface EditSnapshot {
  path: string;
  before: string | null;
  shown: string | null;
}

interface ToolText {
  type: "text";
  text: string;
}

interface ToolOutput {
  content: ToolText[];
  details: Record<string, unknown>;
}

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

const DEFAULTS: IdeConfig = {
  autoConnect: true,
  selection: true,
  diff: true,
  atMentions: true,
  lockDir: "",
  connectTimeoutMs: 5000,
  requestTimeoutMs: 30000,
  retryMs: 30000,
  maxSelectionChars: 2000,
  maxDiagnostics: 50,
};

const MAX_DIFF_BYTES = 4194304;

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

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function loadConfig(): IdeConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "suite.json"));
  if (globalConfig && isRecord(globalConfig.ide)) merged = deepMerge(merged, globalConfig.ide);
  const projectConfig = readJson(join(process.cwd(), ".pi", "suite.json"));
  if (projectConfig && isRecord(projectConfig.ide)) merged = deepMerge(merged, projectConfig.ide);
  return {
    autoConnect: booleanOr(merged.autoConnect, DEFAULTS.autoConnect),
    selection: booleanOr(merged.selection, DEFAULTS.selection),
    diff: booleanOr(merged.diff, DEFAULTS.diff),
    atMentions: booleanOr(merged.atMentions, DEFAULTS.atMentions),
    lockDir: typeof merged.lockDir === "string" ? merged.lockDir : DEFAULTS.lockDir,
    connectTimeoutMs: positiveInt(merged.connectTimeoutMs, DEFAULTS.connectTimeoutMs),
    requestTimeoutMs: positiveInt(merged.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    retryMs: nonNegativeInt(merged.retryMs, DEFAULTS.retryMs),
    maxSelectionChars: positiveInt(merged.maxSelectionChars, DEFAULTS.maxSelectionChars),
    maxDiagnostics: positiveInt(merged.maxDiagnostics, DEFAULTS.maxDiagnostics),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel === "" || rel.startsWith("..") ? path : rel;
}

function severityLabel(value: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number") {
    const labels = ["Error", "Warning", "Info", "Hint"];
    if (value >= 0 && value < labels.length) return labels[value];
  }
  return "Info";
}

function renderDiagnostics(raw: string, cwd: string, cap: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw !== "" ? raw : "No diagnostics reported.";
  }
  const files = Array.isArray(parsed) ? parsed : [parsed];
  const sections: string[] = [];
  let total = 0;
  let shown = 0;
  for (const file of files) {
    if (!isRecord(file)) continue;
    const uri = typeof file.uri === "string" ? file.uri : "";
    const diagnostics = Array.isArray(file.diagnostics) ? file.diagnostics : [];
    if (diagnostics.length === 0) continue;
    let path = uri;
    if (uri.startsWith("file://")) {
      try {
        path = fileURLToPath(uri);
      } catch {
        path = uri;
      }
    }
    const fileLines: string[] = [];
    for (const diagnostic of diagnostics) {
      if (!isRecord(diagnostic)) continue;
      total += 1;
      if (shown >= cap) continue;
      shown += 1;
      const range = isRecord(diagnostic.range) ? diagnostic.range : {};
      const start = isRecord(range.start) ? range.start : {};
      const line = typeof start.line === "number" ? start.line + 1 : 1;
      const column = typeof start.character === "number" ? start.character + 1 : 1;
      const source = typeof diagnostic.source === "string" && diagnostic.source !== "" ? ` (${diagnostic.source})` : "";
      const message = collapse(typeof diagnostic.message === "string" ? diagnostic.message : "");
      fileLines.push(`  L${line}:${column} ${severityLabel(diagnostic.severity)}: ${message}${source}`);
    }
    if (fileLines.length > 0) sections.push(`${displayPath(path, cwd)}:`, ...fileLines);
  }
  if (total === 0) return "No diagnostics reported.";
  const lines = [`${total} diagnostic${total === 1 ? "" : "s"}:`, ...sections];
  if (shown < total) lines.push(`[showing first ${shown} of ${total}]`);
  return lines.join("\n");
}

export default function ide(pi: ExtensionAPI): void {
  const config = loadConfig();
  let bridge: IdeBridge | undefined;
  let connecting = false;
  let lastAttempt = 0;
  let lastCtx: ExtensionContext | undefined;
  let selection: EditorSelection | undefined;
  let tempDir: string | undefined;
  let tempCounter = 0;
  const snapshots = new Map<string, EditSnapshot>();
  const diffTabs = new Map<string, string>();

  const lockDirPath = (): string => (config.lockDir !== "" ? config.lockDir : defaultLockDir());

  const updateStatus = (): void => {
    if (lastCtx === undefined || !lastCtx.hasUI) return;
    try {
      lastCtx.ui.setStatus("ide", bridge !== undefined ? `⧉ ${bridge.ideName}` : undefined);
    } catch {
      return;
    }
  };

  const handleNotification = (method: string, params: Record<string, unknown>): void => {
    if (method === "selection_changed") {
      const filePath = typeof params.filePath === "string" ? params.filePath : "";
      if (filePath === "") {
        selection = undefined;
        return;
      }
      const text = typeof params.text === "string" ? params.text : "";
      const range = isRecord(params.selection) ? params.selection : {};
      const start = isRecord(range.start) ? range.start : {};
      const end = isRecord(range.end) ? range.end : {};
      selection = {
        filePath,
        text,
        startLine: typeof start.line === "number" ? start.line : 0,
        endLine: typeof end.line === "number" ? end.line : 0,
        isEmpty: range.isEmpty === true || text === "",
      };
      return;
    }
    if (method === "at_mentioned") {
      if (!config.atMentions || lastCtx === undefined || !lastCtx.hasUI) return;
      const filePath = typeof params.filePath === "string" ? params.filePath : "";
      if (filePath === "") return;
      let mention = `@${displayPath(filePath, lastCtx.cwd)}`;
      const lineStart = typeof params.lineStart === "number" ? params.lineStart : undefined;
      const lineEnd = typeof params.lineEnd === "number" ? params.lineEnd : undefined;
      if (lineStart !== undefined) {
        mention += `#L${lineStart + 1}`;
        if (lineEnd !== undefined && lineEnd !== lineStart) mention += `-${lineEnd + 1}`;
      }
      try {
        lastCtx.ui.pasteToEditor(`${mention} `);
      } catch {
        return;
      }
    }
  };

  const connect = async (ctx: ExtensionContext, manual: boolean): Promise<void> => {
    const notify = (message: string, level: "info" | "warning" | "error"): void => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
    };
    if (bridge !== undefined || connecting) {
      if (manual && bridge !== undefined) notify(`Already connected to ${bridge.ideName}; run /ide off first.`, "info");
      return;
    }
    connecting = true;
    lastAttempt = Date.now();
    try {
      const lock = pickIde(discoverIdes(lockDirPath()), ctx.cwd, manual);
      if (lock === undefined) {
        if (manual) {
          notify(
            `No running IDE found (lock files under ${lockDirPath()}). Open this workspace in VS Code with the Claude Code extension installed.`,
            "warning",
          );
        }
        return;
      }
      const workspaceNote = matchesWorkspace(lock, ctx.cwd) ? "" : " (different workspace)";
      bridge = await IdeBridge.connect(lock, {
        connectTimeoutMs: config.connectTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        onNotification: handleNotification,
        onClose: (reason) => {
          bridge = undefined;
          selection = undefined;
          updateStatus();
          if (lastCtx !== undefined && lastCtx.hasUI) lastCtx.ui.notify(`IDE bridge disconnected (${reason}).`, "warning");
        },
      });
      updateStatus();
      notify(`Connected to ${bridge.ideName} on port ${bridge.port}${workspaceNote}.`, "info");
    } catch (error) {
      if (manual) notify(`IDE connect failed: ${describeError(error)}`, "error");
    } finally {
      connecting = false;
    }
  };

  const disconnect = (): string | undefined => {
    if (bridge === undefined) return undefined;
    const name = bridge.ideName;
    const active = bridge;
    bridge = undefined;
    selection = undefined;
    active.close();
    updateStatus();
    return name;
  };

  const fetchDiagnostics = async (path: string, cwd: string): Promise<string> => {
    const active = bridge;
    if (active === undefined) throw new Error("not connected to an IDE; run /ide connect first");
    if (!active.hasTool("getDiagnostics")) throw new Error(`${active.ideName} does not expose getDiagnostics`);
    const args: Record<string, unknown> = {};
    if (path !== "") args.uri = pathToFileURL(resolve(cwd, path)).href;
    const result = await active.callTool("getDiagnostics", args);
    if (result.isError) throw new Error(result.text !== "" ? collapse(result.text) : "getDiagnostics failed");
    return renderDiagnostics(result.text, cwd, config.maxDiagnostics);
  };

  const showDiff = async (path: string, before: string, after: string): Promise<void> => {
    const active = bridge;
    if (active === undefined || !active.hasTool("openDiff")) return;
    const tab = `${basename(path)} (pi)`;
    const previous = diffTabs.get(path);
    if (previous !== undefined && active.hasTool("close_tab")) {
      try {
        await active.callTool("close_tab", { tab_name: previous }, 2000);
      } catch {
        void 0;
      }
    }
    diffTabs.set(path, tab);
    if (tempDir === undefined) tempDir = mkdtempSync(join(tmpdir(), "pi-ide-"));
    tempCounter += 1;
    const oldPath = join(tempDir, `${tempCounter}-${basename(path)}`);
    try {
      writeFileSync(oldPath, before, "utf8");
    } catch {
      return;
    }
    try {
      await active.callTool("openDiff", { old_file_path: oldPath, new_file_path: path, new_file_contents: after, tab_name: tab }, 0);
    } catch {
      void 0;
    } finally {
      try {
        rmSync(oldPath, { force: true });
      } catch {
        void 0;
      }
    }
  };

  const closeDiff = async (path: string): Promise<void> => {
    const tab = diffTabs.get(path);
    const active = bridge;
    if (tab === undefined || active === undefined || !active.hasTool("close_tab")) return;
    try {
      await active.callTool("close_tab", { tab_name: tab }, 2000);
    } catch {
      void 0;
    }
    diffTabs.delete(path);
  };

  const buildIdeContext = (cwd: string): string => {
    if (!config.selection || bridge === undefined || selection === undefined || selection.filePath === "") return "";
    const rel = displayPath(selection.filePath, cwd);
    const lines: string[] = [];
    if (selection.isEmpty) {
      lines.push(`IDE context: in ${bridge.ideName} the user has ${rel} open, cursor on line ${selection.startLine + 1}.`);
    } else {
      const capped =
        selection.text.length > config.maxSelectionChars
          ? `${selection.text.slice(0, config.maxSelectionChars)}\n[selection truncated]`
          : selection.text;
      lines.push(
        `IDE context: in ${bridge.ideName} the user has ${rel} open with lines ${selection.startLine + 1}-${selection.endLine + 1} selected:`,
      );
      lines.push("```");
      lines.push(capped);
      lines.push("```");
    }
    lines.push("This is the live editor state; it may be unrelated to the request.");
    return lines.join("\n");
  };

  const statusText = (ctx: ExtensionContext): string => {
    if (bridge !== undefined) {
      const lines = [`Connected to ${bridge.ideName} on port ${bridge.port} (${bridge.toolNames().length} IDE tools).`];
      if (selection !== undefined && selection.filePath !== "") {
        const range = selection.isEmpty
          ? `line ${selection.startLine + 1}`
          : `lines ${selection.startLine + 1}-${selection.endLine + 1}`;
        lines.push(`Editor focus: ${displayPath(selection.filePath, ctx.cwd)} (${range}).`);
      }
      const features = [
        config.selection ? "selection context" : "",
        config.diff ? "diff tabs" : "",
        config.atMentions ? "at-mentions" : "",
      ].filter((feature) => feature !== "");
      lines.push(features.length > 0 ? `Enabled: ${features.join(", ")}.` : "All bridge features disabled in config.");
      return lines.join("\n");
    }
    const locks = discoverIdes(lockDirPath());
    if (locks.length === 0) {
      return `Not connected. No IDE lock files under ${lockDirPath()} — open VS Code with the Claude Code extension installed, then run /ide connect.`;
    }
    const lines = ["Not connected. Detected IDEs:"];
    for (const lock of locks) {
      const notes = [isAlive(lock) ? "" : "stale", matchesWorkspace(lock, ctx.cwd) ? "this workspace" : ""].filter(
        (note) => note !== "",
      );
      lines.push(`  ${lock.ideName} — port ${lock.port}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`);
    }
    lines.push("Run /ide connect.");
    return lines.join("\n");
  };

  pi.registerTool({
    name: "idediagnostics",
    label: "IDE Diagnostics",
    description:
      "Read language diagnostics (errors, warnings, hints) from the connected VS Code window. Pass path to scope to one file; omit it to list every file with problems. Requires an active /ide connection; results come from the IDE's language servers without running a build.",
    promptSnippet: "idediagnostics — language diagnostics from the connected IDE (errors/warnings per file, or one file via path)",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Absolute or cwd-relative file path to check; omit for all files with problems" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolOutput> => {
      const path = typeof params.path === "string" ? params.path.trim() : "";
      try {
        const text = await fetchDiagnostics(path, ctx.cwd);
        return { content: [{ type: "text", text }], details: { path, ide: bridge?.ideName ?? "" } };
      } catch (error) {
        throw new Error(`idediagnostics: ${describeError(error)}`);
      }
    },
  });

  pi.registerCommand("ide", {
    description: "IDE bridge status; /ide connect attaches to VS Code, /ide off disconnects, /ide diagnostics [path] lists problems",
    getArgumentCompletions: (argumentPrefix: string): CompletionItem[] | null => {
      const prefix = argumentPrefix.trimStart();
      const items: CompletionItem[] = [
        { value: "connect", label: "connect", description: "connect to a running VS Code window" },
        { value: "off", label: "off", description: "disconnect the IDE bridge" },
        { value: "diagnostics", label: "diagnostics", description: "list diagnostics from the IDE" },
      ];
      const matches = items.filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx): Promise<void> => {
      lastCtx = ctx;
      const notify = (message: string, level: "info" | "warning" | "error"): void => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
      };
      const trimmed = (args ?? "").trim();
      if (trimmed === "") {
        notify(statusText(ctx), "info");
        return;
      }
      const [sub, ...rest] = trimmed.split(/\s+/);
      if (sub === "connect") {
        await connect(ctx, true);
        return;
      }
      if (sub === "off" || sub === "disconnect") {
        const name = disconnect();
        notify(name !== undefined ? `Disconnected from ${name}.` : "IDE bridge is not connected.", "info");
        return;
      }
      if (sub === "diagnostics") {
        try {
          notify(await fetchDiagnostics(rest.join(" ").trim(), ctx.cwd), "info");
        } catch (error) {
          notify(`ide diagnostics: ${describeError(error)}`, "error");
        }
        return;
      }
      notify(`Unknown subcommand "${sub}". Usage: /ide | /ide connect | /ide off | /ide diagnostics [path]`, "error");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    updateStatus();
    if (config.autoConnect && bridge === undefined) void connect(ctx, false);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    lastCtx = ctx;
    if (config.autoConnect && bridge === undefined && !connecting && Date.now() - lastAttempt >= config.retryMs) {
      void connect(ctx, false);
    }
    const content = buildIdeContext(ctx.cwd);
    if (content === "") return;
    return { message: { customType: "idecontext", content, display: false } };
  });

  pi.on("tool_execution_start", (event, ctx) => {
    lastCtx = ctx;
    if (!config.diff || bridge === undefined) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input: Record<string, unknown> = isRecord(event.args) ? event.args : {};
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (path === "") return;
    const abs = resolve(ctx.cwd, path);
    let before: string | null = null;
    try {
      before = readFileSync(abs, "utf8");
    } catch {
      before = null;
    }
    if (before !== null && Buffer.byteLength(before, "utf8") > MAX_DIFF_BYTES) return;
    const predicted = predictAfter(abs, event.toolName, input, before);
    let shown: string | null = null;
    if (predicted !== null && predicted !== (before ?? "") && Buffer.byteLength(predicted, "utf8") <= MAX_DIFF_BYTES) {
      void showDiff(abs, before ?? "", predicted);
      shown = predicted;
    }
    snapshots.set(event.toolCallId, { path: abs, before, shown });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    lastCtx = ctx;
    const snapshot = snapshots.get(event.toolCallId);
    if (snapshot === undefined) return;
    snapshots.delete(event.toolCallId);
    if (!config.diff || bridge === undefined) return;
    if (event.isError) {
      if (snapshot.shown !== null) void closeDiff(snapshot.path);
      return;
    }
    let after: string;
    try {
      after = readFileSync(snapshot.path, "utf8");
    } catch {
      return;
    }
    if (Buffer.byteLength(after, "utf8") > MAX_DIFF_BYTES) return;
    if (after === (snapshot.before ?? "")) {
      if (snapshot.shown !== null) void closeDiff(snapshot.path);
      return;
    }
    if (snapshot.shown === after) return;
    void showDiff(snapshot.path, snapshot.before ?? "", after);
  });

  pi.on("agent_end", () => {
    snapshots.clear();
  });

  pi.on("session_shutdown", async () => {
    const active = bridge;
    bridge = undefined;
    selection = undefined;
    if (active !== undefined) {
      if (diffTabs.size > 0 && active.hasTool("closeAllDiffTabs")) {
        try {
          await active.callTool("closeAllDiffTabs", {}, 2000);
        } catch {
          void 0;
        }
      }
      active.close();
    }
    diffTabs.clear();
    snapshots.clear();
    if (tempDir !== undefined) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        void 0;
      }
      tempDir = undefined;
    }
  });
}
