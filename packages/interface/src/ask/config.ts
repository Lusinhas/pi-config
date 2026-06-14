export interface AskConfig {
  defaultTimeoutSec: number;
  otherLabel: string;
  doneLabel: string;
}

export const DEFAULTS: AskConfig = {
  defaultTimeoutSec: 0,
  otherLabel: "Other (type a custom answer)",
  doneLabel: "Done",
};

export class Config {
  static readonly DEFAULTS: AskConfig = DEFAULTS;

  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static deepMerge(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = out[key];
      const descend = Config.isRecord(current) && Config.isRecord(value);

      out[key] = descend ? Config.deepMerge(current, value) : value;
    }

    return out;
  }

  static fromRaw(
    shipped: Record<string, unknown> | null,
    global: Record<string, unknown> | null,
    project: Record<string, unknown> | null,
  ): AskConfig {
    let merged: Record<string, unknown> = { ...DEFAULTS };

    if (Config.isRecord(shipped)) {
      merged = Config.deepMerge(merged, shipped);
    }

    if (global !== null && Config.isRecord(global.ask)) {
      merged = Config.deepMerge(merged, global.ask);
    }

    if (project !== null && Config.isRecord(project.ask)) {
      merged = Config.deepMerge(merged, project.ask);
    }

    return new Config(merged).validated;
  }

  readonly validated: AskConfig;

  constructor(merged: Record<string, unknown>) {
    this.validated = {
      defaultTimeoutSec: Config.validTimeout(merged.defaultTimeoutSec),
      otherLabel: Config.validLabel(merged.otherLabel, DEFAULTS.otherLabel),
      doneLabel: Config.validLabel(merged.doneLabel, DEFAULTS.doneLabel),
    };
  }

  private static validTimeout(value: unknown): number {
    const ok = typeof value === "number" && Number.isFinite(value) && value >= 0;

    return ok ? value : DEFAULTS.defaultTimeoutSec;
  }

  private static validLabel(value: unknown, fallback: string): string {
    const ok = typeof value === "string" && value.trim() !== "";

    return ok ? value.trim() : fallback;
  }
}
