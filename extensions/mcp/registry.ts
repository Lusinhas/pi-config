import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncateTail, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  McpClient,
  renderContentBlocks,
  renderPromptMessages,
  type ListChangedKind,
  type McpPromptArgDef,
  type McpPromptDef,
  type McpToolCallResult,
  type McpToolDef,
} from "./client";
import { loadServerCache, saveServerCache } from "./cache";
import { getAccessToken } from "./oauth";
import { HttpTransport, StdioTransport, UnauthorizedError, type Transport } from "./transports";

const REFRESH_DEBOUNCE_MS = 300;
const TOOL_CAP_LINES = 1000000;

export interface StdioServerSpec {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  framing: "ndjson" | "lsp";
  enabled: boolean;
  allow: string[] | null;
  deny: string[];
  timeoutMs: number | null;
  lazy: boolean;
  source: string;
}

export interface HttpServerSpec {
  kind: "http";
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  allow: string[] | null;
  deny: string[];
  timeoutMs: number | null;
  lazy: boolean;
  source: string;
}

export type ServerSpec = StdioServerSpec | HttpServerSpec;

export type ServerState = "stopped" | "starting" | "ready" | "error";

export interface ManagedServer {
  spec: ServerSpec;
  state: ServerState;
  error: string | null;
  needsAuth: boolean;
  wwwAuthenticate: string | null;
  client: McpClient | null;
  transport: Transport | null;
  tools: McpToolDef[];
  prompts: McpPromptDef[];
  resourceCount: number;
  toolNames: Map<string, string>;
  promptCommands: Set<string>;
  startPromise: Promise<void> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
  generation: number;
  inflight: number;
}

export interface RegistryOptions {
  outputLimit: number;
  inlineLimit: number;
  requestTimeoutMs: number;
  startTimeoutMs: number;
  idleMs: number;
  stderrLines: number;
}

interface ToolText {
  type: "text";
  text: string;
}

interface ToolOutput {
  content: ToolText[];
  details: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
  }
  return out;
}

function sanitize(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === "" ? "x" : cleaned;
}

export function parseServerSpec(
  name: string,
  raw: unknown,
  defaultLazy: boolean,
  source: string,
  defaultFraming: "ndjson" | "lsp",
): ServerSpec | null {
  if (!isRecord(raw) || name.trim() === "") return null;
  const enabled = raw.enabled !== false;
  const lazy = typeof raw.lazy === "boolean" ? raw.lazy : defaultLazy;
  const allow = stringArray(raw.allow);
  const deny = stringArray(raw.deny) ?? [];
  const timeoutMs =
    typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : null;
  if (typeof raw.url === "string" && raw.url !== "") {
    return {
      kind: "http",
      name,
      url: raw.url,
      headers: stringMap(raw.headers),
      enabled,
      allow,
      deny,
      timeoutMs,
      lazy,
      source,
    };
  }
  if (typeof raw.command === "string" && raw.command !== "") {
    const framing = raw.framing === "lsp" ? "lsp" : raw.framing === "ndjson" ? "ndjson" : defaultFraming;
    return {
      kind: "stdio",
      name,
      command: raw.command,
      args: stringArray(raw.args) ?? [],
      env: stringMap(raw.env),
      framing,
      enabled,
      allow,
      deny,
      timeoutMs,
      lazy,
      source,
    };
  }
  return null;
}

function readMcpJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return {};
    return isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

export function collectServerSpecs(
  configServers: Record<string, unknown>,
  defaultFraming: "ndjson" | "lsp",
  cwd: string,
  defaultLazy: boolean,
): ServerSpec[] {
  const merged = new Map<string, ServerSpec>();
  const add = (name: string, raw: unknown, source: string): void => {
    const spec = parseServerSpec(name, raw, defaultLazy, source, defaultFraming);
    if (spec !== null) merged.set(name, spec);
  };
  for (const [name, raw] of Object.entries(configServers)) add(name, raw, "config");
  for (const [name, raw] of Object.entries(readMcpJson(join(homedir(), ".pi", "agent", ".mcp.json")))) {
    add(name, raw, "global .mcp.json");
  }
  for (const [name, raw] of Object.entries(readMcpJson(join(cwd, ".mcp.json")))) {
    add(name, raw, "project .mcp.json");
  }
  return [...merged.values()];
}

