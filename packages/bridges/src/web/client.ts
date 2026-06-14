export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PostResult {
  status: number;
  contentType: string;
  sessionId: string;
  body: string;
}

export class Endpoint {
  static build(endpoint: string): string {
    let url: URL;

    try {
      url = new URL(endpoint);
    } catch {
      url = new URL("https://search.parallel.ai/mcp");
    }

    return url.href;
  }
}

export class ArgPicker {
  static pick(props: ReadonlySet<string>, candidates: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(candidates)) {
      if (value === undefined) {
        continue;
      }

      if (props.size === 0 || props.has(key)) {
        args[key] = value;
      }
    }

    return args;
  }
}

export class MessageParser {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static parseSse(body: string): JsonRpcMessage[] {
    const messages: JsonRpcMessage[] = [];

    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (data === "") {
        continue;
      }

      try {
        const parsed: unknown = JSON.parse(data);

        if (MessageParser.isRecord(parsed)) {
          messages.push(parsed as unknown as JsonRpcMessage);
        }
      } catch {
        continue;
      }
    }

    return messages;
  }

  static parse(body: string, contentType: string): JsonRpcMessage[] {
    if (contentType.includes("text/event-stream")) {
      return MessageParser.parseSse(body);
    }

    if (body.trim() === "") {
      return [];
    }

    try {
      const parsed: unknown = JSON.parse(body);

      if (Array.isArray(parsed)) {
        return parsed.filter(MessageParser.isRecord) as unknown as JsonRpcMessage[];
      }

      if (MessageParser.isRecord(parsed)) {
        return [parsed as unknown as JsonRpcMessage];
      }
    } catch {
      return [];
    }

    return [];
  }

  static contentText(result: unknown): string {
    if (!MessageParser.isRecord(result) || !Array.isArray(result.content)) {
      return "";
    }

    const parts: string[] = [];

    for (const block of result.content) {
      if (MessageParser.isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }

    return parts.join("\n").trim();
  }
}

export class ParallelClient {
  private readonly endpoint: string;
  private sessionId = "";
  private ready = false;
  private nextId = 1;
  private readonly tools = new Map<string, Set<string>>();

  constructor(endpoint: string) {
    this.endpoint = endpoint;
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

  isReady(): boolean {
    return this.ready;
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

    if (this.sessionId !== "") {
      headers["mcp-session-id"] = this.sessionId;
    }

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

    if (sessionId !== "") {
      this.sessionId = sessionId;
    }

    const body = await response.text();

    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      sessionId,
      body,
    };
  }

  failure(status: number, body: string): Error {
    if (status === 401 || status === 403) {
      return new Error(`parallel mcp rejected the request with http ${status}; check the web.endpoint setting`);
    }

    if (status === 429) {
      return new Error("parallel mcp rate limit hit; retry later");
    }

    const detail = body.trim().slice(0, 300);

    return new Error(`parallel mcp request failed with http ${status}${detail !== "" ? `: ${detail}` : ""}`);
  }

  private async rpc(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const posted = await this.post({ jsonrpc: "2.0", id, method, params }, signal);

    if (posted.status === 404 && this.sessionId !== "") {
      this.reset();

      throw new Error("parallel mcp session expired; retry the request");
    }

    if (posted.status >= 400) {
      throw this.failure(posted.status, posted.body);
    }

    for (const message of MessageParser.parse(posted.body, posted.contentType)) {
      if (message.id !== id) {
        continue;
      }

      if (message.error !== undefined) {
        throw new Error(
          `parallel mcp ${method} failed: ${message.error.message ?? `code ${message.error.code ?? "unknown"}`}`,
        );
      }

      return message.result;
    }

    throw new Error(`parallel mcp ${method} returned no response for request ${id}`);
  }

  private async notify(method: string, signal: AbortSignal): Promise<void> {
    const posted = await this.post({ jsonrpc: "2.0", method }, signal);

    if (posted.status >= 400 && posted.status !== 404 && posted.status !== 405) {
      throw this.failure(posted.status, posted.body);
    }
  }

  async ensureReady(signal: AbortSignal): Promise<void> {
    if (this.ready) {
      return;
    }

    const initialized = await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pi-config-web", version: "1.0.0" },
      },
      signal,
    );

    if (!MessageParser.isRecord(initialized)) {
      throw new Error("parallel mcp initialize returned an invalid result");
    }

    await this.notify("notifications/initialized", signal);
    const listed = await this.rpc("tools/list", {}, signal);
    this.tools.clear();

    if (MessageParser.isRecord(listed) && Array.isArray(listed.tools)) {
      for (const tool of listed.tools) {
        if (!MessageParser.isRecord(tool) || typeof tool.name !== "string") {
          continue;
        }

        const props = new Set<string>();

        if (MessageParser.isRecord(tool.inputSchema) && MessageParser.isRecord(tool.inputSchema.properties)) {
          for (const key of Object.keys(tool.inputSchema.properties)) {
            props.add(key);
          }
        }

        this.tools.set(tool.name, props);
      }
    }

    if (this.tools.size === 0) {
      throw new Error("parallel mcp listed no tools; check the endpoint setting");
    }

    this.ready = true;
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    await this.ensureReady(signal);
    const result = await this.rpc("tools/call", { name, arguments: args }, signal);
    const text = MessageParser.contentText(result);
    const isError = MessageParser.isRecord(result) && result.isError === true;

    if (isError) {
      throw new Error(text !== "" ? text : `parallel mcp tool ${name} reported an error`);
    }

    if (text === "") {
      throw new Error(`parallel mcp tool ${name} returned no text content`);
    }

    return { text, isError: false };
  }

  async callWithRetry(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    try {
      return await this.call(name, args, signal);
    } catch (error) {
      if (signal.aborted || this.ready) {
        throw error;
      }

      this.reset();

      return await this.call(name, args, signal);
    }
  }
}
