export const MODES = ["block", "warn", "off"] as const;

export type Mode = (typeof MODES)[number];

export function isMode(value: unknown): value is Mode {
  return value === "block" || value === "warn" || value === "off";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DetectorToggles {
  narration: boolean;
  fillerdoc: boolean;
  changemarker: boolean;
  todo: boolean;
  separator: boolean;
}

export interface CommentsConfig {
  mode: Mode;
  maxFindings: number;
  allowMarker: string;
  ignore: string[];
  detectors: DetectorToggles;
}

export function hardDefaults(): CommentsConfig {
  return {
    mode: "block",
    maxFindings: 10,
    allowMarker: "@allow-comment",
    ignore: [
      "**/vendor/**",
      "**/vendored/**",
      "**/node_modules/**",
      "**/third_party/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/target/**",
      "**/.next/**",
      "**/coverage/**",
      "**/__generated__/**",
      "**/*.gen.*",
      "**/*.generated.*",
      "**/*_generated.*",
      "**/*.min.js",
      "**/*.min.css",
      "**/*.md",
      "**/*.markdown",
      "**/*.mdx",
      "**/*.lock",
      "**/package-lock.json",
    ],
    detectors: {
      narration: true,
      fillerdoc: true,
      changemarker: true,
      todo: true,
      separator: true,
    },
  };
}

export class Config {
  private readonly defaults: CommentsConfig;

  constructor(shipped: Record<string, unknown>) {
    this.defaults = this.normalize(shipped, Config.hardDefaults());
  }

  static hardDefaults(): CommentsConfig {
    return hardDefaults();
  }

  defaultConfig(): CommentsConfig {
    return this.clone(this.defaults);
  }

  resolve(overrides: ReadonlyArray<Record<string, unknown>>): CommentsConfig {
    let merged: Record<string, unknown> = this.toRecord(this.defaults);

    for (const override of overrides) {
      merged = this.deepMerge(merged, override);
    }

    return this.normalize(merged, this.defaults);
  }

  deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = merged[key];

      if (isRecord(current) && isRecord(value)) {
        merged[key] = this.deepMerge(current, value);
      } else if (value !== undefined) {
        merged[key] = value;
      }
    }

    return merged;
  }

  private normalize(raw: Record<string, unknown>, fallback: CommentsConfig): CommentsConfig {
    const maxFindings =
      typeof raw.maxFindings === "number" && Number.isFinite(raw.maxFindings) && raw.maxFindings >= 1
        ? Math.floor(raw.maxFindings)
        : fallback.maxFindings;

    const allowMarker =
      typeof raw.allowMarker === "string" && raw.allowMarker.trim().length > 0
        ? raw.allowMarker.trim()
        : fallback.allowMarker;

    return {
      mode: isMode(raw.mode) ? raw.mode : fallback.mode,
      maxFindings,
      allowMarker,
      ignore: this.normalizeIgnore(raw.ignore, fallback.ignore),
      detectors: this.normalizeDetectors(raw.detectors, fallback.detectors),
    };
  }

  private normalizeDetectors(value: unknown, fallback: DetectorToggles): DetectorToggles {
    const detectors: DetectorToggles = { ...fallback };

    if (isRecord(value)) {
      for (const key of Object.keys(detectors) as Array<keyof DetectorToggles>) {
        const candidate = value[key];

        if (typeof candidate === "boolean") {
          detectors[key] = candidate;
        }
      }
    }

    return detectors;
  }

  private normalizeIgnore(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) {
      return [...fallback];
    }

    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  private toRecord(config: CommentsConfig): Record<string, unknown> {
    return {
      mode: config.mode,
      maxFindings: config.maxFindings,
      allowMarker: config.allowMarker,
      ignore: [...config.ignore],
      detectors: { ...config.detectors },
    };
  }

  private clone(config: CommentsConfig): CommentsConfig {
    return {
      mode: config.mode,
      maxFindings: config.maxFindings,
      allowMarker: config.allowMarker,
      ignore: [...config.ignore],
      detectors: { ...config.detectors },
    };
  }
}
