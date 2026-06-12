import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHandoff } from "./handoff";
import { createSharedState, registerPromotion } from "./promote";
import { registerStrategies } from "./strategies";

export interface PromotionConfig {
  enabled: boolean;
  ladder: string[];
}

export interface CompactionConfig {
  strategy: string;
  dropOverBytes: number;
  keepRecentTokens: number;
  preemptPct: number;
  promotePct: number;
  shakeOverBytes: number;
  handoffPath: string;
  handoffChars: number;
  handoffMaxTokens: number;
  promotion: PromotionConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function readOverrides(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(parsed) && isRecord(parsed.compaction)) {
      return parsed.compaction;
    }
  } catch {
    return {};
  }
  return {};
}

function loadConfig(): CompactionConfig {
  let merged: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) {
      merged = parsed;
    }
  } catch {
    merged = {};
  }
  merged = deepMerge(merged, readOverrides(join(homedir(), ".pi", "agent", "piconfig.json")));
  merged = deepMerge(merged, readOverrides(join(process.cwd(), ".pi", "piconfig.json")));
  const promotion = isRecord(merged.promotion) ? merged.promotion : {};
  const ladder = Array.isArray(promotion.ladder)
    ? promotion.ladder.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  return {
    strategy: stringOr(merged.strategy, "supersede"),
    dropOverBytes: numberOr(merged.dropOverBytes, 20480),
    keepRecentTokens: numberOr(merged.keepRecentTokens, 20000),
    preemptPct: numberOr(merged.preemptPct, 85),
    promotePct: numberOr(merged.promotePct, 90),
    shakeOverBytes: numberOr(merged.shakeOverBytes, 10240),
    handoffPath: stringOr(merged.handoffPath, ".pi/handoff.md"),
    handoffChars: numberOr(merged.handoffChars, 60000),
    handoffMaxTokens: numberOr(merged.handoffMaxTokens, 4096),
    promotion: {
      enabled: typeof promotion.enabled === "boolean" ? promotion.enabled : true,
      ladder,
    },
  };
}

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  const state = createSharedState();
  registerPromotion(pi, config, state);
  registerStrategies(pi, config, state);
  registerHandoff(pi, config, state);
}
