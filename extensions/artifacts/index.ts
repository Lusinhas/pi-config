import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerArtifactTool } from "./retrieve";
import { type ArtifactsConfig, ArtifactStore, buildReplacement, pruneArtifacts } from "./spill";

interface TextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

const DEFAULTS: ArtifactsConfig = {
  spillBytes: 30720,
  headLines: 40,
  tailLines: 20,
  skipTools: ["artifact"],
  maxAgeDays: 7,
  retrieveLines: 200,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function intAtLeast(value: unknown, min: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized >= min ? normalized : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function loadConfig(): ArtifactsConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "suite.json"));
  if (globalConfig && isRecord(globalConfig.artifacts)) merged = deepMerge(merged, globalConfig.artifacts);
  const projectConfig = readJson(join(process.cwd(), ".pi", "suite.json"));
  if (projectConfig && isRecord(projectConfig.artifacts)) merged = deepMerge(merged, projectConfig.artifacts);
  const skipTools = new Set<string>(["artifact"]);
  if (Array.isArray(merged.skipTools)) {
    for (const value of merged.skipTools) {
      if (typeof value === "string" && value.trim() !== "") skipTools.add(value.trim());
    }
  }
  return {
    spillBytes: intAtLeast(merged.spillBytes, 1024, DEFAULTS.spillBytes),
    headLines: intAtLeast(merged.headLines, 0, DEFAULTS.headLines),
    tailLines: intAtLeast(merged.tailLines, 0, DEFAULTS.tailLines),
    skipTools: [...skipTools],
    maxAgeDays: positiveNumber(merged.maxAgeDays, DEFAULTS.maxAgeDays),
    retrieveLines: intAtLeast(merged.retrieveLines, 1, DEFAULTS.retrieveLines),
  };
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    isRecord(block) &&
    block.type === "text" &&
    typeof block.text === "string"
  );
}

export default function artifacts(pi: ExtensionAPI): void {
  const config = loadConfig();
  const store = new ArtifactStore();
  const skip = new Set(config.skipTools);

  registerArtifactTool(pi, store, config);

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    try {
      pruneArtifacts(config.maxAgeDays);
    } catch {
      void 0;
    }
    store.attach(ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
    if (skip.has(toolName)) return undefined;
    if (!Array.isArray(event.content)) return undefined;
    let changed = false;
    const next = event.content.map((block) => {
      if (!isTextBlock(block)) return block;
      if (Buffer.byteLength(block.text, "utf8") <= config.spillBytes) return block;
      const record = store.spill(ctx, toolName, block.text);
      if (!record) return block;
      changed = true;
      return { type: "text" as const, text: buildReplacement(block.text, record, config) };
    });
    if (!changed) return undefined;
    return { content: next };
  });
}
