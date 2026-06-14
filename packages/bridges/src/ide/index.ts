import * as http from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import contract, {
  BRIDGE_ENV_AUTH_TOKEN_KEY,
  BRIDGE_ENV_PORT_KEY,
  BRIDGE_HOST,
  BRIDGE_LEGACY_OPEN_DIFF_PATH,
  isRecord,
  parseDiagnosticsResponse,
  parseDiffApprovalResponse,
  parseEditorContext,
  type BridgeCloseDecision,
  type BridgeConnection,
  type DiagnosticsRequest,
  type DiagnosticsResponse,
  type DiffApprovalRequest,
  type DiffApprovalResponse,
  type EditorContext,
} from "./contract.ts";

const {
  BRIDGE_SHOW_DIFF_PATH,
  BRIDGE_CLOSE_DIFF_PATH,
  BRIDGE_HEALTH_PATH,
  BRIDGE_CONTEXT_STREAM_PATH,
  BRIDGE_DIAGNOSTICS_PATH,
  BRIDGE_REQUEST_DIFF_APPROVAL_PATH,
} = contract;

export const HTTP_TIMEOUT_MS = 5000;
export const LOCAL_PROBE_TIMEOUT_MS = 500;
export const CONNECTION_CACHE_TTL_MS = 20000;
export const NEGATIVE_CACHE_TTL_MS = 3000;
export const RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
export const REVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const SSE_EVENT_MAX_BYTES = 512 * 1024;
export const DIFF_PREVIEW_TIMEOUT_MS = 1000;
export const APPROVAL_TIMEOUT_MS = 600000;
export const RETRY_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10000, 30000];

export type ConnectionSource = "env" | "file" | "none";

export interface ResolveResult {
  connection: BridgeConnection | undefined;
  source: ConnectionSource;
  healthy: boolean;
  reason?: string;
}

export interface ConnectionRecord extends BridgeConnection {
  pid: number;
  ideName: string;
  workspaceFolders: string[];
  mtimeMs: number;
  path: string;
}

export interface ShowDiffPayload {
  filePath: string;
  beforeText: string;
  afterText: string;
  requestId: string;
}

export interface ConnectionStatus {
  type: "info";
  text: string;
}

export interface ThemeFg {
  fg?: (name: string, text: string) => string;
}

export interface ConnectionDebugInfo {
  connected: boolean;
  source: ConnectionSource;
  port?: number;
  reason?: string;
}

export interface ContextStreamHandle {
  disconnect: () => void;
}

interface HttpRequestOptions {
  host: string;
  port: number;
  path: string;
  method: string;
  headers?: Record<string, string | number>;
  body?: string;
  timeoutMs?: number;
  timeoutErrorMessage?: string;
  maxBytes?: number;
  signal?: AbortSignal;
}

export class BridgeRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeRequestTimeoutError";
  }
}

export class BridgeAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeAbortedError";
  }
}

export function readConnectionFromEnv(): BridgeConnection | undefined {
  const rawPort = process.env[BRIDGE_ENV_PORT_KEY];
  const authToken = process.env[BRIDGE_ENV_AUTH_TOKEN_KEY];
  const port = rawPort ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (!authToken) return undefined;

  return { port, authToken };
}

