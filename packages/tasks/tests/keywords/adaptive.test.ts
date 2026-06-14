import { describe, expect, test } from "bun:test";
import { Adaptive } from "../../src/keywords/adaptive.ts";

describe("classify", () => {
  test("empty or whitespace returns none", () => {
    expect(Adaptive.classify("")).toBe("none");
    expect(Adaptive.classify("    ")).toBe("none");
  });

  test("short trivial prompt nudges down", () => {
    expect(Adaptive.classify("fix this typo")).toBe("down");
  });

  test("two light words cap the subtraction but still go down with short length", () => {
    expect(Adaptive.classify("quick small minor tweak rename")).toBe("down");
  });

  test("heavy work words nudge up when length penalty does not apply", () => {
    const text =
      "please refactor and audit the whole architecture so the system stays maintainable across the entire codebase for the team";
    expect(Adaptive.classify(text)).toBe("up");
  });

  test("very long prompt nudges up via length", () => {
    const long = "word ".repeat(160);
    expect(Adaptive.classify(long)).toBe("up");
  });

  test("code fences contribute but alone are not enough", () => {
    expect(Adaptive.classify("look ```a``` and ```b```")).toBe("none");
  });

  test("many bullets plus heavy term nudges up", () => {
    const text = "investigate this:\n- one item here\n- two item here\n- three item here\n- four item here";
    expect(Adaptive.classify(text)).toBe("up");
  });

  test("neutral medium prompt returns none", () => {
    expect(Adaptive.classify("update the readme with the new install steps and a usage example for clarity")).toBe(
      "none",
    );
  });

  test("heavy count is capped at 2 yet long heavy prompt still nudges up", () => {
    const text =
      "we should refactor and audit and migrate and redesign and overhaul the architecture so the whole platform improves over time";
    expect(Adaptive.classify(text)).toBe("up");
  });
});

describe("nudgeLevel", () => {
  test("none direction returns undefined", () => {
    expect(Adaptive.nudgeLevel("medium", "none", "low", "high")).toBeUndefined();
  });

  test("up moves one step within bounds", () => {
    expect(Adaptive.nudgeLevel("low", "up", "low", "high")).toBe("medium");
  });

  test("down moves one step within bounds", () => {
    expect(Adaptive.nudgeLevel("high", "down", "low", "high")).toBe("medium");
  });

  test("up beyond max returns undefined", () => {
    expect(Adaptive.nudgeLevel("high", "up", "low", "high")).toBeUndefined();
  });

  test("down below min returns undefined", () => {
    expect(Adaptive.nudgeLevel("low", "down", "low", "high")).toBeUndefined();
  });

  test("up past the end of LEVELS returns undefined", () => {
    expect(Adaptive.nudgeLevel("xhigh", "up", "low", "xhigh")).toBeUndefined();
  });

  test("down past the start of LEVELS returns undefined", () => {
    expect(Adaptive.nudgeLevel("off", "down", "off", "xhigh")).toBeUndefined();
  });
});
