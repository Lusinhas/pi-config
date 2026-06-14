import {
  McpClient,
  renderContentBlocks,
  renderPromptMessages,
  type ListChangedKind,
  type McpPromptDef,
  type McpToolCallResult,
  type McpToolDef,
} from "./client.ts";
import {
  Policy,
  ServerCache,
  TailTruncator,
  missingRequired,
  parsePromptArgs,
  sanitize,
  type ServerSpec,
  type TruncateFn,
} from "./cache.ts";
import { OAuth } from "./oauth.ts";
import { HttpTransport, StdioTransport, UnauthorizedError, type Transport } from "./transports.ts";

const REFRESH_DEBOUNCE_MS = 300;
const TOOL_CAP_LINES = 1000000;

export type ServerState = "stopped" | "starting" | "ready" | "error";

export interface ToolText {
  type: "text";
  text: string;
}

export interface ToolOutput {
  content: ToolText[];
  details: Record<string, unknown>;
}

export interface ToolDescriptor {
  name: string;
  label: string;
  description: string;
  schema: Record<string, unknown> | null;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ToolOutput) => void) | undefined,
  ) => Promise<ToolOutput>;
}

export interface ToolRegistrar {
  register(descriptor: ToolDescriptor): void;
}

export type NotifyFn = (message: string, level: "info" | "warning" | "error") => void;

export interface CommandDescriptor {
  name: string;
  description: string;
  handler: (args: string, notify: NotifyFn) => Promise<void>;
}

export interface CommandRegistrar {
  register(descriptor: CommandDescriptor): void;
}

export interface RegistryOptions {
  outputLimit: number;
  inlineLimit: number;
  requestTimeoutMs: number;
  startTimeoutMs: number;
  idleMs: number;
  stderrLines: number;
}

