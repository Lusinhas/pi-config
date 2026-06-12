import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWithPreview, type PreviewSelectParams } from "./dialog.ts";
import { renderToolCall, renderToolCallCompact, type RenderOptions, type ToolRenderer } from "./render.ts";

const REGISTRY_KEY = Symbol.for("piconfig.toolview");
const SUBAGENT_MARKER_KEY = Symbol.for("piconfig.subagents.marker");

interface ToolViewConfig {
  maxLines: number;
  maxLineChars: number;
  compactChars: number;
  viewportLines: number;
}

export interface ToolViewRegistry {
  render(toolName: string, input: unknown, overrides?: Partial<RenderOptions>): string[];
  compact(toolName: string, input: unknown, maxChars?: number, cwd?: string): string;
  register(toolName: string, renderer: ToolRenderer): void;
  selectWithPreview(ctx: ExtensionContext, params: Omit<PreviewSelectParams, "viewport"> & { viewport?: number }): Promise<string | undefined>;
}

const FALLBACK: ToolViewConfig = {
  maxLines: 12,
  maxLineChars: 160,
  compactChars: 100,
  viewportLines: 16,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function loadConfig(): ToolViewConfig {
  let merged: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) {
      merged = parsed;
    }
  } catch {
    merged = {};
  }
  const overridePaths = [join(homedir(), ".pi", "agent", "suite.json"), join(process.cwd(), ".pi", "suite.json")];
  for (const path of overridePaths) {
    const overrides = readJsonFile(path);
    if (overrides && isRecord(overrides.toolview)) {
      merged = { ...merged, ...overrides.toolview };
    }
  }
  return {
    maxLines: positiveInt(merged.maxLines, FALLBACK.maxLines),
    maxLineChars: positiveInt(merged.maxLineChars, FALLBACK.maxLineChars),
    compactChars: positiveInt(merged.compactChars, FALLBACK.compactChars),
    viewportLines: positiveInt(merged.viewportLines, FALLBACK.viewportLines),
  };
}

function subagentDepth(): number {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const state = host[SUBAGENT_MARKER_KEY];
  if (isRecord(state) && typeof state.depth === "number" && Number.isFinite(state.depth)) {
    return state.depth;
  }
  return 0;
}

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  const custom = new Map<string, ToolRenderer>();
  const registry: ToolViewRegistry = {
    render: (toolName, input, overrides) =>
      renderToolCall(
        toolName,
        input,
        {
          maxLines: overrides?.maxLines ?? config.maxLines,
          maxLineChars: overrides?.maxLineChars ?? config.maxLineChars,
          cwd: overrides?.cwd ?? process.cwd(),
        },
        custom,
      ),
    compact: (toolName, input, maxChars, cwd) =>
      renderToolCallCompact(toolName, input, maxChars ?? config.compactChars, cwd ?? process.cwd(), custom),
    register: (toolName, renderer) => {
      custom.set(toolName, renderer);
    },
    selectWithPreview: (ctx, params) =>
      selectWithPreview(ctx, { ...params, viewport: params.viewport ?? config.viewportLines }),
  };
  if (subagentDepth() > 0) {
    return;
  }
  const host = globalThis as unknown as Record<symbol, unknown>;
  host[REGISTRY_KEY] = registry;
  pi.on("session_shutdown", () => {
    if (host[REGISTRY_KEY] === registry) {
      delete host[REGISTRY_KEY];
    }
  });
}
