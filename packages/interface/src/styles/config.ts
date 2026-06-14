import { homedir } from "node:os";
import { join } from "node:path";

export interface StylesConfig {
  active: string;
  userDir: string;
}

export const DEFAULTS: StylesConfig = {
  active: "default",
  userDir: "~/.pi/agent/styles",
};

export class Config {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = out[key];
      out[key] = Config.isRecord(current) && Config.isRecord(value) ? Config.deepMerge(current, value) : value;
    }

    return out;
  }

  static coerceName(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  }

  static expandHome(path: string): string {
    if (path === "~") {
      return homedir();
    }

    if (path.startsWith("~/")) {
      return join(homedir(), path.slice(2));
    }

    return path;
  }

  static section(source: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (Config.isRecord(source) && Config.isRecord(source.styles)) {
      return source.styles;
    }

    return null;
  }

  static fromLayers(
    shipped: Record<string, unknown> | null | undefined,
    globalSection: Record<string, unknown> | null | undefined,
    projectSection: Record<string, unknown> | null | undefined,
  ): StylesConfig {
    let merged: Record<string, unknown> = { ...DEFAULTS };

    if (Config.isRecord(shipped)) {
      merged = Config.deepMerge(merged, shipped);
    }

    if (Config.isRecord(globalSection)) {
      merged = Config.deepMerge(merged, globalSection);
    }

    if (Config.isRecord(projectSection)) {
      merged = Config.deepMerge(merged, projectSection);
    }

    return {
      active: Config.coerceName(merged.active, DEFAULTS.active),
      userDir: Config.coerceName(merged.userDir, DEFAULTS.userDir),
    };
  }
}
