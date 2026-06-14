export interface GoalsConfig {
  judgeModel: string;
  judgeTimeoutMs: number;
  judgeMaxChars: number;
  metMarker: string;
  maxIterations: number;
  enforceTodos: boolean;
  loopMinIntervalMs: number;
  statusMaxChars: number;
}

export class Config {
  static readonly defaults: GoalsConfig = {
    judgeModel: "anthropic/claude-haiku-4-5",
    judgeTimeoutMs: 30000,
    judgeMaxChars: 8000,
    metMarker: "<goal-met/>",
    maxIterations: 25,
    enforceTodos: false,
    loopMinIntervalMs: 5000,
    statusMaxChars: 48,
  };

  readonly values: GoalsConfig;

  constructor(layers: readonly unknown[]) {
    let merged: Record<string, unknown> = { ...Config.defaults };

    for (const layer of layers) {

      if (Config.isRecord(layer)) {
        merged = Config.deepMerge(merged, layer);
      }
    }

    this.values = Config.coerce(merged);
  }

  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static positive(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  }

  static deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = result[key];

      if (Config.isRecord(current) && Config.isRecord(value)) {
        result[key] = Config.deepMerge(current, value);
      } else if (value !== undefined) {
        result[key] = value;
      }
    }

    return result;
  }

  static section(source: unknown): Record<string, unknown> | undefined {

    if (Config.isRecord(source) && Config.isRecord(source.goals)) {
      return source.goals;
    }

    return undefined;
  }

  static coerce(merged: Record<string, unknown>): GoalsConfig {
    const defaults = Config.defaults;

    return {
      judgeModel:
        typeof merged.judgeModel === "string" && merged.judgeModel.trim()
          ? merged.judgeModel.trim()
          : defaults.judgeModel,
      judgeTimeoutMs: Config.positive(merged.judgeTimeoutMs, defaults.judgeTimeoutMs),
      judgeMaxChars: Math.floor(Config.positive(merged.judgeMaxChars, defaults.judgeMaxChars)),
      metMarker: typeof merged.metMarker === "string" && merged.metMarker ? merged.metMarker : defaults.metMarker,
      maxIterations: Math.floor(Config.positive(merged.maxIterations, defaults.maxIterations)),
      enforceTodos: typeof merged.enforceTodos === "boolean" ? merged.enforceTodos : defaults.enforceTodos,
      loopMinIntervalMs: Config.positive(merged.loopMinIntervalMs, defaults.loopMinIntervalMs),
      statusMaxChars: Math.floor(Config.positive(merged.statusMaxChars, defaults.statusMaxChars)),
    };
  }
}
