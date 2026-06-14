export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentModel {
  id?: unknown;
  provider?: unknown;
  name?: unknown;
}

export interface Resolution {
  model?: AgentModel;
  matches: AgentModel[];
  suggestions: string[];
}

export interface RegistryLike {
  getAll?: () => unknown;
  getAvailable?: () => unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asThinking(value: unknown): ThinkingLevel | undefined {
  if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ThinkingLevel;
  }

  return undefined;
}

export class Models {
  static idOf(model: AgentModel): string {
    return typeof model.id === "string" ? model.id : "";
  }

  static providerOf(model: AgentModel): string {
    return typeof model.provider === "string" ? model.provider : "";
  }

  static nameOf(model: AgentModel): string {
    return typeof model.name === "string" ? model.name : "";
  }

  static describe(model: AgentModel | null | undefined): string {
    if (!model) {
      return "unknown";
    }

    const provider = Models.providerOf(model);
    const id = Models.idOf(model);

    if (provider !== "" && id !== "") {
      return `${provider}/${id}`;
    }

    if (id !== "") {
      return id;
    }

    return "unknown";
  }

  static same(a: AgentModel, b: AgentModel): boolean {
    return Models.idOf(a) === Models.idOf(b) && Models.providerOf(a) === Models.providerOf(b);
  }

  static async list(registry: unknown): Promise<AgentModel[]> {
    if (!isRecord(registry)) {
      return [];
    }

    const surface = registry as RegistryLike;

    for (const method of [surface.getAll, surface.getAvailable]) {
      if (typeof method !== "function") {
        continue;
      }

      let result: unknown;

      try {
        result = await Promise.resolve(method.call(registry));
      } catch {
        continue;
      }

      if (!Array.isArray(result)) {
        continue;
      }

      const models = result.filter(
        (entry): entry is AgentModel => isRecord(entry) && typeof entry.id === "string" && entry.id !== ""
      );

      if (models.length > 0) {
        return models;
      }
    }

    return [];
  }

  static suggestionsFor(needle: string, models: AgentModel[]): string[] {
    const ids = models.map(model => Models.describe(model)).filter(id => id !== "unknown");

    if (needle === "") {
      return ids.slice(0, 5);
    }

    const tokens = needle.split(/[\s/_-]+/).filter(token => token.length > 1);

    const scored = ids
      .map(id => {
        const lower = id.toLowerCase();
        let score = 0;

        for (const token of tokens) {
          if (lower.includes(token)) {
            score += token.length;
          }
        }

        return { id, score };
      })
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(entry => entry.id);

    return scored.length > 0 ? scored : ids.slice(0, 5);
  }

  static resolveIn(models: AgentModel[], query: string): Resolution {
    const needle = query.trim().toLowerCase();

    if (needle === "" || models.length === 0) {
      return { matches: [], suggestions: Models.suggestionsFor(needle, models) };
    }

    const exact = models.filter(model => {
      const id = Models.idOf(model).toLowerCase();
      const full = `${Models.providerOf(model)}/${Models.idOf(model)}`.toLowerCase();
      const name = Models.nameOf(model).toLowerCase();

      return id === needle || full === needle || (name !== "" && name === needle);
    });

    if (exact.length > 0) {
      return { model: exact[0], matches: exact, suggestions: [] };
    }

    const partial = models.filter(model => {
      const haystack = `${Models.providerOf(model)}/${Models.idOf(model)} ${Models.nameOf(model)}`.toLowerCase();

      return haystack.includes(needle);
    });

    if (partial.length > 0) {
      return { model: partial[0], matches: partial, suggestions: [] };
    }

    return { matches: [], suggestions: Models.suggestionsFor(needle, models) };
  }

  static async resolve(registry: unknown, query: string): Promise<Resolution> {
    const models = await Models.list(registry);

    return Models.resolveIn(models, query);
  }
}

export class ModelCatalog {
  #registry: unknown;
  #cache: AgentModel[] | null;

  constructor(registry: unknown) {
    this.#registry = registry;
    this.#cache = null;
  }

  async list(): Promise<AgentModel[]> {
    if (this.#cache) {
      return this.#cache;
    }

    this.#cache = await Models.list(this.#registry);

    return this.#cache;
  }

  async resolve(query: string): Promise<Resolution> {
    return Models.resolveIn(await this.list(), query);
  }

  invalidate(): void {
    this.#cache = null;
  }
}
