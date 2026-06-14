export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_ENV_PORT_KEY = "PI_IDE_BRIDGE_SERVER_PORT";
export const BRIDGE_ENV_AUTH_TOKEN_KEY = "PI_IDE_BRIDGE_AUTH_TOKEN";
export const BRIDGE_SHOW_DIFF_PATH = "/showDiff";
export const BRIDGE_CLOSE_DIFF_PATH = "/closeDiff";
export const BRIDGE_HEALTH_PATH = "/health";
export const BRIDGE_CONTEXT_STREAM_PATH = "/context/stream";
export const BRIDGE_DIAGNOSTICS_PATH = "/diagnostics";
export const BRIDGE_REQUEST_DIFF_APPROVAL_PATH = "/requestDiffApproval";
export const BRIDGE_LEGACY_OPEN_DIFF_PATH = "/openDiff";

const contract = {
  BRIDGE_HOST,
  BRIDGE_ENV_PORT_KEY,
  BRIDGE_ENV_AUTH_TOKEN_KEY,
  BRIDGE_SHOW_DIFF_PATH,
  BRIDGE_CLOSE_DIFF_PATH,
  BRIDGE_HEALTH_PATH,
  BRIDGE_CONTEXT_STREAM_PATH,
  BRIDGE_DIAGNOSTICS_PATH,
  BRIDGE_REQUEST_DIFF_APPROVAL_PATH,
} as const;

export default contract;

export type BridgeCloseDecision = "closed_by_pi";
export type DiagnosticsScope = "active" | "all" | "file";

export interface BridgeConnection {
  port: number;
  authToken: string;
}

export interface OpenFile {
  path: string;
  timestamp: number;
  isActive?: boolean;
  selectedText?: string;
  cursor?: { line: number; character: number };
}

export interface EditorContext {
  openFiles: OpenFile[];
  isTrusted: boolean;
}

export interface DiagnosticsRequest {
  scope?: DiagnosticsScope;
  filePath?: string;
}

export interface DiagnosticEntry {
  severity: "error" | "warning";
  message: string;
  line: number;
  character: number;
  source?: string;
  code?: string;
}

export interface FileDiagnostics {
  path: string;
  diagnostics: DiagnosticEntry[];
}

export interface DiagnosticsResponse {
  files: FileDiagnostics[];
  totalErrors: number;
  totalWarnings: number;
}

export interface DiffApprovalRequest {
  filePath: string;
  beforeText: string;
  afterText: string;
  requestId: string;
}

export interface DiffApprovalResponse {
  decision: "accept" | "reject";
  content: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEditorContext(raw: string): EditorContext | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return undefined;

    const openFiles = Array.isArray(parsed.openFiles) ? parsed.openFiles : [];

    return {
      isTrusted: parsed.isTrusted === true,
      openFiles: openFiles.flatMap((file) => {
        if (!isRecord(file) || typeof file.path !== "string") return [];

        const cursor = isRecord(file.cursor) && typeof file.cursor.line === "number" && typeof file.cursor.character === "number"
          ? { line: file.cursor.line, character: file.cursor.character }
          : undefined;

        return [{
          path: file.path,
          timestamp: typeof file.timestamp === "number" ? file.timestamp : 0,
          isActive: file.isActive === true,
          selectedText: typeof file.selectedText === "string" ? file.selectedText : undefined,
          cursor,
        }];
      }),
    };
  } catch {
    return undefined;
  }
}

export function parseDiagnosticsResponse(response: Record<string, unknown>): DiagnosticsResponse | undefined {
  if (response.ok === false || !Array.isArray(response.files)) return undefined;

  const files: FileDiagnostics[] = response.files.flatMap((file) => {
    if (!isRecord(file) || typeof file.path !== "string" || !Array.isArray(file.diagnostics)) return [];

    const diagnostics: DiagnosticEntry[] = file.diagnostics.flatMap((diagnostic) => {
      if (!isRecord(diagnostic)) return [];

      const severity = diagnostic.severity === "error" || diagnostic.severity === "warning" ? diagnostic.severity : undefined;
      const message = typeof diagnostic.message === "string" ? diagnostic.message : undefined;
      const line = typeof diagnostic.line === "number" && Number.isFinite(diagnostic.line) ? diagnostic.line : undefined;
      const character = typeof diagnostic.character === "number" && Number.isFinite(diagnostic.character) ? diagnostic.character : undefined;
      if (!severity || message === undefined || line === undefined || character === undefined) return [];

      return [{
        severity,
        message,
        line,
        character,
        source: typeof diagnostic.source === "string" ? diagnostic.source : undefined,
        code: typeof diagnostic.code === "string" ? diagnostic.code : undefined,
      }];
    });

    return [{ path: file.path, diagnostics }];
  });

  const totalErrors = typeof response.totalErrors === "number"
    ? response.totalErrors
    : files.reduce((count, file) => count + file.diagnostics.filter((d) => d.severity === "error").length, 0);
  const totalWarnings = typeof response.totalWarnings === "number"
    ? response.totalWarnings
    : files.reduce((count, file) => count + file.diagnostics.filter((d) => d.severity === "warning").length, 0);

  return { files, totalErrors, totalWarnings };
}

export function parseDiffApprovalResponse(value: unknown): DiffApprovalResponse | undefined {
  if (!isRecord(value)) return undefined;

  const decision = value.decision === "accept" || value.decision === "reject" ? value.decision : undefined;
  if (decision === undefined || typeof value.content !== "string") return undefined;

  return { decision, content: value.content };
}
