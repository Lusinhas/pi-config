import { asThinking, isRecord, THINKING_LEVELS, type ThinkingLevel } from "./models.ts";

export type EffortLevel = ThinkingLevel | "max";

export interface EffortCompletion {
  value: string;
  label: string;
}

export interface EffortPorts {
  getThinkingLevel: () => unknown;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

export const LADDER: readonly EffortLevel[] = [...THINKING_LEVELS, "max"];

export const DESCRIPTIONS: Record<EffortLevel, string> = {
  off: "no extended reasoning",
  minimal: "fastest, minimal reasoning",
  low: "light reasoning for simple tasks",
  medium: "balanced reasoning for everyday work",
  high: "deep reasoning for hard problems",
  xhigh: "the model's highest reasoning level",
  max: "xhigh plus the thinking budget forced to its configured ceiling"
};

export const MAX_TOKENS_HEADROOM = 8192;

export class Ladder {
  static step(current: EffortLevel, direction: "up" | "down"): EffortLevel | undefined {
    const index = LADDER.indexOf(current);
    const next = direction === "up" ? Math.min(LADDER.length - 1, index + 1) : Math.max(0, index - 1);

    if (next === index) {
      return undefined;
    }

    return LADDER[next];
  }

  static completions(prefix: string): EffortCompletion[] | null {
    const needle = prefix.trim().toLowerCase();
    const items: EffortCompletion[] = [
      ...LADDER.map(level => ({ value: level as string, label: `${level} — ${DESCRIPTIONS[level]}` })),
      { value: "up", label: "up — step the effort one level higher" },
      { value: "down", label: "down — step the effort one level lower" }
    ].filter(item => item.value.startsWith(needle));

    return items.length > 0 ? items : null;
  }
}

export class RequestRewriter {
  #maxBudgetTokens: number;

  constructor(maxBudgetTokens: number) {
    this.#maxBudgetTokens = maxBudgetTokens;
  }

  static isDynamicBudget(value: number): boolean {
    return value < 0;
  }

  rewrite(payload: unknown): Record<string, unknown> | undefined {
    if (!isRecord(payload)) {
      return undefined;
    }

    const body = payload;
    const next: Record<string, unknown> = { ...body };
    let changed = false;

    if (isRecord(body.thinking) && typeof body.thinking.budget_tokens === "number") {
      const budget = Math.max(body.thinking.budget_tokens, this.#maxBudgetTokens);

      if (budget !== body.thinking.budget_tokens) {
        next.thinking = { ...body.thinking, budget_tokens: budget };

        if (typeof body.max_tokens === "number" && body.max_tokens <= budget) {
          next.max_tokens = budget + MAX_TOKENS_HEADROOM;
        }

        changed = true;
      }
    }

    if (isRecord(body.generationConfig) && isRecord(body.generationConfig.thinkingConfig)) {
      const thinkingConfig = body.generationConfig.thinkingConfig;
      const current = thinkingConfig.thinkingBudget;

      if (typeof current === "number" && !RequestRewriter.isDynamicBudget(current) && current < this.#maxBudgetTokens) {
        next.generationConfig = {
          ...body.generationConfig,
          thinkingConfig: { ...thinkingConfig, thinkingBudget: this.#maxBudgetTokens }
        };
        changed = true;
      }
    }

    return changed ? next : undefined;
  }
}

export class Effort {
  static readonly LADDER = LADDER;
  static readonly DESCRIPTIONS = DESCRIPTIONS;

  #maxBudgetTokens: number;
  #rewriter: RequestRewriter;
  #maxActive: boolean;
  #applying: boolean;

  constructor(maxBudgetTokens: number) {
    this.#maxBudgetTokens = maxBudgetTokens;
    this.#rewriter = new RequestRewriter(maxBudgetTokens);
    this.#maxActive = false;
    this.#applying = false;
  }

  static isDynamicBudget(value: number): boolean {
    return RequestRewriter.isDynamicBudget(value);
  }

  currentLevel(getThinkingLevel: () => unknown): EffortLevel {
    const level = asThinking(getThinkingLevel()) ?? "medium";

    return this.#maxActive && level === "xhigh" ? "max" : level;
  }

  summary(getThinkingLevel: () => unknown): string {
    const active = this.currentLevel(getThinkingLevel);
    const lines = [`reasoning effort: ${active} (${DESCRIPTIONS[active]})`, ""];

    for (const level of LADDER) {
      const marker = level === active ? "›" : " ";

      lines.push(`${marker} ${level.padEnd(7)} ${DESCRIPTIONS[level]}`);
    }

    lines.push("");
    lines.push(
      `Usage: /effort <level>, /effort up, /effort down. max raises token-budget providers to ${this.#maxBudgetTokens} thinking tokens.`
    );

    return lines.join("\n");
  }

  apply(target: EffortLevel, ports: EffortPorts): boolean {
    const thinking: ThinkingLevel = target === "max" ? "xhigh" : target;
    this.#applying = true;

    try {
      ports.setThinkingLevel(thinking);
    } catch {
      return false;
    } finally {
      this.#applying = false;
    }

    if (asThinking(ports.getThinkingLevel()) !== thinking) {
      return false;
    }

    this.#maxActive = target === "max";

    return true;
  }

  step(current: EffortLevel, direction: "up" | "down"): EffortLevel | undefined {
    return Ladder.step(current, direction);
  }

  describeLevel(level: EffortLevel): string {
    return DESCRIPTIONS[level];
  }

  completions(prefix: string): EffortCompletion[] | null {
    return Ladder.completions(prefix);
  }

  onThinkingSelect(): void {
    if (!this.#applying) {
      this.#maxActive = false;
    }
  }

  rewriteRequest(payload: unknown): Record<string, unknown> | undefined {
    if (!this.#maxActive) {
      return undefined;
    }

    return this.#rewriter.rewrite(payload);
  }
}