export function isAlive(pid: number): boolean {
  if (pid <= 0) return true;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function workspaceScore(workspaceFolders: string[], cwd: string): number {
  let best = -1;

  for (const folder of workspaceFolders) {
    const root = resolve(folder);
    if (cwd === root || cwd.startsWith(root + sep) || cwd.startsWith(root + "/")) best = Math.max(best, root.length);
  }

  return best;
}

export function retryBackoffMs(attempt: number): number {
  const index = Math.max(0, Math.min(attempt, RETRY_BACKOFF_MS.length - 1));
  return RETRY_BACKOFF_MS[index];
}

export function canReviewDiff(beforeText: string, afterText: string): boolean {
  return Buffer.byteLength(beforeText, "utf8") + Buffer.byteLength(afterText, "utf8") <= REVIEW_MAX_BYTES;
}

function makeHttpRequest(options: HttpRequestOptions): Promise<{ statusCode: number; data: Record<string, unknown> }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: options.host, port: options.port, path: options.path, method: options.method, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const maxBytes = options.maxBytes ?? RESPONSE_MAX_BYTES;

        res.on("data", (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buf.length;

          if (bytes > maxBytes) {
            req.destroy(new Error("bridge response too large"));
            return;
          }

          chunks.push(buf);
        });

        res.on("end", () => {
          try {
            const response = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
            const data = response ? JSON.parse(response) : {};
            resolvePromise({ statusCode: res.statusCode || 500, data: isRecord(data) ? data : {} });
          } catch (error) {
            rejectPromise(new Error(`invalid JSON response from bridge: ${String(error instanceof Error ? error.message : error)}`));
          }
        });
      },
    );

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      req.setTimeout(options.timeoutMs, () => req.destroy(new BridgeRequestTimeoutError(options.timeoutErrorMessage || "request timeout")));
    }

    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new BridgeAbortedError("bridge request aborted"));
        rejectPromise(new BridgeAbortedError("bridge request aborted"));
        return;
      }

      options.signal.addEventListener(
        "abort",
        () => req.destroy(new BridgeAbortedError("bridge request aborted")),
        { once: true },
      );
    }

    req.on("error", rejectPromise);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function postBridgeMessage(
  connection: BridgeConnection,
  pathName: string,
  message: Record<string, unknown>,
  timeoutMs = HTTP_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(message);
  const { data } = await makeHttpRequest({
    host: BRIDGE_HOST,
    port: connection.port,
    path: pathName,
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.authToken}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
    body,
    timeoutMs,
    timeoutErrorMessage: "bridge request timeout",
    signal,
  });

  return data;
}

async function pingBridgeHealth(connection: BridgeConnection): Promise<boolean> {
  try {
    const { statusCode } = await makeHttpRequest({
      host: BRIDGE_HOST,
      port: connection.port,
      path: BRIDGE_HEALTH_PATH,
      method: "GET",
      headers: { authorization: `Bearer ${connection.authToken}` },
      timeoutMs: LOCAL_PROBE_TIMEOUT_MS,
      timeoutErrorMessage: "bridge health timeout",
      maxBytes: 4096,
    });

    return statusCode >= 200 && statusCode < 300;
  } catch {
    return false;
  }
}

export async function discoverConnectionRecords(): Promise<ConnectionRecord[]> {
  const dir = join(homedir(), ".pi", "ide");
  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const records: ConnectionRecord[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const path = join(dir, entry);

    try {
      const [raw, meta] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) continue;

      const port = Number(parsed.port);
      const authToken = typeof parsed.authToken === "string" ? parsed.authToken : "";
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || !authToken) continue;

      const workspaceFolders = Array.isArray(parsed.workspaceFolders)
        ? parsed.workspaceFolders.filter((folder): folder is string => typeof folder === "string" && folder !== "")
        : [];

      records.push({
        port,
        authToken,
        pid: typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : 0,
        ideName: typeof parsed.ideName === "string" && parsed.ideName !== "" ? parsed.ideName : "VS Code",
        workspaceFolders,
        mtimeMs: meta.mtimeMs,
        path,
      });
    } catch {
      continue;
    }
  }

  return records.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function resolveViaConnectionFiles(cwd: string): Promise<BridgeConnection | undefined> {
  const records = (await discoverConnectionRecords()).filter((record) => isAlive(record.pid));
  if (records.length === 0) return undefined;

  const cwdResolved = resolve(cwd);
  let bestScore = -1;
  let best: ConnectionRecord[] = [];

  for (const record of records) {
    const score = workspaceScore(record.workspaceFolders, cwdResolved);

    if (score > bestScore) {
      bestScore = score;
      best = [record];
    } else if (score === bestScore) {
      best.push(record);
    }
  }

  if (bestScore >= 0 && best.length === 1) return best[0];
  if (records.length === 1) return records[0];

  return undefined;
}

