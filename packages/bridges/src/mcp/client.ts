import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type Transport,
} from "./transports.ts";

export const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "pi-config-mcp";
const CLIENT_VERSION = "1.0.0";
const MAX_PAGES = 50;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
}

export interface McpPromptArgDef {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPromptDef {
  name: string;
  description: string;
  arguments: McpPromptArgDef[];
}

export interface McpResourceDef {
  uri: string;
  name: string;
  mimeType: string;
}

export interface McpContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError: boolean;
}

export interface McpPromptMessage {
  role: string;
  content: McpContentBlock[];
}

export interface McpServerCapabilities {
  tools: boolean;
  toolsListChanged: boolean;
  prompts: boolean;
  promptsListChanged: boolean;
  resources: boolean;
  resourcesListChanged: boolean;
}

export interface McpProgress {
  progress: number;
  total: number | null;
  message: string | null;
}

export type ListChangedKind = "tools" | "prompts" | "resources";

export interface McpClientOptions {
  requestTimeoutMs: number;
  onListChanged?: (kind: ListChangedKind) => void;
}

interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: McpProgress) => void;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes("MCP error -32601");
}

export function parsePromptArguments(value: unknown): McpPromptArgDef[] {
  const args: McpPromptArgDef[] = [];

  if (Array.isArray(value)) {
    for (const arg of value) {
      if (!isRecord(arg) || typeof arg.name !== "string" || arg.name === "") {
        continue;
      }

      args.push({
        name: arg.name,
        description: typeof arg.description === "string" ? arg.description : "",
        required: arg.required === true,
      });
    }
  }

  return args;
}

export function parseToolDefs(raw: Record<string, unknown>[]): McpToolDef[] {
  const out: McpToolDef[] = [];

  for (const item of raw) {
    if (typeof item.name !== "string" || item.name === "") {
      continue;
    }

    out.push({
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      inputSchema: isRecord(item.inputSchema) ? item.inputSchema : null,
    });
  }

  return out;
}

export function parsePromptDefs(raw: Record<string, unknown>[]): McpPromptDef[] {
  const out: McpPromptDef[] = [];

  for (const item of raw) {
    if (typeof item.name !== "string" || item.name === "") {
      continue;
    }

    out.push({
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      arguments: parsePromptArguments(item.arguments),
    });
  }

  return out;
}

export function parseResourceDefs(raw: Record<string, unknown>[]): McpResourceDef[] {
  const out: McpResourceDef[] = [];

  for (const item of raw) {
    if (typeof item.uri !== "string" || item.uri === "") {
      continue;
    }

    out.push({
      uri: item.uri,
      name: typeof item.name === "string" ? item.name : "",
      mimeType: typeof item.mimeType === "string" ? item.mimeType : "",
    });
  }

  return out;
}

export function base64Size(data: unknown): number {
  if (typeof data !== "string" || data.length === 0) {
    return 0;
  }

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }

  if (bytes < 1048576) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }

  return `${(bytes / 1048576).toFixed(1)}MB`;
}

export function renderContentBlocks(blocks: McpContentBlock[], inlineLimit: number): string {
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        if (typeof block.text === "string" && block.text !== "") {
          parts.push(block.text);
        }

        break;
      }

      case "image": {
        const mime = typeof block.mimeType === "string" ? block.mimeType : "unknown type";
        parts.push(`[image ${mime}, ${formatBytes(base64Size(block.data))}]`);
        break;
      }

      case "audio": {
        const mime = typeof block.mimeType === "string" ? block.mimeType : "unknown type";
        parts.push(`[audio ${mime}, ${formatBytes(base64Size(block.data))}]`);
        break;
      }

      case "resource": {
        const resource = isRecord(block.resource) ? block.resource : {};
        const uri = typeof resource.uri === "string" ? resource.uri : "unknown uri";

        if (typeof resource.text === "string") {
          const size = Buffer.byteLength(resource.text, "utf8");

          if (size <= inlineLimit) {
            parts.push(`[resource ${uri}]\n${resource.text}`);
          } else {
            parts.push(`[resource ${uri}: ${formatBytes(size)} of text, too large to inline]`);
          }
        } else if (typeof resource.blob === "string") {
          const mime = typeof resource.mimeType === "string" ? resource.mimeType : "binary";
          parts.push(`[resource ${uri}: ${mime}, ${formatBytes(base64Size(resource.blob))}]`);
        } else {
          parts.push(`[resource ${uri}]`);
        }

        break;
      }

      case "resource_link": {
        const uri = typeof block.uri === "string" ? block.uri : "unknown uri";
        const name = typeof block.name === "string" && block.name !== "" ? ` (${block.name})` : "";
        parts.push(`[resource link ${uri}${name}]`);
        break;
      }

      default:
        parts.push(`[unsupported content type "${block.type}"]`);
    }
  }

  return parts.join("\n\n");
}