function toParameters(schema: Record<string, unknown> | null): TSchema {
  if (schema !== null && schema.type === "object") return Type.Unsafe(schema);
  return Type.Unsafe({ type: "object", properties: {}, additionalProperties: true });
}

function parsePromptArgs(input: string, defs: McpPromptArgDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  const leftovers: string[] = [];
  const tokens = input.trim() === "" ? [] : input.trim().split(/\s+/);
  for (const token of tokens) {
    const eq = token.indexOf("=");
    const key = eq > 0 ? token.slice(0, eq) : "";
    if (eq > 0 && defs.some((def) => def.name === key)) {
      const value = token.slice(eq + 1);
      out[key] = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    } else {
      leftovers.push(token);
    }
  }
  if (leftovers.length > 0) {
    const free = defs.find((def) => out[def.name] === undefined);
    if (free !== undefined) out[free.name] = leftovers.join(" ");
  }
  return out;
}

export class McpRegistry {
  private readonly pi: ExtensionAPI;
  private readonly options: RegistryOptions;
  private readonly servers = new Map<string, ManagedServer>();
  private readonly usedToolNames = new Set<string>();
  private readonly usedCommandNames = new Set<string>();
  private shuttingDown = false;

  constructor(pi: ExtensionAPI, options: RegistryOptions) {
    this.pi = pi;
    this.options = options;
  }

  addServer(spec: ServerSpec): void {
    this.servers.set(spec.name, {
      spec,
      state: "stopped",
      error: null,
      needsAuth: false,
      wwwAuthenticate: null,
      client: null,
      transport: null,
      tools: [],
      prompts: [],
      resourceCount: 0,
      toolNames: new Map(),
      promptCommands: new Set(),
      startPromise: null,
      idleTimer: null,
      refreshTimer: null,
      lastUsed: 0,
      generation: 0,
      inflight: 0,
    });
  }

  get(name: string): ManagedServer | undefined {
    return this.servers.get(name);
  }

  list(): ManagedServer[] {
    return [...this.servers.values()].sort((a, b) => a.spec.name.localeCompare(b.spec.name));
  }

  startAll(): void {
    for (const server of this.servers.values()) {
      if (!server.spec.enabled) continue;
      if (server.spec.lazy && this.hydrateFromCache(server)) continue;
      void this.start(server).catch(() => undefined);
    }
  }

  private hydrateFromCache(server: ManagedServer): boolean {
    const cached = loadServerCache(server.spec);
    if (cached === null) return false;
    server.tools = cached.tools.filter((tool) => this.toolAllowed(server.spec, tool.name));
    server.prompts = cached.prompts;
    server.resourceCount = cached.resourceCount;
    this.registerTools(server);
    this.registerPrompts(server);
    return true;
  }

  start(server: ManagedServer): Promise<void> {
    if (server.startPromise !== null) return server.startPromise;
    if (server.state === "ready" || this.shuttingDown || !server.spec.enabled) return Promise.resolve();
    const promise = (async (): Promise<void> => {
      try {
        await this.doStart(server);
      } catch (error) {
        const err = toError(error);
        server.state = "error";
        if (err instanceof UnauthorizedError) {
          server.needsAuth = true;
          server.wwwAuthenticate = err.wwwAuthenticate;
          server.error = `authentication required; run /mcp auth ${server.spec.name}`;
        } else {
          server.error = err.message;
        }
        await this.closeConnection(server);
        throw err;
      }
    })();
    const tracked = promise.finally(() => {
      server.startPromise = null;
    });
    server.startPromise = tracked;
    return tracked;
  }