export class BridgeClient {
  private cachedResult: ResolveResult | undefined;
  private cachedResultExpiresAt = 0;

  async sendShowDiff(payload: ShowDiffPayload): Promise<boolean> {
    const connection = await this.resolveConnection();
    if (!connection) return false;

    try {
      const response = await postBridgeMessage(connection, BRIDGE_SHOW_DIFF_PATH, payload as unknown as Record<string, unknown>, DIFF_PREVIEW_TIMEOUT_MS);
      if (response.ok !== false) return true;
      if (String(response.error || "") !== "not found") return false;
    } catch {
      return false;
    }

    return this.sendLegacyOpenDiff(connection, payload);
  }

  private async sendLegacyOpenDiff(connection: BridgeConnection, payload: ShowDiffPayload): Promise<boolean> {
    try {
      const response = await postBridgeMessage(connection, BRIDGE_LEGACY_OPEN_DIFF_PATH, payload as unknown as Record<string, unknown>, DIFF_PREVIEW_TIMEOUT_MS);
      return response.ok !== false;
    } catch (error) {
      return error instanceof BridgeRequestTimeoutError;
    }
  }

  async sendCloseDiff(requestId: string, decision: BridgeCloseDecision): Promise<void> {
    const connection = await this.resolveConnection();
    if (!connection) return;

    try {
      await postBridgeMessage(connection, BRIDGE_CLOSE_DIFF_PATH, { requestId, decision });
    } catch {
      return;
    }
  }

  async sendGetDiagnostics(params: DiagnosticsRequest): Promise<DiagnosticsResponse | undefined> {
    const connection = await this.resolveConnection();
    if (!connection) return undefined;

    try {
      const response = await postBridgeMessage(connection, BRIDGE_DIAGNOSTICS_PATH, params as Record<string, unknown>);
      return parseDiagnosticsResponse(response);
    } catch {
      return undefined;
    }
  }

  async requestDiffApproval(payload: DiffApprovalRequest, signal?: AbortSignal): Promise<DiffApprovalResponse | undefined> {
    const connection = await this.resolveConnection();
    if (!connection) return undefined;

    try {
      const response = await postBridgeMessage(connection, BRIDGE_REQUEST_DIFF_APPROVAL_PATH, payload as Record<string, unknown>, APPROVAL_TIMEOUT_MS, signal);
      return parseDiffApprovalResponse(response);
    } catch {
      return undefined;
    }
  }

