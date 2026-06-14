import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parsePromptArguments,
  type McpPromptArgDef,
  type McpPromptDef,
  type McpToolDef,
} from "./client.ts";

export type Framing = "ndjson" | "lsp";

export interface StdioServerSpec {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  framing: Framing;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

export function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const out: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      out[key] = String(entry);
    }
  }

  return out;
}

export function sanitize(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, "");

  return cleaned === "" ? "x" : cleaned;
}

export function parseServerSpec(
  name: string,
  raw: unknown,
  defaultLazy: boolean,
  source: string,
  defaultFraming: Framing,
): ServerSpec | null {
  if (!isRecord(raw) || name.trim() === "") {
    return null;
  }

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

export function readMcpJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

    if (!isRecord(parsed)) {
      return {};
    }

    return isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

export function collectServerSpecs(
  configServers: Record<string, unknown>,
  defaultFraming: Framing,
  cwd: string,
  defaultLazy: boolean,
): ServerSpec[] {
  const merged = new Map<string, ServerSpec>();

  const add = (name: string, raw: unknown, source: string): void => {
    const spec = parseServerSpec(name, raw, defaultLazy, source, defaultFraming);

    if (spec !== null) {
      merged.set(name, spec);
    }
  };

  for (const [name, raw] of Object.entries(configServers)) {
    add(name, raw, "config");
  }

  for (const [name, raw] of Object.entries(readMcpJson(join(homedir(), ".pi", "agent", ".mcp.json")))) {
    add(name, raw, "global .mcp.json");
  }

  for (const [name, raw] of Object.entries(readMcpJson(join(cwd, ".mcp.json")))) {
    add(name, raw, "project .mcp.json");
  }

  return [...merged.values()];
}

export class Policy {
  static toolAllowed(spec: ServerSpec, name: string): boolean {
    if (spec.deny.includes(name)) {
      return false;
    }

    if (spec.allow !== null) {
      return spec.allow.includes(name);
    }

    return true;
  }
}

export function parsePromptArgs(input: string, defs: McpPromptArgDef[]): Record<string, string> {
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

    if (free !== undefined) {
      out[free.name] = leftovers.join(" ");
    }
  }

  return out;
}

export function missingRequired(defs: McpPromptArgDef[], parsed: Record<string, string>): string[] {
  return defs.filter((arg) => arg.required && parsed[arg.name] === undefined).map((arg) => arg.name);
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncationResult {
  content: string;
  truncated?: boolean;
  totalLines: number;
  totalBytes: number;
  outputLines?: number;
  outputBytes?: number;
  lastLinePartial?: boolean;
}

export type TruncateFn = (text: string, options: TruncationOptions) => TruncationResult;

const DEFAULT_MAX_LINES = 3000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const NL = "\n";

function countNewlines(text: string): number {
  let count = 0;
  let pos = text.indexOf(NL);

  while (pos !== -1) {
    count += 1;
    pos = text.indexOf(NL, pos + 1);
  }

  return count;
}

function findBoundaryForward(buf: Buffer, pos: number): number {
  let i = Math.max(0, pos);

  while (i < buf.length && (buf[i] & 0xc0) === 0x80) {
    i += 1;
  }

  return i;
}

function tailBytes(data: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes === 0) {
    return { text: "", bytes: 0 };
  }

  if (data.length <= maxBytes) {
    const len = Buffer.byteLength(data, "utf8");

    if (len <= maxBytes) {
      return { text: data, bytes: len };
    }
  }

  const window = data.substring(Math.max(0, data.length - maxBytes));
  const buf = Buffer.from(window, "utf8");
  const startAt = Math.max(0, buf.length - maxBytes);
  const start = findBoundaryForward(buf, startAt);
  const slice = buf.subarray(start);

  return { text: slice.toString("utf8"), bytes: slice.length };
}

export class TailTruncator {
  truncate(content: string, options: TruncationOptions = {}): TruncationResult {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const totalBytes = Buffer.byteLength(content, "utf8");
    const totalLines = countNewlines(content) + 1;

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
      return { content, totalLines, totalBytes };
    }

    let includedLines = 0;
    let bytesUsed = 0;
    let startIndex = content.length;
    let end = content.length;

