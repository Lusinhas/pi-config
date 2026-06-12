import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpPromptArgDef, McpPromptDef, McpToolDef } from "./client";
import type { ServerSpec } from "./registry";

export interface CachedLists {
  tools: McpToolDef[];
  prompts: McpPromptDef[];
  resourceCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function specHash(spec: ServerSpec): string {
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

function cacheDir(): string {
  return join(homedir(), ".pi", "agent", "mcp");
}

function cachePath(spec: ServerSpec): string {
  const safe = spec.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return join(cacheDir(), `${safe === "" ? "x" : safe}-${specHash(spec)}.json`);
}

function parseTools(value: unknown): McpToolDef[] | null {
  if (!Array.isArray(value)) return null;
  const out: McpToolDef[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name === "") return null;
    out.push({
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      inputSchema: isRecord(item.inputSchema) ? item.inputSchema : null,
    });
  }
  return out;
}

function parsePrompts(value: unknown): McpPromptDef[] | null {
  if (!Array.isArray(value)) return null;
  const out: McpPromptDef[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name === "") return null;
    const args: McpPromptArgDef[] = [];
    if (Array.isArray(item.arguments)) {
      for (const arg of item.arguments) {
        if (!isRecord(arg) || typeof arg.name !== "string" || arg.name === "") continue;
        args.push({
          name: arg.name,
          description: typeof arg.description === "string" ? arg.description : "",
          required: arg.required === true,
        });
      }
    }
    out.push({
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      arguments: args,
    });
  }
  return out;
}

export function loadServerCache(spec: ServerSpec): CachedLists | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cachePath(spec), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.hash !== specHash(spec)) return null;
  const tools = parseTools(parsed.tools);
  const prompts = parsePrompts(parsed.prompts);
  if (tools === null || prompts === null) return null;
  return {
    tools,
    prompts,
    resourceCount:
      typeof parsed.resourceCount === "number" && Number.isFinite(parsed.resourceCount) && parsed.resourceCount >= 0
        ? Math.floor(parsed.resourceCount)
        : 0,
  };
}

export function saveServerCache(spec: ServerSpec, lists: CachedLists): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(
      cachePath(spec),
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
