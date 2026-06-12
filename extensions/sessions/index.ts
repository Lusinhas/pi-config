import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtwCommand } from "./btw";
import { registerSearchCommand } from "./search";
import { clampInt, isRecord, registerHistoryTool } from "./tools";
import type { SessionsConfig } from "./tools";

const DEFAULTS: SessionsConfig = {
  listLimit: 20,
  readLimit: 60,
  searchLimit: 50,
  excerptChars: 160,
  contextEntries: 3,
  allowSwitch: false,
  btwBudget: 12000,
  btwMaxTokens: 4096,
};

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    if (isRecord(current) && isRecord(value)) {
      out[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function loadConfig(): SessionsConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const shipped: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(shipped)) merged = deepMerge(merged, shipped);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalOverlay = readJson(join(homedir(), ".pi", "agent", "piconfig.json"));
  if (globalOverlay && isRecord(globalOverlay.sessions)) merged = deepMerge(merged, globalOverlay.sessions);
  const projectOverlay = readJson(join(process.cwd(), ".pi", "piconfig.json"));
  if (projectOverlay && isRecord(projectOverlay.sessions)) merged = deepMerge(merged, projectOverlay.sessions);
  return {
    listLimit: clampInt(merged.listLimit, 1, 200, DEFAULTS.listLimit),
    readLimit: clampInt(merged.readLimit, 1, 500, DEFAULTS.readLimit),
    searchLimit: clampInt(merged.searchLimit, 1, 50, DEFAULTS.searchLimit),
    excerptChars: clampInt(merged.excerptChars, 40, 2000, DEFAULTS.excerptChars),
    contextEntries: clampInt(merged.contextEntries, 0, 20, DEFAULTS.contextEntries),
    allowSwitch: merged.allowSwitch === true,
    btwBudget: clampInt(merged.btwBudget, 500, 200000, DEFAULTS.btwBudget),
    btwMaxTokens: clampInt(merged.btwMaxTokens, 16, 64000, DEFAULTS.btwMaxTokens),
  };
}

export default function sessions(pi: ExtensionAPI): void {
  const config = loadConfig();
  registerHistoryTool(pi, config);
  registerSearchCommand(pi, config);
  registerBtwCommand(pi, config);
}
