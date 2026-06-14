import { describe, expect, test } from "bun:test";
import { Config, type PlanConfig } from "../../src/plan/settings.ts";
import type { PlanState } from "../../src/plan/index.ts";
import { Detector, Review, type ReviewHost } from "../../src/plan/review.ts";

function planConfig(over: Partial<PlanConfig["review"]> = {}): PlanConfig {
  return { ...Config.DEFAULTS, review: { ...Config.DEFAULTS.review, ...over } };
}

const LONG = "x".repeat(80);

describe("Detector.escapeRegExp", () => {
  test("escapes regex metacharacters", () => {
    expect(Detector.escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
    expect(Detector.escapeRegExp("(plan)")).toBe("\\(plan\\)");
  });
});

describe("Detector.extractAssistantText", () => {
  test("returns empty for non-objects", () => {
    expect(Detector.extractAssistantText(null)).toBe("");
    expect(Detector.extractAssistantText("hi")).toBe("");
    expect(Detector.extractAssistantText(7)).toBe("");
  });

  test("returns empty when role is present and not assistant", () => {
    expect(Detector.extractAssistantText({ role: "user", content: "hi" })).toBe("");
  });

  test("accepts assistant role and missing role with string content", () => {
    expect(Detector.extractAssistantText({ role: "assistant", content: "  hi  " })).toBe("hi");
    expect(Detector.extractAssistantText({ content: "  hi  " })).toBe("hi");
  });

  test("joins text blocks and ignores non-text and malformed blocks", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "one" },
        { type: "image", text: "skip" },
        null,
        "not-an-object",
        { type: "text", text: "two" },
      ],
    };

    expect(Detector.extractAssistantText(message)).toBe("one\ntwo");
  });

  test("returns empty for non-array, non-string content", () => {
    expect(Detector.extractAssistantText({ role: "assistant", content: 42 })).toBe("");
  });
});

describe("Detector.looksLikePlan", () => {
  test("is false below the minimum length", () => {
    const detector = new Detector(planConfig());

    expect(detector.looksLikePlan("short")).toBe(false);
  });

  test("is true when a markdown heading is present", () => {
    const detector = new Detector(planConfig({ keywords: [] }));

    expect(detector.looksLikePlan("## Steps\n" + LONG)).toBe(true);
  });

  test("matches a keyword as a whole word case-insensitively", () => {
    const detector = new Detector(planConfig({ keywords: ["plan"] }));

    expect(detector.looksLikePlan("Here is the PLAN to follow. " + LONG)).toBe(true);
  });

  test("does not match a keyword embedded inside another word", () => {
    const detector = new Detector(planConfig({ keywords: ["plan"] }));
    const text = ("planetarium ".repeat(8)).padEnd(80, "z");

    expect(text.length).toBeGreaterThanOrEqual(80);
    expect(detector.looksLikePlan(text)).toBe(false);
  });

  test("ignores empty and whitespace keywords", () => {
    const detector = new Detector(planConfig({ keywords: ["", "  "] }));

    expect(detector.looksLikePlan("just prose without headings " + LONG)).toBe(false);
  });

  test("is false when long enough but matches nothing", () => {
    const detector = new Detector(planConfig({ keywords: ["plan"] }));

    expect(detector.looksLikePlan("just prose without the magic word " + LONG)).toBe(false);
  });
});

class FakeHost implements ReviewHost {
  selectReturn: string | undefined = undefined;
  inputReturn: string | undefined = undefined;
  isActive = true;
  hasUiFlag = true;
  activeChecksReturnFalseAfter = -1;

  readonly log: string[] = [];
  approvedText: string | undefined;
  refineFeedback: string | undefined;
  private activeCalls = 0;

  hasUI(): boolean {
    return this.hasUiFlag;
  }

  active(): boolean {
    this.activeCalls += 1;

    if (this.activeChecksReturnFalseAfter >= 0 && this.activeCalls > this.activeChecksReturnFalseAfter) {
      return false;
    }

    return this.isActive;
  }

  async select(): Promise<string | undefined> {
    this.log.push("select");

    return this.selectReturn;
  }

  async input(): Promise<string | undefined> {
    this.log.push("input");

    return this.inputReturn;
  }

