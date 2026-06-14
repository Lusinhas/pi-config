export interface TodosConfig {
  mirror: boolean;
  widget: boolean;
  inject: boolean;
  widgetLimit: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Config {
  private readonly shipped: Record<string, unknown>;

  constructor(shipped: Record<string, unknown>) {
    this.shipped = shipped;
  }

  static hardDefaults(): TodosConfig {
    return { mirror: true, widget: true, inject: true, widgetLimit: 8 };
  }

  defaultConfig(): TodosConfig {
    return this.resolve([]);
  }

  resolve(overrides: ReadonlyArray<Record<string, unknown>>): TodosConfig {
    let merged: Record<string, unknown> = { ...Config.hardDefaults() };

    merged = this.deepMerge(merged, this.shipped);

    for (const override of overrides) {
      merged = this.deepMerge(merged, override);
    }

    return this.normalize(merged);
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

  private normalize(raw: Record<string, unknown>): TodosConfig {
    const fallback = Config.hardDefaults();
    const widgetLimit =
      typeof raw.widgetLimit === "number" && Number.isInteger(raw.widgetLimit) && raw.widgetLimit > 0
        ? raw.widgetLimit
        : fallback.widgetLimit;

    return {
      mirror: typeof raw.mirror === "boolean" ? raw.mirror : fallback.mirror,
      widget: typeof raw.widget === "boolean" ? raw.widget : fallback.widget,
      inject: typeof raw.inject === "boolean" ? raw.inject : fallback.inject,
      widgetLimit,
    };
  }
}