  async restart(server: ManagedServer): Promise<void> {
    await this.stop(server, null);
    server.needsAuth = false;
    server.wwwAuthenticate = null;
    server.error = null;
    await this.start(server);
  }

  async stop(server: ManagedServer, note: string | null): Promise<void> {
    if (server.idleTimer !== null) {
      clearTimeout(server.idleTimer);
      server.idleTimer = null;
    }
    if (server.refreshTimer !== null) {
      clearTimeout(server.refreshTimer);
      server.refreshTimer = null;
    }
    await this.closeConnection(server);
    server.state = "stopped";
    server.error = note;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const tasks: Promise<void>[] = [];
    for (const server of this.servers.values()) {
      tasks.push(this.stop(server, null).catch(() => undefined));
    }
    await Promise.all(tasks);
  }

  private async closeConnection(server: ManagedServer): Promise<void> {
    server.generation += 1;
    const client = server.client;
    const transport = server.transport;
    server.client = null;
    server.transport = null;
    try {
      if (client !== null) await client.close();
      else if (transport !== null) await transport.close();
    } catch {
      return;
    }
  }

  private createTransport(spec: ServerSpec): Transport {
    if (spec.kind === "stdio") {
      return new StdioTransport({
        command: spec.command,
        args: spec.args,
        env: spec.env,
        framing: spec.framing,
        stderrLines: this.options.stderrLines,
      });
    }
    return new HttpTransport({
      url: spec.url,
      headers: spec.headers,
      requestTimeoutMs: spec.timeoutMs ?? this.options.requestTimeoutMs,
      getAuthorization: async (): Promise<string | null> => {
        const token = await getAccessToken(spec.name);
        return token !== null ? `Bearer ${token}` : null;
      },
    });
  }

  private async doStart(server: ManagedServer): Promise<void> {
    server.state = "starting";
    server.error = null;
    server.needsAuth = false;
    server.generation += 1;
    const generation = server.generation;
    const transport = this.createTransport(server.spec);
    server.transport = transport;
    const client = new McpClient(transport, {
      requestTimeoutMs: server.spec.timeoutMs ?? this.options.requestTimeoutMs,
      onListChanged: (kind) => this.scheduleRefresh(server, generation, kind),
    });
    server.client = client;
    transport.onClose((reason) => {
      if (server.generation !== generation) return;
      server.client = null;
      server.transport = null;
      if (server.state === "ready" || server.state === "starting") {
        server.state = "stopped";
        server.error = `connection closed: ${reason}`;
      }
    });
    await transport.start();
    await client.connect({ timeoutMs: this.options.startTimeoutMs });
    if (server.generation !== generation) throw new Error("server was restarted during startup");
    await this.refreshLists(server, generation);
    if (server.generation !== generation) throw new Error("server was restarted during startup");
    server.state = "ready";
    server.lastUsed = Date.now();
    this.touchIdle(server);
  }

  private toolAllowed(spec: ServerSpec, name: string): boolean {
    if (spec.deny.includes(name)) return false;
    if (spec.allow !== null) return spec.allow.includes(name);
    return true;
  }

  private async refreshLists(server: ManagedServer, generation: number): Promise<void> {
    const client = server.client;
    if (client === null || server.generation !== generation) return;
    const notes: string[] = [];
    let tools: McpToolDef[] = [];
    let toolsOk = false;
    try {
      tools = await client.listTools();
      toolsOk = true;
    } catch (error) {
      notes.push(`tools/list failed: ${toError(error).message}`);
    }
    let prompts: McpPromptDef[] = [];
    try {
      prompts = await client.listPrompts();
    } catch (error) {
      notes.push(`prompts/list failed: ${toError(error).message}`);
    }
    let resourceCount = 0;
    try {
      resourceCount = (await client.listResources()).length;
    } catch (error) {
      notes.push(`resources/list failed: ${toError(error).message}`);
    }
    if (server.generation !== generation) return;
    server.tools = tools.filter((tool) => this.toolAllowed(server.spec, tool.name));
    server.prompts = prompts;
    server.resourceCount = resourceCount;
    server.error = notes.length > 0 ? notes.join("; ") : server.error;
    this.registerTools(server);
    this.registerPrompts(server);
    if (toolsOk) {
      saveServerCache(server.spec, {
        tools: server.tools,
        prompts: server.prompts,
        resourceCount: server.resourceCount,
      });
    }
  }

