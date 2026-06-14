export class Text {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  static clip(text: string, limit: number): string {
    if (text.length <= limit) {
      return text;
    }

    return `${text.slice(0, limit)} [+${text.length - limit} chars]`;
  }

  static oneLine(text: string, limit: number): string {
    const collapsed = text.replace(/\s+/g, " ").trim();

    if (collapsed.length <= limit) {
      return collapsed;
    }

    return `${collapsed.slice(0, limit)}…`;
  }

  static clampInt(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }

    const floored = Math.floor(value);

    if (floored < min) {
      return min;
    }

    if (floored > max) {
      return max;
    }

    return floored;
  }

  static toTime(value: unknown): number {
    if (value instanceof Date) {
      return value.getTime();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Date.parse(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return 0;
  }

  static formatStamp(ms: number): string {
    if (ms <= 0) {
      return "unknown time";
    }

    const date = new Date(ms);
    const pad = (part: number): string => String(part).padStart(2, "0");

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

export interface SessionsConfig {
  listLimit: number;
  readLimit: number;
  searchLimit: number;
  excerptChars: number;
  contextEntries: number;
  allowSwitch: boolean;
  btwBudget: number;
  btwMaxTokens: number;
}

export class Config {
  static readonly DEFAULTS: SessionsConfig = {
    listLimit: 20,
    readLimit: 60,
    searchLimit: 50,
    excerptChars: 160,
    contextEntries: 3,
    allowSwitch: false,
    btwBudget: 12000,
    btwMaxTokens: 4096,
  };

  static deepMerge(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = out[key];

      if (Text.isRecord(current) && Text.isRecord(value)) {
        out[key] = Config.deepMerge(current, value);
      } else if (value !== undefined) {
        out[key] = value;
      }
    }

    return out;
  }

  static fromRaw(
    shipped: Record<string, unknown> | null,
    global: Record<string, unknown> | null,
    project: Record<string, unknown> | null,
  ): SessionsConfig {
    let merged: Record<string, unknown> = { ...Config.DEFAULTS };

    if (Text.isRecord(shipped)) {
      merged = Config.deepMerge(merged, shipped);
    }

    if (global !== null && Text.isRecord(global.sessions)) {
      merged = Config.deepMerge(merged, global.sessions);
    }

    if (project !== null && Text.isRecord(project.sessions)) {
      merged = Config.deepMerge(merged, project.sessions);
    }

    return new Config(merged).validated;
  }

  readonly validated: SessionsConfig;

  constructor(merged: Record<string, unknown>) {
    const defaults = Config.DEFAULTS;

    this.validated = {
      listLimit: Text.clampInt(merged.listLimit, 1, 200, defaults.listLimit),
      readLimit: Text.clampInt(merged.readLimit, 1, 500, defaults.readLimit),
      searchLimit: Text.clampInt(merged.searchLimit, 1, 50, defaults.searchLimit),
      excerptChars: Text.clampInt(merged.excerptChars, 40, 2000, defaults.excerptChars),
      contextEntries: Text.clampInt(merged.contextEntries, 0, 20, defaults.contextEntries),
      allowSwitch: merged.allowSwitch === true,
      btwBudget: Text.clampInt(merged.btwBudget, 500, 200000, defaults.btwBudget),
      btwMaxTokens: Text.clampInt(merged.btwMaxTokens, 16, 64000, defaults.btwMaxTokens),
    };
  }
}
