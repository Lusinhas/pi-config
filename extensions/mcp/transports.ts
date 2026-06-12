import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: JsonRpcErrorShape;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !("method" in message);
}

export class UnauthorizedError extends Error {
  readonly wwwAuthenticate: string | null;

  constructor(message: string, wwwAuthenticate: string | null) {
    super(message);
    this.name = "UnauthorizedError";
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export interface Transport {
  readonly kind: "stdio" | "http";
  readonly serverPush: boolean;
  start(): Promise<void>;
  send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void>;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose(handler: (reason: string) => void): void;
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function coerceJsonRpc(value: unknown): JsonRpcMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") return null;
  const id = record.id;
  const hasId = typeof id === "number" || typeof id === "string" || id === null;
  if (typeof record.method === "string") {
    const params =
      typeof record.params === "object" && record.params !== null && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : undefined;
    if (hasId && id !== null) {
      const request: JsonRpcRequest = { jsonrpc: "2.0", id: id as number | string, method: record.method };
      if (params !== undefined) request.params = params;
      return request;
    }
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method: record.method };
    if (params !== undefined) notification.params = params;
    return notification;
  }
  if (hasId && ("result" in record || "error" in record)) {
    if (typeof record.error === "object" && record.error !== null && !Array.isArray(record.error)) {
      const errorRecord = record.error as Record<string, unknown>;
      return {
        jsonrpc: "2.0",
        id: id as number | string | null,
        error: {
          code: typeof errorRecord.code === "number" ? errorRecord.code : 0,
          message: typeof errorRecord.message === "string" ? errorRecord.message : "unknown error",
          data: errorRecord.data,
        },
      };
    }
    return { jsonrpc: "2.0", id: id as number | string | null, result: record.result };
  }
  return null;
}

export function parseJsonRpc(text: string): JsonRpcMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return coerceJsonRpc(parsed);
}

const MAX_BUFFER_BYTES = 33554432;
const HEADER_PATTERN = /^content-(length|type):/i;
const CONTENT_LENGTH_PATTERN = /content-length:\s*(\d+)/i;

export interface StdioTransportOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  framing: "ndjson" | "lsp";
  stderrLines: number;
}

export class StdioTransport implements Transport {
  readonly kind = "stdio" as const;
  readonly serverPush = true;
  private readonly options: StdioTransportOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private framed: boolean;
  private closed = false;
  private stderrTail: string[] = [];
  private readonly messageHandlers: ((message: JsonRpcMessage) => void)[] = [];
  private readonly closeHandlers: ((reason: string) => void)[] = [];

  constructor(options: StdioTransportOptions) {
    this.options = options;
    this.framed = options.framing === "lsp";
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  setProtocolVersion(): void {
    return;
  }

  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      Object.assign(env, this.options.env);
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.options.command, this.options.args, { env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(new Error(`failed to spawn "${this.options.command}": ${describeError(error)}`));
        return;
      }
      this.child = child;
      let settled = false;
      child.once("error", (error: Error) => {
        if (!settled) {
          settled = true;
          this.child = null;
          reject(new Error(`failed to spawn "${this.options.command}": ${error.message}`));
          return;
        }
        this.fireClose(`process error: ${error.message}`);
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
      child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
      child.once("exit", (code, signal) => {
        this.child = null;
        const stderrNote = this.stderrTail.length > 0 ? `; stderr: ${this.stderrTail.join(" | ")}` : "";
        const reason =
          signal !== null ? `killed by ${signal}${stderrNote}` : `exited with code ${code ?? 0}${stderrNote}`;
        if (!settled) {
          settled = true;
          reject(new Error(`MCP server process ${reason}`.slice(0, 500)));
          return;
        }
        this.fireClose(reason);
      });
    });
  }

  send(message: JsonRpcMessage, _signal?: AbortSignal): Promise<void> {
    const child = this.child;
    if (this.closed || child === null || child.stdin.destroyed) {
      return Promise.reject(new Error("stdio transport is not connected"));
    }
    const json = JSON.stringify(message);
    const payload = this.framed
      ? `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`
      : `${json}\n`;
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(payload, (error) => {
        if (error) reject(new Error(`failed to write to MCP server: ${error.message}`));
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          return;
        }
      }, 2000);
      if (typeof killTimer.unref === "function") killTimer.unref();
      const giveUp = setTimeout(() => resolve(), 4000);
      if (typeof giveUp.unref === "function") giveUp.unref();
      child.once("exit", () => {
        clearTimeout(killTimer);
        clearTimeout(giveUp);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        void 0;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        void 0;
      }
    });
  }

  private fireClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const trimmed = reason.slice(0, 500);
    for (const handler of this.closeHandlers) {
      try {
        handler(trimmed);
      } catch {
        continue;
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    const lines = chunk
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0) return;
    this.stderrTail = [...this.stderrTail, ...lines].slice(-this.options.stderrLines);
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.fireClose("incoming message exceeded the 32MB buffer limit");
      void this.close();
      return;
    }
    this.drain();
  }

  private drain(): void {
    while (this.buffer.length > 0) {
      const head = this.buffer.subarray(0, Math.min(this.buffer.length, 64)).toString("latin1");
      if (HEADER_PATTERN.test(head)) {
        const separator = this.buffer.indexOf("\r\n\r\n");
        if (separator === -1) return;
        const header = this.buffer.subarray(0, separator).toString("latin1");
        const match = CONTENT_LENGTH_PATTERN.exec(header);
        if (match === null) {
          this.buffer = this.buffer.subarray(separator + 4);
          continue;
        }
        const length = Number.parseInt(match[1], 10);
        const total = separator + 4 + length;
        if (this.buffer.length < total) return;
        const body = this.buffer.subarray(separator + 4, total).toString("utf8");
        this.buffer = this.buffer.subarray(total);
        this.framed = true;
        this.emitJson(body);
        continue;
      }
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line !== "") this.emitJson(line);
    }
  }

  private emitJson(text: string): void {
    const message = parseJsonRpc(text);
    if (message === null) return;
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch {
        continue;
      }
    }
  }
}

