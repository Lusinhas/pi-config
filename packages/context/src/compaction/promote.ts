import { isActivePercent } from "./index.ts";

export interface ModelFields {
  id?: unknown;
  provider?: unknown;
  name?: unknown;
  contextWindow?: unknown;
}

export class Promotion {
  constructor(
    private readonly ladder: string[],
    private readonly enabled: boolean,
  ) {}

  windowOf(model: unknown): number {
    const fields = model as ModelFields;

    return typeof fields.contextWindow === "number" && Number.isFinite(fields.contextWindow) ? fields.contextWindow : 0;
  }

  idOf(model: unknown): string {
    const fields = model as ModelFields;

    return typeof fields.id === "string" ? fields.id : "";
  }

  providerOf(model: unknown): string {
    const fields = model as ModelFields;

    return typeof fields.provider === "string" ? fields.provider : "";
  }

  nameOf(model: unknown): string {
    const fields = model as ModelFields;

    return typeof fields.name === "string" ? fields.name : "";
  }

  matchesRef(model: unknown, ref: string): boolean {
    const needle = ref.trim().toLowerCase();
    const id = this.idOf(model).toLowerCase();
    const provider = this.providerOf(model).toLowerCase();
    const name = this.nameOf(model).toLowerCase();

    return needle === id || needle === `${provider}/${id}` || (name.length > 0 && needle === name);
  }

  sameModel(a: unknown, b: unknown): boolean {
    return this.idOf(a) === this.idOf(b) && this.providerOf(a) === this.providerOf(b);
  }

  ladderCandidates<M>(current: M | null | undefined, available: M[]): M[] {
    if (!this.enabled || this.ladder.length === 0 || !current) {
      return [];
    }

    const currentWindow = this.windowOf(current);
    const resolved: Array<{ model: M; order: number }> = [];

    for (let order = 0; order < this.ladder.length; order++) {
      const ref = this.ladder[order];
      const match = available.find((model) => this.matchesRef(model, ref));

      if (!match || this.sameModel(match, current) || this.windowOf(match) <= currentWindow) {
        continue;
      }

      if (resolved.some((existing) => this.sameModel(existing.model, match))) {
        continue;
      }

      resolved.push({ model: match, order });
    }

    resolved.sort((a, b) => {
      const byWindow = this.windowOf(a.model) - this.windowOf(b.model);

      return byWindow !== 0 ? byWindow : a.order - b.order;
    });

    return resolved.map((entry) => entry.model);
  }

  liveMatch<M>(original: M, available: M[]): M {
    return available.find((model) => this.sameModel(model, original)) ?? original;
  }

  restoredNotice(original: unknown): string {
    return `Context promotion reverted: restored ${this.providerOf(original)}/${this.idOf(original)}`;
  }

  promotedNotice(candidate: unknown, pct: number): string {
    return `Context at ${pct}% — promoted to ${this.providerOf(candidate)}/${this.idOf(candidate)} (${this.windowOf(candidate).toLocaleString()} token window) instead of compacting; the original model is restored on /handoff or a new session`;
  }

  fallbackNotice(pct: number): string {
    return `Context at ${pct}% but no promotion ladder model could be activated; falling back to compaction`;
  }
}

export interface UsageLike {
  percent?: number | null;
}

export interface PromotionPlan {
  candidates: unknown[];
  current: unknown;
  pct: number;
  promotedNotice: (candidate: unknown) => string;
  fallbackNotice: string;
}

export class TurnCoordinator {
  private preemptInFlight = false;
  private preemptLastAttempt = 0;
  private promoting = false;

  static readonly preemptCooldownMs = 180000;

  constructor(
    private readonly promotion: Promotion,
    private readonly preemptPct: number,
    private readonly promotePct: number,
  ) {}

  private usagePercent(usage: UsageLike | null | undefined): number | undefined {
    if (!usage || usage.percent === null || usage.percent === undefined) {
      return undefined;
    }

    return usage.percent;
  }

  hasPromotionHeadroom(current: unknown, available: unknown[]): boolean {
    try {
      return this.promotion.ladderCandidates(current, available).length > 0;
    } catch {
      return false;
    }
  }

  planPromotion(
    usage: UsageLike | null | undefined,
    current: unknown,
    available: unknown[],
    now: number,
  ): PromotionPlan | undefined {
    if (this.promoting) {
      return undefined;
    }

    this.promoting = true;

    try {
      if (!isActivePercent(this.promotePct)) {
        return undefined;
      }

      const percent = this.usagePercent(usage);

      if (percent === undefined || percent < this.promotePct || !current) {
        return undefined;
      }

      const candidates = this.promotion.ladderCandidates(current, available);

      if (candidates.length === 0) {
        return undefined;
      }

      const pct = Math.round(percent);

      return {
        candidates,
        current,
        pct,
        promotedNotice: (candidate: unknown) => this.promotion.promotedNotice(candidate, pct),
        fallbackNotice: this.promotion.fallbackNotice(pct),
      };
    } finally {
      this.promoting = false;
    }
  }

  shouldPreempt(usage: UsageLike | null | undefined, current: unknown, available: unknown[], now: number): boolean {
    if (!isActivePercent(this.preemptPct)) {
      return false;
    }

    if (this.preemptInFlight && now - this.preemptLastAttempt < TurnCoordinator.preemptCooldownMs) {
      return false;
    }

    const percent = this.usagePercent(usage);

    if (percent === undefined || percent < this.preemptPct) {
      return false;
    }

    if (this.hasPromotionHeadroom(current, available)) {
      return false;
    }

    return true;
  }

  startPreempt(now: number, percent: number): { pct: number; threshold: number } {
    this.preemptInFlight = true;
    this.preemptLastAttempt = now;

    return { pct: Math.round(percent), threshold: this.preemptPct };
  }

  finishPreempt(): void {
    this.preemptInFlight = false;
  }
}
