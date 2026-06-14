import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  BridgeClient,
  REVIEW_MAX_BYTES,
  canReviewDiff,
  retryBackoffMs,
  type ContextStreamHandle,
} from "../ide/index.ts";
import type { DiagnosticsRequest, DiagnosticsResponse, DiagnosticsScope, EditorContext } from "../ide/contract.ts";
import { installVsCodeCompanion, installVsCodeCompanionFromLocalDebugVsix } from "../ide/installer.ts";
import { predictAfter } from "../ide/preview.ts";
import type { IdeConfig } from "./config.ts";
import type { LifecycleHub } from "./lifecycle.ts";

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

interface DiffSnapshot {
  filePath: string;
  beforeText: string;
  shownText: string | null;
}

interface IdeHandleRequest {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  signal?: AbortSignal;
}

interface IdeHandleApproval {
  decision: "accept" | "reject";
  content: string;
  edited: boolean;
  beforeText: string;
}

interface IdePreviewRequest {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  cwd: string;
}
interface IdeHandle {
  isConnected(): Promise<boolean>;
  requestDiffApproval(req: IdeHandleRequest): Promise<IdeHandleApproval | undefined>;
  previewEdit(req: IdePreviewRequest): Promise<void>;
  closePreview(toolCallId: string): Promise<void>;
}

const IDE_HANDLE_KEY = Symbol.for("piconfig.ide");

const IDE_USAGE =
  "Usage: /ide | /ide status | /ide context | /ide install | /ide debug | /ide diagnostics [active|all|file <path>]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticsScope(value: unknown, fallback: DiagnosticsScope): DiagnosticsScope {
  return value === "active" || value === "all" || value === "file" ? value : fallback;
}

function normalizeFilePath(path: string | undefined, cwd: string): string | undefined {
  if (path === undefined || path.trim() === "") {
    return undefined;
  }

  return resolve(cwd, path.trim());
}

function diagnosticsRequest(
  params: Record<string, unknown>,
  cwd: string,
  fallbackScope: DiagnosticsScope,
): { request?: DiagnosticsRequest; error?: string } {
  const legacyPath = typeof params.path === "string" ? params.path : undefined;
  const scope =
    legacyPath !== undefined && legacyPath.trim() !== "" ? "file" : diagnosticsScope(params.scope, fallbackScope);
  const filePath = normalizeFilePath(typeof params.filePath === "string" ? params.filePath : legacyPath, cwd);

  if (scope === "file" && !filePath) {
    return { error: "filePath is required when scope is 'file'." };
  }

  return { request: { scope, filePath } };
}

function formatDiagnostics(response: DiagnosticsResponse): string {
  if (response.files.length === 0) {
    return "No IDE errors or warnings reported.";
  }

  const lines = [
    `IDE diagnostics: ${response.totalErrors} error${response.totalErrors === 1 ? "" : "s"}, ${response.totalWarnings} warning${response.totalWarnings === 1 ? "" : "s"}.`,
  ];

  for (const file of response.files) {
    lines.push(`${file.path}:`);

    for (const diagnostic of file.diagnostics) {
      const source = diagnostic.source ? ` (${diagnostic.source})` : "";
      const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
      lines.push(`  L${diagnostic.line}:${diagnostic.character} ${diagnostic.severity}: ${diagnostic.message}${source}${code}`);
    }
  }

  return lines.join("\n");
}

function commandCompletions(argumentPrefix: string): CompletionItem[] | null {
  const prefix = argumentPrefix.trimStart();
  const items: CompletionItem[] = [
    { value: "status", label: "status", description: "show VS Code connection status" },
    { value: "install", label: "install", description: "install the VS Code companion extension" },
    { value: "context", label: "context", description: "dump current editor context" },
    { value: "diagnostics", label: "diagnostics", description: "show IDE diagnostics for active/all/file" },
    { value: "debug", label: "debug", description: "show bridge resolution details" },
    { value: "help", label: "help", description: "show IDE bridge usage" },
  ];
  const matches = items.filter((item) => item.value.startsWith(prefix));

  return matches.length > 0 ? matches : null;
}