export interface HttpTransportOptions {
  url: string;
  headers: Record<string, string>;
  requestTimeoutMs: number;
  getAuthorization: () => Promise<string | null>;
}

export class HttpTransport implements Transport {
  readonly kind = "http" as const;
  readonly serverPush = false;
  private readonly options: HttpTransportOptions;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private closed = false;
  private readonly messageHandlers: ((message: JsonRpcMessage) => void)[] = [];
  private readonly closeHandlers: ((reason: string) => void)[] = [];

  constructor(options: HttpTransportOptions) {
    this.options = options;
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  private emit(message: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch {
        continue;
      }
    }
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async start(): Promise<void> {
    try {
      void new URL(this.options.url);
    } catch {
      throw new Error(`invalid MCP server URL "${this.options.url}"`);
    }
  }

  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("http transport is closed");
    if (signal?.aborted) throw new Error("request aborted before send");
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let headerTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs,
    );
    if (typeof headerTimer.unref === "function") headerTimer.unref();
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.options.headers,
      };
      if (this.protocolVersion !== null) headers["mcp-protocol-version"] = this.protocolVersion;
      if (this.sessionId !== null) headers["mcp-session-id"] = this.sessionId;
      const authorization = await this.options.getAuthorization();
      if (authorization !== null && headers.authorization === undefined && headers.Authorization === undefined) {
        headers.authorization = authorization;
      }
      const hadSession = this.sessionId !== null;
      let response: Response;
      try {
        response = await fetch(this.options.url, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted && !(signal?.aborted ?? false)) {
          throw new Error(`MCP request to ${this.options.url} timed out after ${this.options.requestTimeoutMs}ms`);
        }
        throw new Error(`MCP request to ${this.options.url} failed: ${describeError(error)}`);
      }
      clearTimeout(headerTimer);
      headerTimer = null;
      const newSession = response.headers.get("mcp-session-id");
      if (newSession !== null && newSession !== "") this.sessionId = newSession;
      if (response.status === 401 || response.status === 403) {
        const wwwAuthenticate = response.headers.get("www-authenticate");
        await response.text().catch(() => "");
        throw new UnauthorizedError(
          `MCP server ${this.options.url} rejected the request with HTTP ${response.status}`,
          wwwAuthenticate,
        );
      }
      if (response.status === 404 && hadSession) {
        this.sessionId = null;
        await response.text().catch(() => "");
        throw new Error("MCP session expired (HTTP 404); restart the server with /mcp restart");
      }
      if (response.status === 202 || response.status === 204) {
        await response.text().catch(() => "");
        return;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const snippet = body.trim() === "" ? "" : `: ${body.slice(0, 300)}`;
        throw new Error(`MCP server returned HTTP ${response.status}${snippet}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        if (response.body !== null) await this.readSse(response.body, controller.signal);
        return;
      }
      const text = await response.text();
      if (text.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`MCP server returned invalid JSON: ${text.slice(0, 200)}`);
      }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const coerced = coerceJsonRpc(item);
        if (coerced !== null) this.emit(coerced);
      }
    } finally {
      if (headerTimer !== null) clearTimeout(headerTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) {
      try {
        handler("transport closed");
      } catch {
        continue;
      }
    }
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (sessionId === null) return;
    try {
      const headers: Record<string, string> = { ...this.options.headers, "mcp-session-id": sessionId };
      if (this.protocolVersion !== null) headers["mcp-protocol-version"] = this.protocolVersion;
      const authorization = await this.options.getAuthorization();
      if (authorization !== null) headers.authorization = authorization;
      await fetch(this.options.url, { method: "DELETE", headers, signal: AbortSignal.timeout(3000) });
    } catch {
      return;
    }
  }

  private async readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    const flush = (): void => {
      if (data.length === 0) return;
      const message = parseJsonRpc(data.join("\n"));
      data = [];
      if (message !== null) this.emit(message);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (line === "") flush();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          index = buffer.indexOf("\n");
        }
      }
      flush();
    } catch (error) {
      if (signal.aborted) return;
      throw new Error(`MCP event stream failed: ${describeError(error)}`);
    }
  }
}