  appendApproved(text: string): void {
    this.log.push("appendApproved");
    this.approvedText = text;
  }

  async exit(): Promise<void> {
    this.log.push("exit");
  }

  sendApprove(): void {
    this.log.push("sendApprove");
  }

  sendRefine(feedback: string): void {
    this.log.push("sendRefine");
    this.refineFeedback = feedback;
  }
}

function activeState(): PlanState {
  return { active: true, snapshot: [], gated: [], reviewing: false };
}

const PLAN_TEXT = "Here is the plan we will follow to complete the task. " + LONG;

describe("Review.reviewTurn gating", () => {
  test("does nothing when state is inactive", async () => {
    const host = new FakeHost();
    const state: PlanState = { active: false, snapshot: [], gated: [], reviewing: false };
    const review = new Review(host, state, planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual([]);
  });

  test("does nothing while already reviewing", async () => {
    const host = new FakeHost();
    const state: PlanState = { active: true, snapshot: [], gated: [], reviewing: true };
    const review = new Review(host, state, planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual([]);
  });

  test("does nothing when review is disabled", async () => {
    const host = new FakeHost();
    const review = new Review(host, activeState(), { ...planConfig(), review: { ...planConfig().review, enabled: false } });

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual([]);
  });

  test("does nothing without UI", async () => {
    const host = new FakeHost();
    host.hasUiFlag = false;
    const review = new Review(host, activeState(), planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual([]);
  });

  test("does nothing when tool results are present", async () => {
    const host = new FakeHost();
    const review = new Review(host, activeState(), planConfig());

    await review.reviewTurn({
      message: { role: "assistant", content: PLAN_TEXT },
      toolResults: [{ id: 1 }],
    });

    expect(host.log).toEqual([]);
  });

  test("does nothing when the text does not look like a plan", async () => {
    const host = new FakeHost();
    const review = new Review(host, activeState(), planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: "short" } });

    expect(host.log).toEqual([]);
  });
});

describe("Review.reviewTurn dispatch", () => {
  test("approve appends, exits, then sends the approve steer", async () => {
    const host = new FakeHost();
    host.selectReturn = "approve";
    const state = activeState();
    const review = new Review(host, state, planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual(["select", "appendApproved", "exit", "sendApprove"]);
    expect(host.approvedText).toBe(PLAN_TEXT.trim());
    expect(state.reviewing).toBe(false);
  });

  test("refine with non-empty feedback sends a refine follow-up and stays active", async () => {
    const host = new FakeHost();
    host.selectReturn = "refine";
    host.inputReturn = "  add tests  ";
    const review = new Review(host, activeState(), planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual(["select", "input", "sendRefine"]);
    expect(host.refineFeedback).toBe("add tests");
  });

  test("refine with empty feedback sends nothing", async () => {
    const host = new FakeHost();
    host.selectReturn = "refine";
    host.inputReturn = "   ";
    const review = new Review(host, activeState(), planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual(["select", "input"]);
  });

  test("discard exits without sending a message", async () => {
    const host = new FakeHost();
    host.selectReturn = "discard";
    const review = new Review(host, activeState(), planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual(["select", "exit"]);
  });

  test("bails after select if plan mode was turned off mid-dialog", async () => {
    const host = new FakeHost();
    host.selectReturn = "approve";
    host.activeChecksReturnFalseAfter = 0;
    const review = new Review(host, activeState(), planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual(["select"]);
  });

  test("bails after refine input if plan mode was turned off mid-dialog", async () => {
    const host = new FakeHost();
    host.selectReturn = "refine";
    host.inputReturn = "feedback";
    host.activeChecksReturnFalseAfter = 1;
    const review = new Review(host, activeState(), planConfig());

    await review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } });

    expect(host.log).toEqual(["select", "input"]);
  });

  test("resets reviewing to false even when the host throws", async () => {
    const host = new FakeHost();
    host.select = async () => {
      throw new Error("boom");
    };
    const state = activeState();
    const review = new Review(host, state, planConfig());

    await expect(review.reviewTurn({ message: { role: "assistant", content: PLAN_TEXT } })).rejects.toThrow("boom");
    expect(state.reviewing).toBe(false);
  });
});
