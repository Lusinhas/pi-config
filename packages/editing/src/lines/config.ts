import { isHashMode } from "./mode.ts";
import type { HashMode } from "./mode.ts";

export interface HashlineConfig {
  compat: boolean;
  defaultMode: HashMode;
  modes: Record<string, HashMode>;
  maxLines: number;
  maxBytes: number;
  maxLineLength: number;
  contextLines: number;
}

export const DEFAULTS: HashlineConfig = {
  compat: true,
  defaultMode: "hashline",
  modes: {},
  maxLines: 2000,
  maxBytes: 51200,
  maxLineLength: 2000,
  contextLines: 2,
};

export const LARGE_FILE_BYTES = 64 * 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }

  return out;
}

export function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Math.floor(value) >= 1
    ? Math.floor(value)
    : fallback;
}

export function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Math.floor(value) >= 0
    ? Math.floor(value)
    : fallback;
}

export class Config {
  static section(file: Record<string, unknown> | null): Record<string, unknown> | null {
    if (file !== null && isRecord(file.hashline)) {
      return file.hashline;
    }

    return null;
  }

  static load(
    shipped: Record<string, unknown> | null,
    globalSection: Record<string, unknown> | null,
    projectSection: Record<string, unknown> | null,
  ): HashlineConfig {
    let merged: Record<string, unknown> = { ...DEFAULTS };

    if (shipped !== null) {
      merged = deepMerge(merged, shipped);
    }

    if (globalSection !== null) {
      merged = deepMerge(merged, globalSection);
    }

    if (projectSection !== null) {
      merged = deepMerge(merged, projectSection);
    }

    return new Config(merged).resolve();
  }

  private readonly merged: Record<string, unknown>;

  constructor(merged: Record<string, unknown>) {
    this.merged = merged;
  }

  resolve(): HashlineConfig {
    return {
      compat: typeof this.merged.compat === "boolean" ? this.merged.compat : DEFAULTS.compat,
      defaultMode: isHashMode(this.merged.defaultMode) ? this.merged.defaultMode : DEFAULTS.defaultMode,
      modes: this.resolveModes(),
      maxLines: positiveInt(this.merged.maxLines, DEFAULTS.maxLines),
      maxBytes: positiveInt(this.merged.maxBytes, DEFAULTS.maxBytes),
      maxLineLength: positiveInt(this.merged.maxLineLength, DEFAULTS.maxLineLength),
      contextLines: nonNegativeInt(this.merged.contextLines, DEFAULTS.contextLines),
    };
  }

  private resolveModes(): Record<string, HashMode> {
    const modes: Record<string, HashMode> = {};

    if (isRecord(this.merged.modes)) {
      for (const [pattern, mode] of Object.entries(this.merged.modes)) {
        if (pattern !== "" && isHashMode(mode)) {
          modes[pattern] = mode;
        }
      }
    }

    return modes;
  }
}