export function renderPromptMessages(messages: McpPromptMessage[], inlineLimit: number): string {
  const parts: string[] = [];

  for (const message of messages) {
    const text = renderContentBlocks(message.content, inlineLimit);

    if (text === "") {
      continue;
    }

    parts.push(messages.length > 1 ? `[${message.role}]\n${text}` : text);
  }

  return parts.join("\n\n").trim();
}

export class McpClient {
  private readonly transport: Transport;
  private readonly options: McpClientOptions;
  private readonly pending = new Map<number, Pending>();
  private readonly progressHandlers = new Map<number, (progress: McpProgress) => void>();
  private nextId = 0;
  private closed = false;
  serverName = "";
  serverVersion = "";
  capabilities: McpServerCapabilities = {
    tools: false,
    toolsListChanged: false,
    prompts: false,
    promptsListChanged: false,
    resources: false,
    resourcesListChanged: false,
  };

  constructor(transport: Transport, options: McpClientOptions) {
    this.transport = transport;
    this.options = options;
    transport.onMessage((message) => this.dispatch(message));
    transport.onClose((reason) => {
      this.closed = true;
      this.failAll(new Error(`MCP connection closed: ${reason}`));
    });
  }

  async connect(options?: { timeoutMs?: number }): Promise<void> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
      { timeoutMs: options?.timeoutMs },
    );
    const record = isRecord(result) ? result : {};
    const info = isRecord(record.serverInfo) ? record.serverInfo : {};
    this.serverName = typeof info.name === "string" ? info.name : "";
    this.serverVersion = typeof info.version === "string" ? info.version : "";
    const caps = isRecord(record.capabilities) ? record.capabilities : {};
    const tools = isRecord(caps.tools) ? caps.tools : null;
    const prompts = isRecord(caps.prompts) ? caps.prompts : null;
    const resources = isRecord(caps.resources) ? caps.resources : null;
    this.capabilities = {
      tools: tools !== null,
      toolsListChanged: tools !== null && tools.listChanged === true,
      prompts: prompts !== null,
      promptsListChanged: prompts !== null && prompts.listChanged === true,
      resources: resources !== null,
      resourcesListChanged: resources !== null && resources.listChanged === true,
    };
    const version =
      typeof record.protocolVersion === "string" && record.protocolVersion !== ""
        ? record.protocolVersion
        : PROTOCOL_VERSION;
    this.transport.setProtocolVersion(version);
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpToolDef[]> {
    if (!this.capabilities.tools) {
      return [];
    }

    return parseToolDefs(await this.paginate("tools/list", "tools"));
  }

  async listPrompts(): Promise<McpPromptDef[]> {
    if (!this.capabilities.prompts) {
      return [];
    }

    return parsePromptDefs(await this.paginate("prompts/list", "prompts"));
  }

  async listResources(): Promise<McpResourceDef[]> {
    if (!this.capabilities.resources) {
      return [];
    }

    return parseResourceDefs(await this.paginate("resources/list", "resources"));
  }

  async callTool(name: string, args: Record<string, unknown>, options?: RequestOptions): Promise<McpToolCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, options);
    const record = isRecord(result) ? result : {};
    const content: McpContentBlock[] = [];

    if (Array.isArray(record.content)) {
      for (const block of record.content) {
        if (isRecord(block) && typeof block.type === "string") {
          content.push(block as McpContentBlock);
        }
      }
    }

    return { content, isError: record.isError === true };
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<McpPromptMessage[]> {
    const result = await this.request("prompts/get", { name, arguments: args });
    const record = isRecord(result) ? result : {};
    const out: McpPromptMessage[] = [];

    if (Array.isArray(record.messages)) {
      for (const message of record.messages) {
        if (!isRecord(message)) {
          continue;
        }

        const role = typeof message.role === "string" ? message.role : "user";
        const rawContent = message.content;
        const blocks: McpContentBlock[] = [];
        const candidates = Array.isArray(rawContent) ? rawContent : [rawContent];

        for (const block of candidates) {
          if (isRecord(block) && typeof block.type === "string") {
            blocks.push(block as McpContentBlock);
          }
        }

        out.push({ role, content: blocks });
      }
    }

    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("MCP client closed"));
    await this.transport.close();
  }

  private async paginate(method: string, key: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params: Record<string, unknown> = cursor === null ? {} : { cursor };
      let result: unknown;

      try {
        result = await this.request(method, params);
      } catch (error) {
        if (out.length === 0 && isMethodNotFound(error)) {
          return [];
        }

        throw error;
      }

      const record = isRecord(result) ? result : {};
      const items = Array.isArray(record[key]) ? (record[key] as unknown[]) : [];

      for (const item of items) {
        if (isRecord(item)) {
          out.push(item);
        }
      }

      cursor = typeof record.nextCursor === "string" && record.nextCursor !== "" ? record.nextCursor : null;

      if (cursor === null) {
        break;
      }
    }

    return out;
  }

  private async request(
    method: string,
    params: Record<string, unknown> | undefined,
    options?: RequestOptions,
  ): Promise<unknown> {
    if (this.closed) {
      throw new Error("MCP client is closed");
    }

    if (options?.signal?.aborted) {
      throw new Error(`MCP request "${method}" was aborted`);
    }

    const id = ++this.nextId;
    let finalParams = params;

    if (options?.onProgress) {
      this.progressHandlers.set(id, options.onProgress);
      finalParams = { ...(params ?? {}), _meta: { progressToken: id } };
    }

    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method };

    if (finalParams !== undefined) {
      message.params = finalParams;
    }

    const timeoutMs = options?.timeoutMs ?? this.options.requestTimeoutMs;
    const controller = new AbortController();
    const onAbort = (): void => this.cancel(id, "was aborted");
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => this.cancel(id, `timed out after ${timeoutMs}ms`), timeoutMs);

        if (typeof timer.unref === "function") {
          timer.unref();
        }

        this.pending.set(id, { method, resolve, reject, timer, controller });
        void this.transport.send(message, controller.signal).catch((error: unknown) => {
          this.settle(id, undefined, toError(error));
        });
      });
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
      this.progressHandlers.delete(id);
    }
  }

  private cancel(id: number, reason: string): void {
    const entry = this.pending.get(id);

    if (entry === undefined) {
      return;
    }

    entry.controller.abort();

    if (!this.closed) {
      void this.transport
        .send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } })
        .catch(() => undefined);
    }

    this.settle(id, undefined, new Error(`MCP request "${entry.method}" ${reason}`));
  }

  private settle(id: number, value: unknown, error: Error | undefined): void {
    const entry = this.pending.get(id);

    if (entry === undefined) {
      return;
    }

    this.pending.delete(id);
    clearTimeout(entry.timer);

    if (error !== undefined) {
      entry.reject(error);
    } else {
      entry.resolve(value);
    }
  }

  private failAll(error: Error): void {
    const ids = [...this.pending.keys()];

    for (const id of ids) {
      this.settle(id, undefined, error);
    }

    this.progressHandlers.clear();
  }

  private dispatch(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);

      if (!this.pending.has(id)) {
        return;
      }

      if ("error" in message) {
        const data = message.error.data !== undefined ? ` ${JSON.stringify(message.error.data).slice(0, 200)}` : "";
        this.settle(id, undefined, new Error(`MCP error ${message.error.code}: ${message.error.message}${data}`));
      } else {
        this.settle(id, message.result, undefined);
      }

      return;
    }

    if (isJsonRpcRequest(message)) {
      if (message.method === "ping") {
        void this.transport.send({ jsonrpc: "2.0", id: message.id, result: {} }).catch(() => undefined);
      } else {
        void this.transport
          .send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `method "${message.method}" is not supported by this client` },
          })
          .catch(() => undefined);
      }

      return;
    }

    if (isJsonRpcNotification(message)) {
      this.dispatchNotification(message);
    }
  }

  private dispatchNotification(message: { method: string; params?: Record<string, unknown> }): void {
    const params = isRecord(message.params) ? message.params : {};

    switch (message.method) {
      case "notifications/progress": {
        const token = params.progressToken;
        const id = typeof token === "number" ? token : Number(token);
        const handler = this.progressHandlers.get(id);

        if (handler !== undefined) {
          handler({
            progress: typeof params.progress === "number" ? params.progress : 0,
            total: typeof params.total === "number" ? params.total : null,
            message: typeof params.message === "string" ? params.message : null,
          });
        }

        return;
      }

      case "notifications/tools/list_changed":
        this.options.onListChanged?.("tools");
        return;

      case "notifications/prompts/list_changed":
        this.options.onListChanged?.("prompts");
        return;

      case "notifications/resources/list_changed":
        this.options.onListChanged?.("resources");
        return;

      default:
        return;
    }
  }
}
