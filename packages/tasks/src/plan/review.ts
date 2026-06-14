import type { PlanConfig } from "./settings.ts";
import type { PlanState } from "./index.ts";

const HEADING = /^\s{0,3}#{1,6}\s+\S/m;
const EXTRACT_LIMIT = 65536;

export class Detector {
  private readonly keywordPatterns: RegExp[];

  constructor(private readonly config: PlanConfig) {
    this.keywordPatterns = Detector.compileKeywords(config.review.keywords);
  }

  static escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  static compileKeywords(keywords: string[]): RegExp[] {
    const patterns: RegExp[] = [];

    for (const keyword of keywords) {
      const trimmed = keyword.trim();

      if (trimmed.length === 0) {
        continue;
      }

      patterns.push(new RegExp("\\b" + Detector.escapeRegExp(trimmed) + "\\b", "i"));
    }

    return patterns;
  }

  static extractAssistantText(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    const record = message as { role?: unknown; content?: unknown };

    if (typeof record.role === "string" && record.role !== "assistant") {
      return "";
    }

    const content = record.content;

    if (typeof content === "string") {
      return content.slice(0, EXTRACT_LIMIT).trim();
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const parts: string[] = [];
    let budget = EXTRACT_LIMIT;

    for (const block of content) {
      if (budget <= 0) {
        break;
      }

      if (!block || typeof block !== "object") {
        continue;
      }

      const piece = block as { type?: unknown; text?: unknown };

      if (piece.type === "text" && typeof piece.text === "string") {
        const slice = piece.text.slice(0, budget);
        budget -= slice.length;
        parts.push(slice);
      }
    }

    return parts.join("\n").trim();
  }

  looksLikePlan(text: string): boolean {
    if (text.length < this.config.review.minLength) {
      return false;
    }

    if (HEADING.test(text)) {
      return true;
    }

    for (const pattern of this.keywordPatterns) {
      if (pattern.test(text)) {
        return true;
      }
    }

    return false;
  }
}

export interface ReviewHost {
  hasUI(): boolean;
  active(): boolean;
  select(title: string, options: string[], timeoutMs: number): Promise<string | undefined>;
  input(title: string, placeholder: string): Promise<string | undefined>;
  appendApproved(text: string): void;
  exit(): Promise<void>;
  sendApprove(): void;
  sendRefine(feedback: string): void;
}

export class Dispatcher {
  constructor(private readonly host: ReviewHost) {}

  async dispatch(choice: string | undefined, text: string): Promise<void> {
    if (choice === "approve") {
      this.host.appendApproved(text);
      await this.host.exit();
      this.host.sendApprove();

      return;
    }

    if (choice === "refine") {
      const feedback = await this.host.input("Refine the plan", "Describe what should change");

      if (!this.host.active()) {
        return;
      }

      const trimmed = typeof feedback === "string" ? feedback.trim() : "";

      if (trimmed.length > 0) {
        this.host.sendRefine(trimmed);
      }

      return;
    }

    if (choice === "discard") {
      await this.host.exit();
    }
  }
}

export class Review {
  private readonly detector: Detector;
  private readonly dispatcher: Dispatcher;

  constructor(
    private readonly host: ReviewHost,
    private readonly state: PlanState,
    private readonly config: PlanConfig,
  ) {
    this.detector = new Detector(config);
    this.dispatcher = new Dispatcher(host);
  }

  private shouldReview(payload: { message?: unknown; toolResults?: unknown }): string | undefined {
    if (!this.state.active || this.state.reviewing) {
      return undefined;
    }

    if (!this.config.review.enabled) {
      return undefined;
    }

    if (!this.host.hasUI()) {
      return undefined;
    }

    if (Array.isArray(payload.toolResults) && payload.toolResults.length > 0) {
      return undefined;
    }

    const text = Detector.extractAssistantText(payload.message);

    if (!this.detector.looksLikePlan(text)) {
      return undefined;
    }

    return text;
  }

  async reviewTurn(payload: { message?: unknown; toolResults?: unknown }): Promise<void> {
    const text = this.shouldReview(payload);

    if (text === undefined) {
      return;
    }

    this.state.reviewing = true;

    try {
      const choice = await this.host.select(
        "Plan mode: review the proposed plan",
        ["approve", "refine", "discard"],
        this.config.review.timeoutMs,
      );

      if (!this.host.active()) {
        return;
      }

      await this.dispatcher.dispatch(choice, text);
    } finally {
      this.state.reviewing = false;
    }
  }
}
