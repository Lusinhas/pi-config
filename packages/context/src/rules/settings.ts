export interface FormatFlags {
  pi: boolean;
  claude: boolean;
  cursor: boolean;
  copilot: boolean;
  windsurf: boolean;
  cline: boolean;
}

export interface RulesSettings {
  formats: FormatFlags;
  alwaysBudget: number;
  scopedBudget: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Coerce {
  budget(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  }

  formats(value: unknown, fallback: FormatFlags): FormatFlags {
    const flags: FormatFlags = { ...fallback };

    if (isRecord(value)) {
      for (const key of Object.keys(flags) as Array<keyof FormatFlags>) {
        const candidate = value[key];

        if (typeof candidate === "boolean") {
          flags[key] = candidate;
        }
      }
    }

    return flags;
  }
}

export class RulesConfig {
  private readonly defaults: RulesSettings;
  private readonly coerce: Coerce;

  constructor(shipped: Record<string, unknown>) {
    this.coerce = new Coerce();
    this.defaults = this.normalize(shipped, RulesConfig.hardDefaults());
  }

  static hardDefaults(): RulesSettings {
    return {
      formats: { pi: true, claude: true, cursor: true, copilot: true, windsurf: true, cline: true },
      alwaysBudget: 8000,
      scopedBudget: 6000,
    };
  }

  defaultSettings(): RulesSettings {
    return this.clone(this.defaults);
  }

  resolve(overrides: ReadonlyArray<Record<string, unknown>>): RulesSettings {
    let merged = this.toRecord(this.defaults);

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
      } else {
        merged[key] = value;
      }
    }

    return merged;
  }

  private normalize(raw: Record<string, unknown>, fallback: RulesSettings): RulesSettings {
    return {
      formats: this.coerce.formats(raw.formats, fallback.formats),
      alwaysBudget: this.coerce.budget(raw.alwaysBudget, fallback.alwaysBudget),
      scopedBudget: this.coerce.budget(raw.scopedBudget, fallback.scopedBudget),
    };
  }

  private toRecord(settings: RulesSettings): Record<string, unknown> {
    return {
      formats: { ...settings.formats },
      alwaysBudget: settings.alwaysBudget,
      scopedBudget: settings.scopedBudget,
    };
  }

  private clone(settings: RulesSettings): RulesSettings {
    return {
      formats: { ...settings.formats },
      alwaysBudget: settings.alwaysBudget,
      scopedBudget: settings.scopedBudget,
    };
  }
}
