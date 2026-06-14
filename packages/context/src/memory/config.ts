export interface MemoryConfig {
  injectBudget: number;
  consolidateEvery: number;
  consolidateOnQuit: boolean;
  model: string;
  maxFacts: number;
  recallBudget: number;
  maxTopicBytes: number;
  transcriptBudget: number;
}

const defaults: MemoryConfig = {
  injectBudget: 2000,
  consolidateEvery: 0,
  consolidateOnQuit: true,
  model: "",
  maxFacts: 3,
  recallBudget: 6000,
  maxTopicBytes: 65536,
  transcriptBudget: 12000,
};

export class Config {
  static readonly defaults: MemoryConfig = defaults;

  readonly values: MemoryConfig;

  constructor(layers: readonly unknown[]) {
    let merged: Record<string, unknown> = { ...defaults };

    for (const layer of layers) {

      if (Config.isRecord(layer)) {
        merged = Config.deepMerge(merged, layer);
      }
    }

    this.values = Config.sanitize(merged);
  }

  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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

  static num(value: unknown, fallback: number, min: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
  }

  static sanitize(raw: Record<string, unknown>): MemoryConfig {
    return {
      injectBudget: Config.num(raw.injectBudget, defaults.injectBudget, 100),
      consolidateEvery: Config.num(raw.consolidateEvery, defaults.consolidateEvery, 0),
      consolidateOnQuit: typeof raw.consolidateOnQuit === "boolean" ? raw.consolidateOnQuit : defaults.consolidateOnQuit,
      model: typeof raw.model === "string" ? raw.model : defaults.model,
      maxFacts: Math.min(Config.num(raw.maxFacts, defaults.maxFacts, 1), 10),
      recallBudget: Config.num(raw.recallBudget, defaults.recallBudget, 500),
      maxTopicBytes: Config.num(raw.maxTopicBytes, defaults.maxTopicBytes, 4096),
      transcriptBudget: Config.num(raw.transcriptBudget, defaults.transcriptBudget, 1000),
    };
  }
}
