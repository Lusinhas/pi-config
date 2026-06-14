import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuthConfig {
  enabled: boolean;
  longContext: boolean;
}

const DEFAULTS: AuthConfig = {
  enabled: false,
  longContext: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ConfigLoader {
  private readonly shipped: Record<string, unknown>;
  private readonly globalSuite: Record<string, unknown> | null;
  private readonly projectSuite: Record<string, unknown> | null;

  constructor(cwd: string, home: string = homedir()) {
    this.shipped = ConfigLoader.readJson(new URL("../../config.json", import.meta.url));
    this.globalSuite = ConfigLoader.readSuite(join(home, ".pi", "agent", "suite.json"));
    this.projectSuite = ConfigLoader.readSuite(join(cwd, ".pi", "suite.json"));
  }

  load(): AuthConfig {
    let merged: AuthConfig = { ...DEFAULTS };

    for (const layer of [this.section(this.shipped), this.section(this.globalSuite), this.section(this.projectSuite)]) {
      if (layer === null) {
        continue;
      }

      merged = {
        enabled: ConfigLoader.bool(layer.enabled, merged.enabled),
        longContext: ConfigLoader.bool(layer.longContext, merged.longContext),
      };
    }

    return merged;
  }

  private section(file: Record<string, unknown> | null): Record<string, unknown> | null {
    if (file !== null && isRecord(file.auth)) {
      return file.auth;
    }

    return null;
  }

  private static bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private static readJson(url: URL): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));

      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private static readSuite(path: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