    while (includedLines < maxLines) {
      const nl = content.lastIndexOf(NL, end - 1);
      const lineStart = nl === -1 ? 0 : nl + 1;
      const sepBytes = includedLines > 0 ? 1 : 0;
      const remaining = maxBytes - bytesUsed - sepBytes;

      if (remaining < 0) {
        break;
      }

      const lineCodeUnits = end - lineStart;

      if (lineCodeUnits > remaining) {
        if (includedLines === 0) {
          const windowStart = Math.max(lineStart, end - maxBytes);
          const window = content.substring(windowStart, end);
          const tail = tailBytes(window, maxBytes);

          return {
            content: tail.text,
            truncated: true,
            totalLines,
            totalBytes,
            outputLines: 1,
            outputBytes: tail.bytes,
            lastLinePartial: true,
          };
        }

        break;
      }

      const lineText = content.slice(lineStart, end);
      const lineBytes = Buffer.byteLength(lineText, "utf8");

      if (lineBytes > remaining) {
        if (includedLines === 0) {
          const tail = tailBytes(lineText, maxBytes);

          return {
            content: tail.text,
            truncated: true,
            totalLines,
            totalBytes,
            outputLines: 1,
            outputBytes: tail.bytes,
            lastLinePartial: true,
          };
        }

        break;
      }

      bytesUsed += sepBytes + lineBytes;
      includedLines += 1;
      startIndex = lineStart;

      if (nl === -1) {
        break;
      }

      end = nl;
    }

    return {
      content: content.slice(startIndex),
      truncated: true,
      totalLines,
      totalBytes,
      outputLines: includedLines,
      outputBytes: bytesUsed,
      lastLinePartial: false,
    };
  }
}

export interface CachedLists {
  tools: McpToolDef[];
  prompts: McpPromptDef[];
  resourceCount: number;
}

export function specHash(spec: ServerSpec): string {
  const identity =
    spec.kind === "stdio"
      ? {
          kind: spec.kind,
          command: spec.command,
          args: spec.args,
          env: spec.env,
          framing: spec.framing,
          allow: spec.allow,
          deny: spec.deny,
        }
      : { kind: spec.kind, url: spec.url, headers: spec.headers, allow: spec.allow, deny: spec.deny };

  return createHash("sha1").update(JSON.stringify(identity)).digest("hex").slice(0, 12);
}

export function safeName(spec: ServerSpec): string {
  const safe = spec.name.toLowerCase().replace(/[^a-z0-9]/g, "");

  return safe === "" ? "x" : safe;
}

export function cachePath(dir: string, spec: ServerSpec): string {
  return join(dir, `${safeName(spec)}-${specHash(spec)}.json`);
}

function parseCachedTools(value: unknown): McpToolDef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const out: McpToolDef[] = [];

  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name === "") {
      return null;
    }

    out.push({
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      inputSchema: isRecord(item.inputSchema) ? item.inputSchema : null,
    });
  }

  return out;
}

function parseCachedPrompts(value: unknown): McpPromptDef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const out: McpPromptDef[] = [];

  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name === "") {
      return null;
    }

    out.push({
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      arguments: parsePromptArguments(item.arguments),
    });
  }

  return out;
}

function parseResourceCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export class ServerCache {
  private readonly dir: string;

  constructor(dir: string = join(homedir(), ".pi", "agent", "mcp")) {
    this.dir = dir;
  }

  load(spec: ServerSpec): CachedLists | null {
    let parsed: unknown;

    try {
      parsed = JSON.parse(readFileSync(cachePath(this.dir, spec), "utf8"));
    } catch {
      return null;
    }

    if (!isRecord(parsed) || parsed.hash !== specHash(spec)) {
      return null;
    }

    const tools = parseCachedTools(parsed.tools);
    const prompts = parseCachedPrompts(parsed.prompts);

    if (tools === null || prompts === null) {
      return null;
    }

    return { tools, prompts, resourceCount: parseResourceCount(parsed.resourceCount) };
  }

  save(spec: ServerSpec, lists: CachedLists): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        cachePath(this.dir, spec),
        JSON.stringify({
          name: spec.name,
          hash: specHash(spec),
          savedAt: Date.now(),
          tools: lists.tools,
          prompts: lists.prompts,
          resourceCount: lists.resourceCount,
        }),
      );
    } catch {
      return;
    }
  }
}
