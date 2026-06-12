import type { IdeLock } from "./discovery.ts";
import { wsConnect, type WsConnection } from "./ws.ts";

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface BridgeOptions {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onClose: (reason: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class IdeBridge {
  readonly ideName: string;
  readonly port: number;
  #ws: WsConnection | undefined;
  #options: BridgeOptions;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #tools: string[] = [];
  #closed = false;

  private constructor(lock: IdeLock, options: BridgeOptions) {
    this.ideName = lock.ideName;
    this.port = lock.port;
    this.#options = options;
  }

  static async connect(lock: IdeLock, options: BridgeOptions): Promise<IdeBridge> {
    const bridge = new IdeBridge(lock, options);
    const headers: Record<string, string> = {};
    if (lock.authToken !== "") headers["x-claude-code-ide-authorization"] = lock.authToken;
    bridge.#ws = await wsConnect("127.0.0.1", lock.port, headers, options.connectTimeoutMs, {
      onMessage: (text) => bridge.#handleMessage(text),
      onClose: (reason) => bridge.#handleClose(reason),
    });
    try {
      await bridge.#request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-config", version: "1.0.0" },
      });
      bridge.#send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      const listed = await bridge.#request("tools/list", {});
      if (isRecord(listed) && Array.isArray(listed.tools)) {
        bridge.#tools = listed.tools
          .map((tool) => (isRecord(tool) && typeof tool.name === "string" ? tool.name : ""))
          .filter((name) => name !== "");
      }
    } catch (error) {
      bridge.close();
      throw error;
    }
    return bridge;
  }

  get closed(): boolean {
    return this.#closed;
  }

  toolNames(): string[] {
    return [...this.#tools];
  }

  hasTool(name: string): boolean {
    return this.#tools.includes(name);
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolCallResult> {
    const result = await this.#request("tools/call", { name, arguments: args }, timeoutMs);
    if (!isRecord(result)) return { text: "", isError: false };
    const parts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const part of result.content) {
        if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
      }
    }
    return { text: parts.join("\n"), isError: result.isError === true };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error("connection closed"));
    try {
      this.#ws?.close();
    } catch {
      return;
    }
  }

  #send(message: Record<string, unknown>): void {
    if (this.#ws === undefined) throw new Error("not connected");
    this.#ws.send(JSON.stringify(message));
  }

  #request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("connection closed"));
    const id = this.#nextId++;
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const limit = timeoutMs ?? this.#options.requestTimeoutMs;
      const timer =
        limit > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              rejectPromise(new Error(`${method} timed out after ${limit}ms`));
            }, limit)
          : undefined;
      timer?.unref?.();
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        this.#pending.delete(id);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isRecord(message)) continue;
      const id = typeof message.id === "number" ? message.id : undefined;
      const method = typeof message.method === "string" ? message.method : undefined;
      if (method !== undefined && (id !== undefined || typeof message.id === "string")) {
        const requestId = id ?? (message.id as string);
        if (method === "ping") {
          try {
            this.#send({ jsonrpc: "2.0", id: requestId, result: {} });
          } catch {
            return;
          }
        } else {
          try {
            this.#send({ jsonrpc: "2.0", id: requestId, error: { code: -32601, message: `method not supported: ${method}` } });
          } catch {
            return;
          }
        }
        continue;
      }
      if (id !== undefined) {
        const pending = this.#pending.get(id);
        if (pending === undefined) continue;
        this.#pending.delete(id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        if (isRecord(message.error)) {
          const detail = typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error);
          pending.reject(new Error(detail));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (method !== undefined) {
        try {
          this.#options.onNotification(method, isRecord(message.params) ? message.params : {});
        } catch {
          continue;
        }
      }
    }
  }

  #handleClose(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error(`connection closed (${reason})`));
    this.#options.onClose(reason);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
