export interface ReviewConfig {
  enabled: boolean;
  timeoutMs: number;
  minLength: number;
  keywords: string[];
}

export interface PlanConfig {
  readonlyTools: string[];
  extraAllowed: string[];
  blockedTools: string[];
  systemPrompt: string;
  blockReason: string;
  statusText: string;
  showWidget: boolean;
  approveMessage: string;
  refinePrefix: string;
  review: ReviewConfig;
}

export class Config {
  static readonly DEFAULTS: PlanConfig = {
    readonlyTools: ["read", "grep", "find", "ls"],
    extraAllowed: ["websearch", "webfetch", "astsearch", "history", "task", "advisor"],
    blockedTools: ["write", "edit", "bash"],
    systemPrompt:
      "You are in plan mode. Explore the codebase and design an approach, but do not modify files, create files, or run anything that changes the workspace. Work only with the read-only tools currently available. Finish your response by presenting a concrete implementation plan as a numbered list under a 'Plan' heading, then stop and wait for approval.",
    blockReason:
      "Plan mode is active: this tool can modify the workspace and is blocked. Keep exploring with read-only tools and finish by presenting a plan.",
    statusText: "plan",
    showWidget: true,
    approveMessage:
      "The plan you presented has been approved. Plan mode is off and full tool access is restored. Implement the approved plan now, following its steps in order.",
    refinePrefix:
      "The plan needs revision before approval. Stay in plan mode, do not modify files, and present an updated plan that addresses this feedback: ",
    review: {
      enabled: true,
      timeoutMs: 120000,
      minLength: 80,
      keywords: ["plan"],
    },
  };

  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static deepMerge(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = out[key];

      if (Config.isRecord(current) && Config.isRecord(value)) {
        out[key] = Config.deepMerge(current, value);

        continue;
      }

      if (value !== undefined) {
        out[key] = value;
      }
    }

    return out;
  }

  static stringList(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
      return [...fallback];
    }

    const out: string[] = [];

    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }

      const trimmed = item.trim();

      if (trimmed.length > 0 && !out.includes(trimmed)) {
        out.push(trimmed);
      }
    }

    return out;
  }

  static text(value: unknown, fallback: string): string {
    return typeof value === "string" && value.length > 0 ? value : fallback;
  }

  static flag(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  static count(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  static fromRaw(
    shipped: Record<string, unknown> | null,
    global: Record<string, unknown> | null,
    project: Record<string, unknown> | null,
  ): PlanConfig {
    let merged: Record<string, unknown> = {};

    if (Config.isRecord(shipped)) {
      merged = Config.deepMerge(merged, shipped);
    }

    if (global !== null && Config.isRecord(global.plan)) {
      merged = Config.deepMerge(merged, global.plan);
    }

    if (project !== null && Config.isRecord(project.plan)) {
      merged = Config.deepMerge(merged, project.plan);
    }

    return new Config(merged).normalized;
  }

  readonly normalized: PlanConfig;

  constructor(merged: Record<string, unknown>) {
    const defaults = Config.DEFAULTS;
    const review = Config.isRecord(merged.review) ? merged.review : {};

    this.normalized = {
      readonlyTools: Config.stringList(merged.readonlyTools, defaults.readonlyTools),
      extraAllowed: Config.stringList(merged.extraAllowed, defaults.extraAllowed),
      blockedTools: Config.stringList(merged.blockedTools, defaults.blockedTools),
      systemPrompt: Config.text(merged.systemPrompt, defaults.systemPrompt),
      blockReason: Config.text(merged.blockReason, defaults.blockReason),
      statusText: Config.text(merged.statusText, defaults.statusText),
      showWidget: Config.flag(merged.showWidget, defaults.showWidget),
      approveMessage: Config.text(merged.approveMessage, defaults.approveMessage),
      refinePrefix: Config.text(merged.refinePrefix, defaults.refinePrefix),
      review: {
        enabled: Config.flag(review.enabled, defaults.review.enabled),
        timeoutMs: Config.count(review.timeoutMs, defaults.review.timeoutMs),
        minLength: Config.count(review.minLength, defaults.review.minLength),
        keywords: Config.stringList(review.keywords, defaults.review.keywords),
      },
    };
  }
}