  private scheduleRefresh(server: ManagedServer, generation: number, _kind: ListChangedKind): void {
    if (server.generation !== generation || server.refreshTimer !== null) return;
    const timer = setTimeout(() => {
      server.refreshTimer = null;
      if (server.generation !== generation || server.state !== "ready") return;
      void this.refreshLists(server, generation).catch(() => undefined);
    }, REFRESH_DEBOUNCE_MS);
    if (typeof timer.unref === "function") timer.unref();
    server.refreshTimer = timer;
  }

  private uniqueToolName(serverName: string, toolName: string): string {
    const base = `mcp${sanitize(serverName)}${sanitize(toolName)}`;
    let candidate = base;
    let counter = 2;
    while (this.usedToolNames.has(candidate)) {
      candidate = `${base}${counter}`;
      counter += 1;
    }
    this.usedToolNames.add(candidate);
    return candidate;
  }

  private registerTools(server: ManagedServer): void {
    for (const tool of server.tools) {
      let piName = server.toolNames.get(tool.name);
      if (piName === undefined) {
        piName = this.uniqueToolName(server.spec.name, tool.name);
        server.toolNames.set(tool.name, piName);
      }
      const originalName = tool.name;
      const description = `MCP tool "${originalName}" from server "${server.spec.name}". ${tool.description}`.trim();
      try {
        this.pi.registerTool({
          name: piName,
          label: `${server.spec.name}:${originalName}`,
          description,
          parameters: toParameters(tool.inputSchema),
          execute: async (
            _toolCallId: string,
            params: Record<string, unknown>,
            signal: AbortSignal | undefined,
            onUpdate: ((update: ToolOutput) => void) | undefined,
          ): Promise<ToolOutput> => this.executeTool(server, originalName, params, signal, onUpdate),
        });
      } catch {
        continue;
      }
    }
  }

  private async ensureReady(server: ManagedServer): Promise<void> {
    if (server.state === "ready" && server.client !== null) return;
    if (server.needsAuth) {
      throw new Error(`MCP server "${server.spec.name}" requires authentication; run /mcp auth ${server.spec.name}`);
    }
    await this.start(server);
    if (server.state !== "ready" || server.client === null) {
      throw new Error(
        `MCP server "${server.spec.name}" is not available${server.error !== null ? `: ${server.error}` : ""}`,
      );
    }
  }

  private touch(server: ManagedServer): void {
    server.lastUsed = Date.now();
    this.touchIdle(server);
  }

  private touchIdle(server: ManagedServer): void {
    if (!server.spec.lazy || this.options.idleMs <= 0) return;
    if (server.idleTimer !== null) clearTimeout(server.idleTimer);
    const timer = setTimeout(() => {
      server.idleTimer = null;
      if (server.state !== "ready") return;
      if (server.inflight > 0 || Date.now() - server.lastUsed < this.options.idleMs) {
        this.touchIdle(server);
        return;
      }
      void this.stop(server, "stopped after idle timeout").catch(() => undefined);
    }, this.options.idleMs);
    if (typeof timer.unref === "function") timer.unref();
    server.idleTimer = timer;
  }

