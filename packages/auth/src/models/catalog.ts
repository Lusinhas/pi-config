export interface ModelOverride {
  readonly exclude?: readonly string[];
  readonly add?: readonly string[];
  readonly longContext?: boolean;
  readonly disableEffort?: boolean;
  readonly adaptiveThinking?: boolean;
}

export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export const LONG_CONTEXT_BETA = "context-1m-2025-08-07";

export class ModelCatalog {
  readonly ccVersion = "2.1.112";

  private readonly baseBetas: readonly string[] = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
  ];

  private readonly longContextBetas: readonly string[] = [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
  ];

  private readonly modelOverrides: ReadonlyArray<[string, ModelOverride]> = [
    ["haiku", { exclude: ["interleaved-thinking-2025-05-14"], disableEffort: true }],
    ["4-6", { longContext: true, add: ["effort-2025-11-24"] }],
    ["4-7", { longContext: true, add: ["effort-2025-11-24"], adaptiveThinking: true }],
    ["4-8", { longContext: true, add: ["effort-2025-11-24"], adaptiveThinking: true }],
  ];

  models(): CatalogModel[] {
    return [
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8 (Claude Code)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7 (Claude Code)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (Claude Code)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5 (Claude Code)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ];
  }

  getOverride(modelId: string): ModelOverride | null {
    const lower = modelId.toLowerCase();

    for (const [pattern, override] of this.modelOverrides) {
      if (lower.includes(pattern)) {
        return override;
      }
    }

    return null;
  }

  computeBetas(modelId: string): string[] {
    const override = this.getOverride(modelId);
    let betas = [...this.baseBetas];

    if (override?.longContext) {
      betas = [...betas, ...this.longContextBetas];
    }

    if (override?.exclude) {
      betas = betas.filter((b) => !override.exclude!.includes(b));
    }

    if (override?.add) {
      betas = [...betas, ...override.add];
    }

    return Array.from(new Set(betas));
  }

  requestBetas(modelId: string, longContext: boolean): string[] {
    const betas = this.computeBetas(modelId);

    return longContext ? betas : betas.filter((b) => b !== LONG_CONTEXT_BETA);
  }
}
