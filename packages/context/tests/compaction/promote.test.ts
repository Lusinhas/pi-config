import { describe, expect, test } from "bun:test";
import { Promotion, TurnCoordinator } from "../../src/compaction/promote.ts";

function model(id: string, provider: string, contextWindow: number, name = ""): Record<string, unknown> {
  return { id, provider, contextWindow, name };
}

describe("model field accessors", () => {
  test("read reflective fields with safe fallbacks", () => {
    const promotion = new Promotion([], true);

    expect(promotion.idOf(model("m", "p", 100))).toBe("m");
    expect(promotion.providerOf({ provider: 5 })).toBe("");
    expect(promotion.windowOf({ contextWindow: Number.NaN })).toBe(0);
    expect(promotion.nameOf({ name: "Big" })).toBe("Big");
  });
});

describe("matchesRef", () => {
  const promotion = new Promotion([], true);
  const m = model("gpt-5", "openai", 400000, "GPT 5");

  test("matches id, provider/id, and name case-insensitively", () => {
    expect(promotion.matchesRef(m, "GPT-5")).toBe(true);
    expect(promotion.matchesRef(m, " openai/gpt-5 ")).toBe(true);
    expect(promotion.matchesRef(m, "gpt 5")).toBe(true);
    expect(promotion.matchesRef(m, "claude")).toBe(false);
  });

  test("empty name never matches the name branch", () => {
    expect(promotion.matchesRef(model("x", "p", 1, ""), "")).toBe(false);
  });
});

describe("ladderCandidates", () => {
  test("resolves refs to larger-window models, sorted ascending by window", () => {
    const promotion = new Promotion(["openai/huge", "openai/mid"], true);
    const current = model("small", "openai", 100000);
    const available = [model("mid", "openai", 200000), model("huge", "openai", 800000), current];
    const candidates = promotion.ladderCandidates(current, available).map((c) => promotion.idOf(c));

    expect(candidates).toEqual(["mid", "huge"]);
  });

  test("excludes models not larger than current and the current model itself", () => {
    const promotion = new Promotion(["openai/same", "openai/smaller", "openai/bigger"], true);
    const current = model("same", "openai", 200000);
    const available = [current, model("smaller", "openai", 100000), model("bigger", "openai", 300000)];
    const candidates = promotion.ladderCandidates(current, available).map((c) => promotion.idOf(c));

    expect(candidates).toEqual(["bigger"]);
  });

  test("dedupes models that match multiple refs", () => {
    const promotion = new Promotion(["openai/big", "big"], true);
    const current = model("small", "openai", 100000);
    const available = [current, model("big", "openai", 500000)];

    expect(promotion.ladderCandidates(current, available)).toHaveLength(1);
  });

  test("stable order by declaration index when windows tie", () => {
    const promotion = new Promotion(["openai/b", "openai/a"], true);
    const current = model("small", "openai", 100000);
    const available = [model("a", "openai", 300000), model("b", "openai", 300000), current];
    const candidates = promotion.ladderCandidates(current, available).map((c) => promotion.idOf(c));

    expect(candidates).toEqual(["b", "a"]);
  });

  test("disabled promotion or empty ladder yields no candidates", () => {
    const current = model("small", "openai", 100000);
    const available = [model("big", "openai", 500000)];

    expect(new Promotion(["openai/big"], false).ladderCandidates(current, available)).toEqual([]);
    expect(new Promotion([], true).ladderCandidates(current, available)).toEqual([]);
  });

  test("no current model yields no candidates", () => {
    const promotion = new Promotion(["openai/big"], true);

    expect(promotion.ladderCandidates(null, [model("big", "openai", 500000)])).toEqual([]);
  });
});

describe("notices", () => {
  const promotion = new Promotion([], true);

  test("promoted notice includes provider/id and localized window", () => {
    const notice = promotion.promotedNotice(model("gpt-5", "openai", 400000), 92);

    expect(notice).toContain("Context at 92% — promoted to openai/gpt-5");
    expect(notice).toContain((400000).toLocaleString());
    expect(notice).toContain("restored on /handoff or a new session");
  });

  test("restored and fallback notices", () => {
    expect(promotion.restoredNotice(model("m", "p", 1))).toBe("Context promotion reverted: restored p/m");
    expect(promotion.fallbackNotice(95)).toContain("Context at 95% but no promotion ladder model could be activated");
  });
});

describe("TurnCoordinator", () => {
  function build(): { coordinator: TurnCoordinator; current: Record<string, unknown>; available: Record<string, unknown>[] } {
    const promotion = new Promotion(["openai/big"], true);
    const current = model("small", "openai", 100000);
    const available = [current, model("big", "openai", 500000)];

    return { coordinator: new TurnCoordinator(promotion, 85, 90), current, available };
  }

  test("planPromotion fires when usage crosses promotePct and candidates exist", () => {
    const { coordinator, current, available } = build();
    const plan = coordinator.planPromotion({ percent: 91 }, current, available, 0);

    expect(plan).toBeDefined();
    expect(plan?.pct).toBe(91);
    expect(plan?.candidates.map((c) => (c as { id: string }).id)).toEqual(["big"]);
  });

  test("planPromotion is undefined below threshold or when disabled", () => {
    const { coordinator, current, available } = build();

    expect(coordinator.planPromotion({ percent: 80 }, current, available, 0)).toBeUndefined();
    const disabled = new TurnCoordinator(new Promotion(["openai/big"], true), 85, 0);
    expect(disabled.planPromotion({ percent: 99 }, current, available, 0)).toBeUndefined();
  });

  test("shouldPreempt blocked while promotion headroom exists", () => {
    const { coordinator, current, available } = build();

    expect(coordinator.shouldPreempt({ percent: 99 }, current, available, 0)).toBe(false);
  });

  test("shouldPreempt fires when no headroom and over threshold", () => {
    const promotion = new Promotion([], true);
    const coordinator = new TurnCoordinator(promotion, 85, 90);
    const current = model("small", "openai", 100000);

    expect(coordinator.shouldPreempt({ percent: 88 }, current, [current], 0)).toBe(true);
  });

  test("preempt cooldown suppresses re-entry within the window", () => {
    const promotion = new Promotion([], true);
    const coordinator = new TurnCoordinator(promotion, 85, 90);
    const current = model("small", "openai", 100000);

    expect(coordinator.shouldPreempt({ percent: 88 }, current, [current], 0)).toBe(true);
    coordinator.startPreempt(0, 88);
    expect(coordinator.shouldPreempt({ percent: 88 }, current, [current], 1000)).toBe(false);
    expect(coordinator.shouldPreempt({ percent: 88 }, current, [current], TurnCoordinator.preemptCooldownMs + 1)).toBe(true);
    coordinator.finishPreempt();
    expect(coordinator.shouldPreempt({ percent: 88 }, current, [current], 2000)).toBe(true);
  });

  test("shouldPreempt ignores missing or null usage percent", () => {
    const promotion = new Promotion([], true);
    const coordinator = new TurnCoordinator(promotion, 85, 90);
    const current = model("small", "openai", 100000);

    expect(coordinator.shouldPreempt(null, current, [current], 0)).toBe(false);
    expect(coordinator.shouldPreempt({ percent: null }, current, [current], 0)).toBe(false);
  });

  test("disabled preempt percent never fires", () => {
    const coordinator = new TurnCoordinator(new Promotion([], true), 0, 90);
    const current = model("small", "openai", 100000);

    expect(coordinator.shouldPreempt({ percent: 99 }, current, [current], 0)).toBe(false);
  });
});
