import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { authorize, loadToken } from "./oauth";
import { collectServerSpecs, McpRegistry, parseServerSpec, type ManagedServer } from "./registry";
import { discoverSkillServers } from "./skills";

interface McpExtensionConfig {
  servers: Record<string, unknown>;
  lazy: boolean;
  outputLimit: number;
  inlineLimit: number;
  requestTimeoutMs: number;
  startTimeoutMs: number;
  idleMs: number;
  authTimeoutMs: number;
  skillDirs: string[];
  maxScanDepth: number;
  stderrLines: number;
  framing: "ndjson" | "lsp";
}

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

const DEFAULTS: McpExtensionConfig = {
  servers: {},
  lazy: true,
  outputLimit: 25600,
  inlineLimit: 8192,
  requestTimeoutMs: 60000,
  startTimeoutMs: 20000,
  idleMs: 300000,
  authTimeoutMs: 300000,
  skillDirs: ["../../skills"],
  maxScanDepth: 6,
  stderrLines: 20,
  framing: "ndjson",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
  return out;
}

function loadConfig(): McpExtensionConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "piconfig.json"));
  if (globalConfig && isRecord(globalConfig.mcp)) merged = deepMerge(merged, globalConfig.mcp);
  const projectConfig = readJson(join(process.cwd(), ".pi", "piconfig.json"));
  if (projectConfig && isRecord(projectConfig.mcp)) merged = deepMerge(merged, projectConfig.mcp);
  return {
    servers: isRecord(merged.servers) ? merged.servers : {},
    lazy: merged.lazy !== false,
    outputLimit: positiveInt(merged.outputLimit, DEFAULTS.outputLimit),
    inlineLimit: positiveInt(merged.inlineLimit, DEFAULTS.inlineLimit),
    requestTimeoutMs: positiveInt(merged.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    startTimeoutMs: positiveInt(merged.startTimeoutMs, DEFAULTS.startTimeoutMs),
    idleMs: nonNegativeInt(merged.idleMs, DEFAULTS.idleMs),
    authTimeoutMs: positiveInt(merged.authTimeoutMs, DEFAULTS.authTimeoutMs),
    skillDirs: stringArray(merged.skillDirs) ?? [...DEFAULTS.skillDirs],
    maxScanDepth: positiveInt(merged.maxScanDepth, DEFAULTS.maxScanDepth),
    stderrLines: positiveInt(merged.stderrLines, DEFAULTS.stderrLines),
    framing: merged.framing === "lsp" ? "lsp" : "ndjson",
  };
}

function formatServer(server: ManagedServer): string {
  const spec = server.spec;
  const tags: string[] = [spec.kind, spec.source];
  if (spec.lazy) tags.push(server.state === "stopped" && server.tools.length > 0 ? "lazy, starts on first use" : "lazy");
  if (!spec.enabled) tags.push("disabled");
  if (spec.kind === "http") {
    if (server.needsAuth) tags.push("needs auth");
    else if (loadToken(spec.name) !== null) tags.push("authorized");
  }
  if (server.tools.length > 0 || server.prompts.length > 0 || server.resourceCount > 0 || server.state === "ready") {
    tags.push(`${server.tools.length} tools, ${server.prompts.length} prompts, ${server.resourceCount} resources`);
  }
  const errorNote = server.error !== null && server.error !== "" ? ` (${server.error})` : "";
  return `  ${spec.name}: ${server.state}${errorNote} [${tags.join("; ")}]`;
}

function formatServerList(servers: ManagedServer[]): string {
  if (servers.length === 0) {
    return "No MCP servers configured. Add entries under mcp.servers in piconfig.json, to .mcp.json, or to a skill's mcp frontmatter.";
  }
  return ["MCP servers:", ...servers.map((server) => formatServer(server))].join("\n");
}

export default function mcp(pi: ExtensionAPI): void {
  const config = loadConfig();
  const registry = new McpRegistry(pi, {
    outputLimit: config.outputLimit,
    inlineLimit: config.inlineLimit,
    requestTimeoutMs: config.requestTimeoutMs,
    startTimeoutMs: config.startTimeoutMs,
    idleMs: config.idleMs,
    stderrLines: config.stderrLines,
  });
  for (const spec of collectServerSpecs(config.servers, config.framing, process.cwd(), config.lazy)) {
    registry.addServer(spec);
  }
  const baseDir = dirname(fileURLToPath(import.meta.url));
  for (const entry of discoverSkillServers(config.skillDirs, baseDir, config.maxScanDepth)) {
    if (registry.get(entry.name) !== undefined) continue;
    const spec = parseServerSpec(entry.name, entry.raw, true, `skill ${entry.skillPath}`, config.framing);
    if (spec !== null) registry.addServer(spec);
  }

  let started = false;
  pi.on("session_start", () => {
    if (started) return;
    started = true;
    registry.startAll();
  });

  pi.on("session_shutdown", async () => {
    await registry.shutdown();
  });

  pi.registerCommand("mcp", {
    description: "List MCP servers; /mcp restart <name> restarts one; /mcp auth <name> runs OAuth for an HTTP server",
    getArgumentCompletions: (argumentPrefix: string): CompletionItem[] | null => {
      const prefix = argumentPrefix.trimStart();
      const items: CompletionItem[] = [];
      for (const server of registry.list()) {
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
    },
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const notify = (message: string, level: "info" | "warning" | "error"): void => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
      };
      const trimmed = (args ?? "").trim();
      if (trimmed === "") {
        notify(formatServerList(registry.list()), "info");
        return;
      }
      const [sub, ...rest] = trimmed.split(/\s+/);
      const name = rest.join(" ").trim();
      if (sub !== "restart" && sub !== "auth") {
        notify(`Unknown subcommand "${sub}". Usage: /mcp | /mcp restart <server> | /mcp auth <server>`, "error");
        return;
      }
      if (name === "") {
        notify(`Usage: /mcp ${sub} <server>`, "error");
        return;
      }
      const server = registry.get(name);
      if (server === undefined) {
        const names = registry
          .list()
          .map((entry) => entry.spec.name)
          .join(", ");
        notify(`Unknown MCP server "${name}".${names !== "" ? ` Known servers: ${names}` : ""}`, "error");
        return;
      }
      if (sub === "restart") {
        if (!server.spec.enabled) {
          notify(`MCP server "${name}" is disabled in its configuration.`, "error");
          return;
        }
        notify(`Restarting MCP server "${name}"...`, "info");
        try {
          await registry.restart(server);
          notify(
            `MCP server "${name}" is ready: ${server.tools.length} tools, ${server.prompts.length} prompts, ${server.resourceCount} resources.`,
            "info",
          );
        } catch (error) {
          notify(`Restart of "${name}" failed: ${toError(error).message}`, "error");
        }
        return;
      }
      if (server.spec.kind !== "http") {
        notify(`MCP server "${name}" runs over stdio; OAuth only applies to HTTP servers.`, "error");
        return;
      }
      if (!ctx.hasUI) return;
      try {
        await authorize(name, server.spec.url, server.wwwAuthenticate, ctx, config.authTimeoutMs);
        notify(`Stored OAuth tokens for "${name}". Restarting the server...`, "info");
        await registry.restart(server);
        notify(
          `MCP server "${name}" is ready: ${server.tools.length} tools, ${server.prompts.length} prompts, ${server.resourceCount} resources.`,
          "info",
        );
      } catch (error) {
        notify(`Authorization for "${name}" failed: ${toError(error).message}`, "error");
      }
    },
  });
}
