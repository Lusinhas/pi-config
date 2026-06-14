export interface SkillsConfig {
  global: boolean;
  project: boolean;
  dirs: string[];
}

export interface DirsDiagnostic {
  index: number;
  value: unknown;
  reason: "not-a-string" | "empty-string";
}

export interface ConfigSources {
  shipped: unknown;
  global: unknown;
  project: unknown;
}

export class Config {
  static readonly defaults: SkillsConfig = {
    global: true,
    project: true,
    dirs: [],
  };

  readonly values: SkillsConfig;
  readonly dirsDiagnostics: readonly DirsDiagnostic[];

  constructor(sources: ConfigSources) {
    let merged: Record<string, unknown> = { ...Config.defaults };

    for (const source of [sources.shipped, sources.global, sources.project]) {
      const section = Config.section(source);

      if (section !== null) {
        merged = { ...merged, ...section };
      }
    }

    const normalized = Config.normalize(merged);
    this.values = normalized.config;
    this.dirsDiagnostics = normalized.diagnostics;
  }

  static asRecord(value: unknown): Record<string, unknown> | null {
    return Config.isRecord(value) ? value : null;
  }

  static section(value: unknown): Record<string, unknown> | null {
    const record = Config.asRecord(value);

    if (record === null) {

      return null;
    }

    return Config.isRecord(record.skills) ? record.skills : null;
  }

  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static normalize(raw: Record<string, unknown>): { config: SkillsConfig; diagnostics: DirsDiagnostic[] } {
    const diagnostics: DirsDiagnostic[] = [];
    const dirs = Config.normalizeDirs(raw.dirs, diagnostics);

    return {
      config: {
        global: typeof raw.global === "boolean" ? raw.global : Config.defaults.global,
        project: typeof raw.project === "boolean" ? raw.project : Config.defaults.project,
        dirs,
      },
      diagnostics,
    };
  }

  static normalizeDirs(value: unknown, diagnostics: DirsDiagnostic[]): string[] {
    if (!Array.isArray(value)) {

      return [...Config.defaults.dirs];
    }

    const kept: string[] = [];

    value.forEach((item, index) => {

      if (typeof item !== "string") {
        diagnostics.push({ index, value: item, reason: "not-a-string" });

        return;
      }

      if (item.length === 0) {
        diagnostics.push({ index, value: item, reason: "empty-string" });

        return;
      }

      kept.push(item);
    });

    return kept;
  }
}
