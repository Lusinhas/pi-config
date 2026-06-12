interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

interface PostResult {
  status: number;
  contentType: string;
  sessionId: string;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveApiKey(configured: string): string {
  const fromEnv = process.env.EXA_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return configured.trim();
}

export function buildEndpoint(endpoint: string, tools: string[]): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    url = new URL("https://mcp.exa.ai/mcp");
  }
  if (tools.length > 0 && !url.searchParams.has("tools")) {
    url.searchParams.set("tools", tools.join(","));
  }
  return url.href;
}

export function pickArgs(props: ReadonlySet<string>, candidates: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidates)) {
    if (value === undefined) continue;
    if (props.size === 0 || props.has(key)) args[key] = value;
  }
  return args;
}

function parseSseMessages(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data === "") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed)) messages.push(parsed as unknown as JsonRpcMessage);
    } catch {
      continue;
    }
  }
  return messages;
}

function parseMessages(body: string, contentType: string): JsonRpcMessage[] {
  if (contentType.includes("text/event-stream")) return parseSseMessages(body);
  if (body.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed.filter(isRecord) as unknown as JsonRpcMessage[];
    if (isRecord(parsed)) return [parsed as unknown as JsonRpcMessage];
  } catch {
    return [];
  }
  return [];
}

function contentText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  const parts: string[] = [];
  for (const block of result.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

export class ExaClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private sessionId = "";
  private ready = false;
  private nextId = 1;
  private readonly tools = new Map<string, Set<string>>();

  constructor(endpoint: string, apiKey: string) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  toolProps(name: string): ReadonlySet<string> {
    return this.tools.get(name) ?? new Set<string>();
  }

  reset(): void {
    this.ready = false;
    this.sessionId = "";
    this.tools.clear();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    };
    if (this.apiKey !== "") headers["x-api-key"] = this.apiKey;
    if (this.sessionId !== "") headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async post(payload: unknown, signal: AbortSignal): Promise<PostResult> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal,
    });
    const sessionId = response.headers.get("mcp-session-id") ?? "";
    if (sessionId !== "") this.sessionId = sessionId;
    const body = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      sessionId,
      body,
    };
  }

  private failure(status: number, body: string): Error {
    if (status === 401 || status === 403) {
      return new Error(
        "exa mcp rejected the api key; set EXA_API_KEY or web.apiKey in ~/.pi/agent/piconfig.json (keys: https://dashboard.exa.ai/api-keys)"
      );
    }
    if (status === 429) {
      return new Error(
        "exa mcp rate limit hit; set EXA_API_KEY or web.apiKey in ~/.pi/agent/piconfig.json to lift free-tier limits, or retry later"
      );
    }
    const detail = body.trim().slice(0, 300);
    return new Error(`exa mcp request failed with http ${status}${detail !== "" ? `: ${detail}` : ""}`);
  }

  private async rpc(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const posted = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    if (posted.status === 404 && this.sessionId !== "") {
      this.reset();
      throw new Error("exa mcp session expired; retry the request");
    }
    if (posted.status >= 400) throw this.failure(posted.status, posted.body);
    for (const message of parseMessages(posted.body, posted.contentType)) {
      if (message.id !== id) continue;
      if (message.error !== undefined) {
        throw new Error(`exa mcp ${method} failed: ${message.error.message ?? `code ${message.error.code ?? "unknown"}`}`);
      }
      return message.result;
    }
    throw new Error(`exa mcp ${method} returned no response for request ${id}`);
  }

  private async notify(method: string, signal: AbortSignal): Promise<void> {
    const posted = await this.post({ jsonrpc: "2.0", method }, signal);
    if (posted.status >= 400 && posted.status !== 404 && posted.status !== 405) {
      throw this.failure(posted.status, posted.body);
    }
  }

  async ensureReady(signal: AbortSignal): Promise<void> {
    if (this.ready) return;
    const initialized = await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pi-config-web", version: "1.0.0" },
      },
      signal
    );
    if (!isRecord(initialized)) throw new Error("exa mcp initialize returned an invalid result");
    await this.notify("notifications/initialized", signal);
    const listed = await this.rpc("tools/list", {}, signal);
    this.tools.clear();
    if (isRecord(listed) && Array.isArray(listed.tools)) {
      for (const tool of listed.tools) {
        if (!isRecord(tool) || typeof tool.name !== "string") continue;
        const props = new Set<string>();
        if (isRecord(tool.inputSchema) && isRecord(tool.inputSchema.properties)) {
          for (const key of Object.keys(tool.inputSchema.properties)) props.add(key);
        }
        this.tools.set(tool.name, props);
      }
    }
    if (this.tools.size === 0) throw new Error("exa mcp listed no tools; check the endpoint and tools filter");
    this.ready = true;
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    await this.ensureReady(signal);
    const result = await this.rpc("tools/call", { name, arguments: args }, signal);
    const text = contentText(result);
    const isError = isRecord(result) && result.isError === true;
    if (isError) throw new Error(text !== "" ? text : `exa mcp tool ${name} reported an error`);
    if (text === "") throw new Error(`exa mcp tool ${name} returned no text content`);
    return { text, isError: false };
  }

  async callWithRetry(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    try {
      return await this.call(name, args, signal);
    } catch (error) {
      if (signal.aborted || this.ready) throw error;
      this.reset();
      return await this.call(name, args, signal);
    }
  }
}