  connectContextStream(onContext: (context: EditorContext) => void, onDisconnect: () => void): ContextStreamHandle {
    let closed = false;
    let disconnected = false;
    let req: http.ClientRequest | undefined;

    const notifyDisconnect = (): void => {
      if (closed || disconnected) return;
      disconnected = true;
      onDisconnect();
    };

    const start = async (): Promise<void> => {
      const connection = await this.resolveConnection();
      if (!connection) {
        notifyDisconnect();
        return;
      }

      req = http.request(
        {
          host: BRIDGE_HOST,
          port: connection.port,
          path: BRIDGE_CONTEXT_STREAM_PATH,
          method: "GET",
          headers: {
            authorization: `Bearer ${connection.authToken}`,
            accept: "text/event-stream",
          },
        },
        (res) => {
          if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
            res.resume();
            notifyDisconnect();
            return;
          }

          let buffer = "";

          res.on("data", (chunk) => {
            if (closed) return;
            buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);

            if (Buffer.byteLength(buffer, "utf8") > SSE_EVENT_MAX_BYTES) {
              req?.destroy(new Error("IDE context event too large"));
              notifyDisconnect();
              return;
            }

            buffer = buffer.replace(/\r\n/g, "\n");

            let boundary = buffer.indexOf("\n\n");

            while (boundary !== -1) {
              const eventChunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const dataLines = eventChunk
                .split("\n")
                .map((line) => line.trimEnd())
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart());

              if (dataLines.length > 0) {
                const context = parseEditorContext(dataLines.join("\n"));
                if (context) onContext(context);
              }

              boundary = buffer.indexOf("\n\n");
            }
          });

          res.on("error", notifyDisconnect);
          res.on("close", notifyDisconnect);
        },
      );

      req.on("error", notifyDisconnect);
      req.end();
    };

    void start().catch(notifyDisconnect);

    return {
      disconnect: (): void => {
        closed = true;
        req?.destroy();
      },
    };
  }

  async getIdeConnectionStatus(theme?: ThemeFg): Promise<ConnectionStatus> {
    const diag = await this.getIdeConnectionDiagnostics();
    if (!diag.connected) {
      return { type: "info", text: `${this.colorDot(theme, false)} disconnected from IDE: ${diag.reason}. Run /ide install, then reload VS Code.` };
    }

    return { type: "info", text: `${this.colorDot(theme, true)} ${this.colorAccent(theme, "connected to IDE")}` };
  }

  async isIdeConnected(): Promise<boolean> {
    const diag = await this.getIdeConnectionDiagnostics();
    return diag.connected;
  }

  async getIdeConnectionDebugInfo(): Promise<ConnectionDebugInfo> {
    const resolved = await this.resolveDetailed();
    if (!resolved.connection) {
      return { connected: false, source: "none", reason: resolved.reason || "No bridge connection info available from VS Code environment variables or ~/.pi/ide" };
    }

    if (!resolved.healthy) {
      return { connected: false, source: resolved.source, port: resolved.connection.port, reason: "Bridge health check failed" };
    }

    return { connected: true, source: resolved.source, port: resolved.connection.port };
  }

  private async getIdeConnectionDiagnostics(): Promise<{ connected: boolean; reason: string }> {
    const debug = await this.getIdeConnectionDebugInfo();
    if (!debug.connected) return { connected: false, reason: String(debug.reason || "Disconnected") };
    return { connected: true, reason: "" };
  }

  private async resolveConnection(): Promise<BridgeConnection | undefined> {
    const resolved = await this.resolveDetailed();
    return resolved.connection;
  }

  private async resolveDetailed(): Promise<ResolveResult> {
    if (this.cachedResult && this.cachedResultExpiresAt > Date.now()) return this.cachedResult;

    const envConnection = readConnectionFromEnv();
    if (envConnection && await pingBridgeHealth(envConnection)) {
      return this.cacheResult({ connection: envConnection, source: "env", healthy: true }, CONNECTION_CACHE_TTL_MS);
    }

    const fileConnection = await resolveViaConnectionFiles(process.cwd());
    if (fileConnection && await pingBridgeHealth(fileConnection)) {
      return this.cacheResult({ connection: fileConnection, source: "file", healthy: true }, CONNECTION_CACHE_TTL_MS);
    }

    return this.cacheResult(
      { connection: undefined, source: "none", healthy: false, reason: "No matching pi-config VS Code bridge found" },
      NEGATIVE_CACHE_TTL_MS,
    );
  }

  private cacheResult(result: ResolveResult, ttlMs: number): ResolveResult {
    this.cachedResult = result;
    this.cachedResultExpiresAt = Date.now() + ttlMs;
    return result;
  }

  private colorAccent(theme: ThemeFg | undefined, text: string): string {
    if (!theme?.fg) return text;
    return theme.fg("accent", text);
  }

  private colorDot(theme: ThemeFg | undefined, connected: boolean): string {
    if (!theme?.fg) return "●";
    return connected ? theme.fg("success", "●") : theme.fg("error", "●");
  }
}