  private async executeTool(
    server: ManagedServer,
    toolName: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ToolOutput) => void) | undefined,
  ): Promise<ToolOutput> {
    await this.ensureReady(server);
    const client = server.client;
    if (client === null) throw new Error(`MCP server "${server.spec.name}" is not connected`);
    const known = server.tools.some((tool) => tool.name === toolName);
    if (!known) {
      throw new Error(`tool "${toolName}" is no longer provided by MCP server "${server.spec.name}"`);
    }
    server.inflight += 1;
    this.touch(server);
    let result: McpToolCallResult;
    try {
      result = await client.callTool(toolName, isRecord(params) ? params : {}, {
        signal,
        onProgress: (progress) => {
          if (onUpdate === undefined) return;
          const total = progress.total !== null ? `/${progress.total}` : "";
          const note = progress.message !== null ? ` ${progress.message}` : "";
          try {
            onUpdate({
              content: [{ type: "text", text: `progress ${progress.progress}${total}${note}` }],
              details: { server: server.spec.name, tool: toolName },
            });
          } catch {
            return;
          }
        },
      });
    } catch (error) {
      const err = toError(error);
      if (err instanceof UnauthorizedError) {
        server.needsAuth = true;
        server.wwwAuthenticate = err.wwwAuthenticate;
        throw new Error(`MCP server "${server.spec.name}" requires authentication; run /mcp auth ${server.spec.name}`);
      }
      throw err;
    } finally {
      server.inflight -= 1;
      this.touch(server);
    }
    const rendered = renderContentBlocks(result.content, this.options.inlineLimit);
    const text = rendered === "" ? "(empty result)" : rendered;
    const capped = truncateTail(text, { maxBytes: this.options.outputLimit, maxLines: TOOL_CAP_LINES });
    if (result.isError) {
      throw new Error(capped.content === "" ? `MCP tool "${toolName}" failed` : capped.content);
    }
    const finalText =
      capped.truncated === true
        ? `[mcp output truncated: showing the last ${Buffer.byteLength(capped.content, "utf8")} of ${capped.totalBytes} bytes]\n${capped.content}`
        : capped.content;
    return {
      content: [{ type: "text", text: finalText }],
      details: { server: server.spec.name, tool: toolName },
    };
  }

  private registerPrompts(server: ManagedServer): void {
    for (const prompt of server.prompts) {
      const commandName = `mcp:${server.spec.name}:${prompt.name}`;
      if (server.promptCommands.has(commandName) || this.usedCommandNames.has(commandName)) continue;
      const promptName = prompt.name;
      const argHint =
        prompt.arguments.length > 0 ? ` Arguments: ${prompt.arguments.map((arg) => arg.name).join(", ")}.` : "";
      try {
        this.pi.registerCommand(commandName, {
          description: `MCP prompt from "${server.spec.name}"${prompt.description !== "" ? `: ${prompt.description}` : ""}${argHint}`,
          handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> =>
            this.runPrompt(server, promptName, args ?? "", ctx),
        });
        server.promptCommands.add(commandName);
        this.usedCommandNames.add(commandName);
      } catch {
        continue;
      }
    }
  }

  private async runPrompt(
    server: ManagedServer,
    promptName: string,
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const notify = (message: string, level: "info" | "warning" | "error"): void => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
    };
    try {
      await this.ensureReady(server);
      const client = server.client;
      if (client === null) throw new Error(`MCP server "${server.spec.name}" is not connected`);
      const prompt = server.prompts.find((entry) => entry.name === promptName);
      if (prompt === undefined) {
        throw new Error(`prompt "${promptName}" is no longer provided by MCP server "${server.spec.name}"`);
      }
      server.inflight += 1;
      this.touch(server);
      try {
        const parsed = parsePromptArgs(args, prompt.arguments);
        const missing = prompt.arguments
          .filter((arg) => arg.required && parsed[arg.name] === undefined)
          .map((arg) => arg.name);
        if (missing.length > 0) {
          notify(
            `Missing required argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Usage: /mcp:${server.spec.name}:${promptName} name=value ...`,
            "error",
          );
          return;
        }
        const messages = await client.getPrompt(promptName, parsed);
        const text = renderPromptMessages(messages, this.options.inlineLimit);
        if (text === "") {
          notify(`Prompt "${promptName}" returned no content.`, "warning");
          return;
        }
        this.pi.sendUserMessage(text);
      } finally {
        server.inflight -= 1;
        this.touch(server);
      }
    } catch (error) {
      notify(toError(error).message, "error");
    }
  }
}
