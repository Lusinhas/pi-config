import { Buffer } from "node:buffer";

export interface PromotionConfig {
  enabled: boolean;
  ladder: string[];
}

export interface CompactionConfig {
  strategy: string;
  dropOverBytes: number;
  keepRecentTokens: number;
  preemptPct: number;
  promotePct: number;
  shakeOverBytes: number;
  handoffPath: string;
  handoffChars: number;
  handoffMaxTokens: number;
  promotion: PromotionConfig;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

export function isActivePercent(value: number): boolean {
  return value > 0 && value < 100;
}

export class Config {
  private readonly defaults: CompactionConfig;

  constructor(shipped: Record<string, unknown>) {
    this.defaults = this.normalize(shipped, Config.hardDefaults());
  }

  static hardDefaults(): CompactionConfig {
    return {
      strategy: "supersede",
      dropOverBytes: 20480,
      keepRecentTokens: 20000,
      preemptPct: 85,
      promotePct: 90,
      shakeOverBytes: 10240,
      handoffPath: ".pi/handoff.md",
      handoffChars: 60000,
      handoffMaxTokens: 4096,
      promotion: {
        enabled: true,
        ladder: [],
      },
    };
  }

  resolve(overrides: ReadonlyArray<Record<string, unknown>>): CompactionConfig {
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

  private normalize(raw: Record<string, unknown>, fallback: CompactionConfig): CompactionConfig {
    return {
      strategy: stringOr(raw.strategy, fallback.strategy),
      dropOverBytes: numberOr(raw.dropOverBytes, fallback.dropOverBytes),
      keepRecentTokens: numberOr(raw.keepRecentTokens, fallback.keepRecentTokens),
      preemptPct: numberOr(raw.preemptPct, fallback.preemptPct),
      promotePct: numberOr(raw.promotePct, fallback.promotePct),
      shakeOverBytes: numberOr(raw.shakeOverBytes, fallback.shakeOverBytes),
      handoffPath: stringOr(raw.handoffPath, fallback.handoffPath),
      handoffChars: numberOr(raw.handoffChars, fallback.handoffChars),
      handoffMaxTokens: numberOr(raw.handoffMaxTokens, fallback.handoffMaxTokens),
      promotion: this.normalizePromotion(raw.promotion, fallback.promotion),
    };
  }

  private normalizePromotion(value: unknown, fallback: PromotionConfig): PromotionConfig {
    const source = isRecord(value) ? value : {};
    const enabled = typeof source.enabled === "boolean" ? source.enabled : fallback.enabled;
    const ladder = Array.isArray(source.ladder)
      ? source.ladder.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];

    return { enabled, ladder };
  }

  private toRecord(config: CompactionConfig): Record<string, unknown> {
    return {
      strategy: config.strategy,
      dropOverBytes: config.dropOverBytes,
      keepRecentTokens: config.keepRecentTokens,
      preemptPct: config.preemptPct,
      promotePct: config.promotePct,
      shakeOverBytes: config.shakeOverBytes,
      handoffPath: config.handoffPath,
      handoffChars: config.handoffChars,
      handoffMaxTokens: config.handoffMaxTokens,
      promotion: { enabled: config.promotion.enabled, ladder: [...config.promotion.ladder] },
    };
  }
}

export interface ToolResultLike {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown[];
  isError: boolean;
}

export type ToolResultMessage = ToolResultLike & Record<string, unknown>;

export class Messages {
  isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  isToolResult(message: unknown): message is ToolResultMessage {
    return (
      this.isRecord(message) &&
      message.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      typeof message.toolName === "string" &&
      Array.isArray(message.content)
    );
  }

  messageOf(entry: unknown): Record<string, unknown> | undefined {
    if (!this.isRecord(entry) || entry.type !== "message") {
      return undefined;
    }

    return this.isRecord(entry.message) ? entry.message : undefined;
  }

  contentBytes(content: unknown): number {
    if (typeof content === "string") {
      return Buffer.byteLength(content, "utf8");
    }

    if (!Array.isArray(content)) {
      return 0;
    }

    let total = 0;

    for (const block of content) {
      if (!this.isRecord(block)) {
        continue;
      }

      if (block.type === "text" && typeof block.text === "string") {
        total += Buffer.byteLength(block.text, "utf8");
      } else if (block.type === "image" && typeof block.data === "string") {
        total += block.data.length;
      } else {
        total += this.estimateTokens(block) * 4;
      }
    }

    return total;
  }

  estimateTokens(value: unknown): number {
    if (typeof value === "string") {
      return Math.ceil(value.length / 4);
    }

    const serialized = this.safeStringify(value);

    return serialized === undefined ? 0 : Math.ceil(serialized.length / 4);
  }

  textOfContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const parts: string[] = [];

    for (const block of content) {
      if (!this.isRecord(block)) {
        continue;
      }

      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "image") {
        parts.push("[image]");
      }
    }

    return parts.join("\n");
  }

  safeStringify(value: unknown): string | undefined {
    try {
      const serialized = JSON.stringify(value);

      return serialized === undefined ? undefined : serialized;
    } catch {
      return undefined;
    }
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes}B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)}KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}