export class IdeRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: IdeConfig;
  private readonly hub: LifecycleHub;
  private readonly client: BridgeClient;
  private readonly diffSnapshots = new Map<string, DiffSnapshot>();
  private readonly recentApprovals = new Set<string>();

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastConnected: boolean | undefined;
  private liveContext: EditorContext | undefined;
  private streamHandle: ContextStreamHandle | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;

  constructor(pi: ExtensionAPI, config: IdeConfig, hub: LifecycleHub) {
    this.pi = pi;
    this.config = config;
    this.hub = hub;
    this.client = new BridgeClient();
  }

  register(): void {
    this.registerIdeCommand();
    this.registerDiagnosticsTools();

    const handle = this.buildHandle();
    const host = globalThis as unknown as Record<symbol, unknown>;
    host[IDE_HANDLE_KEY] = handle;

    this.hub.on("session_start", async (_event, ctx) => {
      this.emitStatus();
      await this.pollConnection();

      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }

      this.pollTimer = setInterval(() => void this.pollConnection(), this.config.connectionPollMs);
      this.pollTimer.unref?.();
      this.startContextStream(ctx);

      return undefined;
    });

    this.hub.on("session_shutdown", () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }

      this.clearReconnect();
      this.streamHandle?.disconnect();
      this.streamHandle = undefined;
      this.reconnectAttempt = 0;
      this.liveContext = undefined;
      this.lastConnected = undefined;
      this.diffSnapshots.clear();
      this.emitStatusClear();

      if (host[IDE_HANDLE_KEY] === handle) {
        delete host[IDE_HANDLE_KEY];
      }

      return undefined;
    });

    this.hub.on("before_agent_start", () => this.buildContextMessage());

    this.hub.on("tool_execution_start", (event, ctx) => this.onToolStart(event, ctx));
    this.hub.on("tool_execution_end", (event) => this.onToolEnd(event));
  }

  private async pollConnection(): Promise<void> {
    const connected = await this.client.isIdeConnected().catch(() => false);

    if (this.lastConnected === undefined || connected !== this.lastConnected) {
      this.lastConnected = connected;
      this.emitStatus();
    }
  }

  private currentContext(): { activeFile: string | null; selectedLines: number } {
    const context = this.liveContext;

    if (!context || !Array.isArray(context.openFiles) || context.openFiles.length === 0) {
      return { activeFile: null, selectedLines: 0 };
    }

    const active = context.openFiles.find((file) => file.isActive) ?? context.openFiles[0];

    if (!active) {
      return { activeFile: null, selectedLines: 0 };
    }

    const selectedText = active.selectedText ?? "";

    return { activeFile: active.path, selectedLines: selectedText ? selectedText.split(/\r?\n/).length : 0 };
  }

  private emitStatus(): void {
    try {
      const context = this.currentContext();
      this.pi.events.emit("piconfig:ide", {
        connected: this.lastConnected ?? null,
        activeFile: context.activeFile,
        selectedLines: context.selectedLines,
      });
    } catch {
      return;
    }
  }

  private emitStatusClear(): void {
    try {
      this.pi.events.emit("piconfig:ide", { clear: true });
    } catch {
      return;
    }
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private startContextStream(ctx: ExtensionContext): void {
    this.streamHandle?.disconnect();
    this.streamHandle = this.client.connectContextStream(
      (context) => {
        this.liveContext = context;
        this.reconnectAttempt = 0;
        this.clearReconnect();
        this.emitStatus();
      },
      () => {
        this.streamHandle = undefined;
        this.liveContext = undefined;
        this.lastConnected = false;
        this.emitStatus();

        if (this.reconnectTimer) {
          return;
        }

        const delay = retryBackoffMs(this.reconnectAttempt);
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          this.startContextStream(ctx);
        }, delay);
        this.reconnectTimer.unref?.();
      },
    );
  }

  private buildContextMessage(): { message: Record<string, unknown> } | undefined {
    const context = this.liveContext;

    if (!context || !Array.isArray(context.openFiles) || context.openFiles.length === 0) {
      return undefined;
    }

    const active = context.openFiles.find((file) => file.isActive) ?? context.openFiles[0];

    if (!active) {
      return undefined;
    }

    const cursor = active.cursor ? `line ${active.cursor.line}, col ${active.cursor.character}` : "cursor unknown";
    const selectedText = active.selectedText ?? "";
    const selectedLines = selectedText ? selectedText.split(/\r?\n/).length : 0;
    const selectedPreview =
      selectedText.length > this.config.selectedPreviewMaxChars
        ? `${selectedText.slice(0, this.config.selectedPreviewMaxChars)}…`
        : selectedText;
    const selectedInfo = selectedText
      ? `"${selectedPreview}" (${selectedLines} line${selectedLines === 1 ? "" : "s"})`
      : "(none)";
    const openFileNames = context.openFiles.map((file) => file.path.split(/[\\/]/).pop() ?? file.path);
    const preview = openFileNames.slice(0, 2).join(", ");
    const remaining = openFileNames.length - 2;

    return {
      message: {
        customType: "pi-ide-bridge-editor-context",
        display: false,
        content: [
          "[IDE Context]",
          `Active file: ${active.path} — ${cursor}`,
          `Selected: ${selectedInfo}`,
          `Open files: ${preview}${remaining > 0 ? `, +${remaining} more` : ""}`,
        ].join("\n"),
        details: context,
      },
    };
  }

  private async showDiffPreview(
    requestId: string,
    filePath: string,
    beforeText: string,
    afterText: string,
  ): Promise<boolean> {
    if (beforeText === afterText || !canReviewDiff(beforeText, afterText)) {
      return false;
    }

    const connected = await this.client.isIdeConnected().catch(() => false);

    if (!connected) {
      return false;
    }

    return this.client.sendShowDiff({ filePath, beforeText, afterText, requestId });
  }

  private async readDiffBefore(filePath: string): Promise<string | null> {
    try {
      const meta = await stat(filePath);

      if (!meta.isFile() || meta.size > REVIEW_MAX_BYTES) {
        return null;
      }

      return readFile(filePath, "utf8");
    } catch {
      return "";
    }
  }

  private buildHandle(): IdeHandle {
    return {
      isConnected: () => this.client.isIdeConnected(),
      requestDiffApproval: (req) => this.handleRequestDiffApproval(req),
      previewEdit: (req) => this.previewEdit(req),
      closePreview: (id) => this.closePreview(id),
    };
  }

  private async handleRequestDiffApproval(req: IdeHandleRequest): Promise<IdeHandleApproval | undefined> {
    try {
      const pathArg = typeof req.input.path === "string" ? req.input.path.trim() : "";

      if (!pathArg) {
        return undefined;
      }

      const filePath = resolve(req.cwd, pathArg);
      const beforeText = await this.readDiffBefore(filePath);

      if (beforeText === null) {
        return undefined;
      }

      const afterText = predictAfter(filePath, req.toolName, req.input, beforeText);

      if (afterText === null || afterText === beforeText) {
        return undefined;
      }

      const requestId = `approval-${randomUUID()}`;
      const resp = await this.client.requestDiffApproval({ filePath, beforeText, afterText, requestId }, req.signal);

      if (!resp) {
        return undefined;
      }

      if (resp.decision === "accept") {
        this.recentApprovals.add(filePath);
      }

      const content = typeof resp.content === "string" ? resp.content : afterText;

      return { decision: resp.decision, content, edited: content !== afterText, beforeText };
    } catch {
      return undefined;
    }
  }

  private async previewEdit(req: IdePreviewRequest): Promise<void> {
    if (req.toolName !== "edit" && req.toolName !== "write") {
      return;
    }

    const pathArg = typeof req.args.path === "string" ? req.args.path.trim() : "";

    if (!pathArg) {
      return;
    }

    const filePath = resolve(req.cwd, pathArg);

    if (this.recentApprovals.delete(filePath)) {
      return;
    }

    const beforeText = await this.readDiffBefore(filePath);

    if (beforeText === null) {
      return;
    }

    const afterText = predictAfter(filePath, req.toolName, req.args, beforeText);
    const shown = afterText !== null && (await this.showDiffPreview(req.toolCallId, filePath, beforeText, afterText));
    this.diffSnapshots.set(req.toolCallId, { filePath, beforeText, shownText: shown ? afterText : null });
  }

  private async closePreview(toolCallId: string): Promise<void> {
    const snapshot = this.diffSnapshots.get(toolCallId);

    if (!snapshot) {
      return;
    }

    this.diffSnapshots.delete(toolCallId);

    if (snapshot.shownText !== null) {
      await this.client.sendCloseDiff(toolCallId, "closed_by_pi");
    }
  }

  private async onToolStart(
    event: { toolName?: unknown; args?: unknown; toolCallId?: unknown },
    ctx: ExtensionContext,
  ): Promise<undefined> {
    if (event.toolName !== "edit" && event.toolName !== "write") {
      return undefined;
    }

    const input = isRecord(event.args) ? event.args : {};
    const toolName = event.toolName;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";

    await this.previewEdit({ toolName, args: input, toolCallId, cwd: ctx.cwd });

    return undefined;
  }

  private async onToolEnd(event: { toolName?: unknown; toolCallId?: unknown }): Promise<undefined> {
    if (event.toolName !== "edit" && event.toolName !== "write") {
      return undefined;
    }

    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";

    await this.closePreview(toolCallId);

    return undefined;
  }

  private async executeDiagnostics(
    params: Record<string, unknown>,
    cwd: string,
    fallbackScope: DiagnosticsScope,
  ): Promise<ToolOutput> {
    const { request, error } = diagnosticsRequest(params, cwd, fallbackScope);

    if (error || !request) {
      return { content: [{ type: "text", text: `get_ide_diagnostics error: ${error ?? "invalid request"}` }], details: {} };
    }

    const diagnostics = await this.client.sendGetDiagnostics(request);

    if (!diagnostics) {
      return { content: [{ type: "text", text: "get_ide_diagnostics error: IDE bridge not connected." }], details: {} };
    }

    return { content: [{ type: "text", text: formatDiagnostics(diagnostics) }], details: { diagnostics, request } };
  }

  private registerDiagnosticsTools(): void {
    this.pi.registerTool({
      name: "get_ide_diagnostics",
      label: "Get IDE Diagnostics",
      description:
        "Retrieve current VS Code diagnostics (errors and warnings only) for active, open-files, or specific file scope.",
      promptSnippet: "Query VS Code diagnostics; prefer active scope when the request is vague.",
      promptGuidelines: [
        "Use get_ide_diagnostics when current IDE errors/warnings can help resolve the user task.",
        "When the user asks vaguely (e.g., 'check diagnostics' without scope), prefer scope='active' first.",
        "Use scope='active' for current editor, scope='all' for open files, or scope='file' with an absolute or cwd-relative filePath.",
        "Only errors and warnings are returned; hints and info are intentionally excluded by the VS Code companion.",
      ],
      parameters: Type.Object({
        scope: Type.Optional(
          Type.Union([Type.Literal("active"), Type.Literal("all"), Type.Literal("file")], {
            description: "Diagnostics scope. Defaults to 'active'.",
          }),
        ),
        filePath: Type.Optional(
          Type.String({ description: "Absolute or cwd-relative file path. Required when scope is 'file'." }),
        ),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolOutput> =>
        this.executeDiagnostics(params as Record<string, unknown>, ctx.cwd, "active"),
    });

    this.pi.registerTool({
      name: "idediagnostics",
      label: "IDE Diagnostics",
      description:
        "Read language diagnostics from the connected VS Code window. Pass path to scope to one file; omit it to list diagnostics across open files.",
      promptSnippet:
        "idediagnostics — language diagnostics from the connected IDE (errors/warnings per file, or one file via path)",
      parameters: Type.Object({
        path: Type.Optional(
          Type.String({
            description: "Absolute or cwd-relative file path to check; omit to list diagnostics across open files",
          }),
        ),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolOutput> =>
        this.executeDiagnostics(params as Record<string, unknown>, ctx.cwd, "all"),
    });
  }

  private registerIdeCommand(): void {
    this.pi.registerCommand("ide", {
      description: "Show IDE bridge status, install the VS Code companion, or inspect IDE context/diagnostics",
      getArgumentCompletions: commandCompletions,
      handler: async (args, ctx): Promise<void> => {
        const rawArgs = String(args ?? "").trim();
        const parts = rawArgs ? rawArgs.split(/\s+/) : [];
        const action = (parts[0] ?? "").toLowerCase();

        if (!action || action === "status") {
          const status = await this.client.getIdeConnectionStatus(ctx.ui.theme);
          ctx.ui.notify(status.text, status.type);
          return;
        }

        if (action === "debug") {
          const debug = await this.client.getIdeConnectionDebugInfo();

          if (debug.connected) {
            ctx.ui.notify(`Pi IDE Bridge debug: connected=yes source=${debug.source} port=${String(debug.port ?? "n/a")}`, "info");
            return;
          }

          ctx.ui.notify(`Pi IDE Bridge debug: connected=no source=${debug.source} reason=${String(debug.reason ?? "unknown")}`, "info");
          return;
        }

        if (action === "context") {
          if (!this.liveContext) {
            ctx.ui.notify("Pi IDE Bridge context: unavailable (no VS Code context received yet).", "info");
            return;
          }

          const payload = JSON.stringify(this.liveContext, null, 2);
          this.pi.sendMessage({
            customType: "pi-ide-bridge-context-debug",
            display: true,
            content: ["[IDE Context Debug]", payload].join("\n"),
            details: this.liveContext,
          });
          ctx.ui.notify("Pi IDE Bridge context dumped to chat.", "info");
          return;
        }

        if (action === "diagnostics") {
          const rest = parts.slice(1);
          const requestedScope = (rest[0] ?? "active").toLowerCase();
          const scope = requestedScope === "all" || requestedScope === "file" ? requestedScope : "active";
          const filePath = scope === "file" ? normalizeFilePath(rest.slice(1).join(" "), ctx.cwd) : undefined;

          if (scope === "file" && !filePath) {
            ctx.ui.notify("Usage: /ide diagnostics file <path>", "error");
            return;
          }

          const diagnostics = await this.client.sendGetDiagnostics({ scope, filePath });

          if (!diagnostics) {
            ctx.ui.notify("Pi IDE Bridge diagnostics: unavailable (bridge disconnected).", "error");
            return;
          }

          this.pi.sendMessage({
            customType: "pi-ide-bridge-diagnostics-debug",
            display: true,
            content: formatDiagnostics(diagnostics),
            details: diagnostics,
          });
          ctx.ui.notify(
            `Pi IDE Bridge diagnostics dumped to chat (files=${diagnostics.files.length}, errors=${diagnostics.totalErrors}, warnings=${diagnostics.totalWarnings}).`,
            "info",
          );
          return;
        }

        if (action === "install") {
          const vsixPath = parts.slice(1).join(" ").trim();
          const installed = vsixPath
            ? await installVsCodeCompanionFromLocalDebugVsix(vsixPath)
            : await installVsCodeCompanion();

          if (installed) {
            ctx.ui.notify(
              "✓ pi-config VS Code/Codium companion installed. Reload the IDE window, then run /ide status to verify connection.",
              "info",
            );
            return;
          }

          const message = vsixPath
            ? `✕ Failed to install VSIX from path: ${vsixPath}`
            : "✕ Failed to install the bundled pi-config VS Code/Codium companion extension.";
          ctx.ui.notify(message, "error");
          return;
        }

        ctx.ui.notify(IDE_USAGE, action === "help" ? "info" : "error");
      },
    });
  }
}
