export interface ToolViewConfig {
  maxLines: number;
  maxLineChars: number;
  compactChars: number;
  viewportLines: number;
}

export const DEFAULTS: ToolViewConfig = {
  maxLines: 12,
  maxLineChars: 160,
  compactChars: 100,
  viewportLines: 16,
};

export class Config {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static positiveInt(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }

    return fallback;
  }

  static section(source: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (Config.isRecord(source) && Config.isRecord(source.toolview)) {
      return source.toolview;
    }

    return null;
  }

  static fromLayers(shipped: Record<string, unknown> | null | undefined, sections: Array<Record<string, unknown> | null | undefined>): ToolViewConfig {
    let merged: Record<string, unknown> = Config.isRecord(shipped) ? { ...shipped } : {};

    for (const section of sections) {
      if (Config.isRecord(section)) {
        merged = { ...merged, ...section };
      }
    }

    return Config.fromMerged(merged);
  }

  static fromMerged(merged: Record<string, unknown>): ToolViewConfig {
    return {
      maxLines: Config.positiveInt(merged.maxLines, DEFAULTS.maxLines),
      maxLineChars: Config.positiveInt(merged.maxLineChars, DEFAULTS.maxLineChars),
      compactChars: Config.positiveInt(merged.compactChars, DEFAULTS.compactChars),
      viewportLines: Config.positiveInt(merged.viewportLines, DEFAULTS.viewportLines),
    };
  }
}