export interface RegistryCollaborators {
  toolRegistrar: ToolRegistrar;
  commandRegistrar: CommandRegistrar;
  sendUserMessage: (text: string) => void;
  truncate: TruncateFn;
  oauth: OAuth;
  cache: ServerCache;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class McpRegistry {
  private readonly options: RegistryOptions;
  private readonly collaborators: RegistryCollaborators;
  private readonly servers = new Map<string, ManagedServer>();
  private readonly usedToolNames = new Set<string>();
  private readonly usedCommandNames = new Set<string>();
  private shuttingDown = false;

  constructor(options: RegistryOptions, collaborators: RegistryCollaborators) {
    this.options = options;
    this.collaborators = collaborators;
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

  hasToken(name: string): boolean {
    return this.collaborators.oauth.loadToken(name) !== null;
  }

  startAll(): void {
    for (const server of this.servers.values()) {
      if (!server.spec.enabled) {
        continue;
      }

      if (server.spec.lazy && this.hydrateFromCache(server)) {
        continue;
      }

      void this.start(server).catch(() => undefined);
    }
  }

  start(server: ManagedServer): Promise<void> {
    if (server.startPromise !== null) {
      return server.startPromise;
    }

    if (server.state === "ready" || this.shuttingDown || !server.spec.enabled) {
      return Promise.resolve();
    }

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

  private hydrateFromCache(server: ManagedServer): boolean {
    const cached = this.collaborators.cache.load(server.spec);

    if (cached === null) {
      return false;
    }

    server.tools = cached.tools.filter((tool) => Policy.toolAllowed(server.spec, tool.name));
    server.prompts = cached.prompts;
    server.resourceCount = cached.resourceCount;
    this.registerTools(server);
    this.registerPrompts(server);

    return true;
  }

  private async closeConnection(server: ManagedServer): Promise<void> {
    server.generation += 1;
    const client = server.client;
    const transport = server.transport;
    server.client = null;
    server.transport = null;

    try {
      if (client !== null) {
        await client.close();
      } else if (transport !== null) {
        await transport.close();
      }
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
        const token = await this.collaborators.oauth.getAccessToken(spec.name);
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
      if (server.generation !== generation) {
        return;
      }

      server.client = null;
      server.transport = null;

      if (server.state === "ready" || server.state === "starting") {
        server.state = "stopped";
        server.error = `connection closed: ${reason}`;
      }
    });
    await transport.start();
    await client.connect({ timeoutMs: this.options.startTimeoutMs });

    if (server.generation !== generation) {
      throw new Error("server was restarted during startup");
    }

    await this.refreshLists(server, generation);

    if (server.generation !== generation) {
      throw new Error("server was restarted during startup");
    }

    server.state = "ready";
    server.lastUsed = Date.now();
    this.touchIdle(server);
  }

  private async refreshLists(server: ManagedServer, generation: number): Promise<void> {
    const client = server.client;

    if (client === null || server.generation !== generation) {
      return;
    }

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

    if (server.generation !== generation) {
      return;
    }

    server.tools = tools.filter((tool) => Policy.toolAllowed(server.spec, tool.name));
    server.prompts = prompts;
    server.resourceCount = resourceCount;
    server.error = notes.length > 0 ? notes.join("; ") : server.error;
    this.registerTools(server);
    this.registerPrompts(server);

    if (toolsOk) {
      this.collaborators.cache.save(server.spec, {
        tools: server.tools,
        prompts: server.prompts,
        resourceCount: server.resourceCount,
      });
    }
  }

  private scheduleRefresh(server: ManagedServer, generation: number, _kind: ListChangedKind): void {
    if (server.generation !== generation || server.refreshTimer !== null) {
      return;
    }

    const timer = setTimeout(() => {
      server.refreshTimer = null;

      if (server.generation !== generation || server.state !== "ready") {
        return;
      }

      void this.refreshLists(server, generation).catch(() => undefined);
    }, REFRESH_DEBOUNCE_MS);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

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
        this.collaborators.toolRegistrar.register({
          name: piName,
          label: `${server.spec.name}:${originalName}`,
          description,
          schema: tool.inputSchema,
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
    if (server.state === "ready" && server.client !== null) {
      return;
    }

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
    if (!server.spec.lazy || this.options.idleMs <= 0) {
      return;
    }

    if (server.idleTimer !== null) {
      clearTimeout(server.idleTimer);
    }

    const timer = setTimeout(() => {
      server.idleTimer = null;

      if (server.state !== "ready") {
        return;
      }

      if (server.inflight > 0 || Date.now() - server.lastUsed < this.options.idleMs) {
        this.touchIdle(server);
        return;
      }

      void this.stop(server, "stopped after idle timeout").catch(() => undefined);
    }, this.options.idleMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

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

    if (client === null) {
      throw new Error(`MCP server "${server.spec.name}" is not connected`);
    }

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
          if (onUpdate === undefined) {
            return;
          }

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
    const capped = this.collaborators.truncate(text, { maxBytes: this.options.outputLimit, maxLines: TOOL_CAP_LINES });

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

      if (server.promptCommands.has(commandName) || this.usedCommandNames.has(commandName)) {
        continue;
      }

      const promptName = prompt.name;
      const argHint =
        prompt.arguments.length > 0 ? ` Arguments: ${prompt.arguments.map((arg) => arg.name).join(", ")}.` : "";

      try {
        this.collaborators.commandRegistrar.register({
          name: commandName,
          description: `MCP prompt from "${server.spec.name}"${prompt.description !== "" ? `: ${prompt.description}` : ""}${argHint}`,
          handler: async (args: string, notify: NotifyFn): Promise<void> =>
            this.runPrompt(server, promptName, args ?? "", notify),
        });
        server.promptCommands.add(commandName);
        this.usedCommandNames.add(commandName);
      } catch {
        continue;
      }
    }
  }

  private async runPrompt(server: ManagedServer, promptName: string, args: string, notify: NotifyFn): Promise<void> {
    try {
      await this.ensureReady(server);
      const client = server.client;

      if (client === null) {
        throw new Error(`MCP server "${server.spec.name}" is not connected`);
      }

      const prompt = server.prompts.find((entry) => entry.name === promptName);

      if (prompt === undefined) {
        throw new Error(`prompt "${promptName}" is no longer provided by MCP server "${server.spec.name}"`);
      }

      server.inflight += 1;
      this.touch(server);

      try {
        const parsed = parsePromptArgs(args, prompt.arguments);
        const missing = missingRequired(prompt.arguments, parsed);

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

        this.collaborators.sendUserMessage(text);
      } finally {
        server.inflight -= 1;
        this.touch(server);
      }
    } catch (error) {
      notify(toError(error).message, "error");
    }
  }
}

const EMPTY_LIST = "No MCP servers configured. Add entries under mcp.servers in suite.json or to .mcp.json.";

export class ServerFormatter {
  private readonly registry: McpRegistry;

  constructor(registry: McpRegistry) {
    this.registry = registry;
  }

  list(): string {
    const servers = this.registry.list();

    if (servers.length === 0) {
      return EMPTY_LIST;
    }

    return ["MCP servers:", ...servers.map((server) => this.server(server))].join("\n");
  }

  server(server: ManagedServer): string {
    const spec = server.spec;
    const tags: string[] = [spec.kind, spec.source];

    if (spec.lazy) {
      tags.push(server.state === "stopped" && server.tools.length > 0 ? "lazy, starts on first use" : "lazy");
    }

    if (!spec.enabled) {
      tags.push("disabled");
    }

    if (spec.kind === "http") {
      if (server.needsAuth) {
        tags.push("needs auth");
      } else if (this.registry.hasToken(spec.name)) {
        tags.push("authorized");
      }
    }

    if (server.tools.length > 0 || server.prompts.length > 0 || server.resourceCount > 0 || server.state === "ready") {
      tags.push(`${server.tools.length} tools, ${server.prompts.length} prompts, ${server.resourceCount} resources`);
    }

    const errorNote = server.error !== null && server.error !== "" ? ` (${server.error})` : "";

    return `  ${spec.name}: ${server.state}${errorNote} [${tags.join("; ")}]`;
  }
}

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

export interface CommandSession {
  notify: NotifyFn;
  hasUI: boolean;
  authorize: (server: ManagedServer) => Promise<void>;
}

export class CommandHandler {
  private readonly registry: McpRegistry;
  private readonly formatter: ServerFormatter;

  constructor(registry: McpRegistry, formatter: ServerFormatter) {
    this.registry = registry;
    this.formatter = formatter;
  }

  completions(argumentPrefix: string): CompletionItem[] | null {
    const prefix = argumentPrefix.trimStart();
    const items: CompletionItem[] = [];

    for (const server of this.registry.list()) {
      items.push({
        value: `restart ${server.spec.name}`,
        label: `restart ${server.spec.name}`,
        description: `restart this ${server.spec.kind} server`,
      });

      if (server.spec.kind === "http") {
        items.push({
          value: `auth ${server.spec.name}`,
          label: `auth ${server.spec.name}`,
          description: "run the OAuth flow for this server",
        });
      }
    }

    const matches = items.filter((item) => item.value.startsWith(prefix));

    return matches.length > 0 ? matches : null;
  }

  async handle(args: string, session: CommandSession): Promise<void> {
    const trimmed = (args ?? "").trim();

    if (trimmed === "") {
      session.notify(this.formatter.list(), "info");
      return;
    }

    const [sub, ...rest] = trimmed.split(/\s+/);
    const name = rest.join(" ").trim();

    if (sub !== "restart" && sub !== "auth") {
      session.notify(`Unknown subcommand "${sub}". Usage: /mcp | /mcp restart <server> | /mcp auth <server>`, "error");
      return;
    }

    if (name === "") {
      session.notify(`Usage: /mcp ${sub} <server>`, "error");
      return;
    }

    const server = this.registry.get(name);

    if (server === undefined) {
      const names = this.registry
        .list()
        .map((entry) => entry.spec.name)
        .join(", ");
      session.notify(`Unknown MCP server "${name}".${names !== "" ? ` Known servers: ${names}` : ""}`, "error");
      return;
    }

    if (sub === "restart") {
      await this.restart(name, server, session);
      return;
    }

    await this.auth(name, server, session);
  }

  private async restart(name: string, server: ManagedServer, session: CommandSession): Promise<void> {
    if (!server.spec.enabled) {
      session.notify(`MCP server "${name}" is disabled in its configuration.`, "error");
      return;
    }

    session.notify(`Restarting MCP server "${name}"...`, "info");

    try {
      await this.registry.restart(server);
      session.notify(this.readyLine(name, server), "info");
    } catch (error) {
      session.notify(`Restart of "${name}" failed: ${toError(error).message}`, "error");
    }
  }

  private async auth(name: string, server: ManagedServer, session: CommandSession): Promise<void> {
    if (server.spec.kind !== "http") {
      session.notify(`MCP server "${name}" runs over stdio; OAuth only applies to HTTP servers.`, "error");
      return;
    }

    if (!session.hasUI) {
      return;
    }

    try {
      await session.authorize(server);
      session.notify(`Stored OAuth tokens for "${name}". Restarting the server...`, "info");
      await this.registry.restart(server);
      session.notify(this.readyLine(name, server), "info");
    } catch (error) {
      session.notify(`Authorization for "${name}" failed: ${toError(error).message}`, "error");
    }
  }

  private readyLine(name: string, server: ManagedServer): string {
    return `MCP server "${name}" is ready: ${server.tools.length} tools, ${server.prompts.length} prompts, ${server.resourceCount} resources.`;
  }
}

export {
  Policy,
  ServerCache,
  TailTruncator,
  collectServerSpecs,
  parseServerSpec,
  readMcpJson,
  sanitize,
  specHash,
  type ServerSpec,
  type CachedLists,
  type Framing,
} from "./cache.ts";
export { OAuth, TokenStore, type AuthUi, type StoredToken } from "./oauth.ts";
