import { describe, expect, test } from "bun:test";
import { Effort, type EffortPorts } from "../../src/router/effort.ts";
import type { ThinkingLevel } from "../../src/router/models.ts";

function makePorts(initial: ThinkingLevel = "medium", accept = true): { ports: EffortPorts; get: () => ThinkingLevel } {
  let level = initial;
  const ports: EffortPorts = {
    getThinkingLevel: () => level,
    setThinkingLevel: (next: ThinkingLevel) => {
      if (accept) {
        level = next;
      }
    }
  };

  return { ports, get: () => level };
}

describe("Effort.currentLevel", () => {
  test("reports the raw thinking level by default", () => {
    const effort = new Effort(100000);

    expect(effort.currentLevel(() => "high")).toBe("high");
  });

  test("falls back to medium when unrecognized", () => {
    const effort = new Effort(100000);

    expect(effort.currentLevel(() => "weird")).toBe("medium");
  });

  test("reports max only when maxActive and level is xhigh", () => {
    const effort = new Effort(100000);
    const { ports } = makePorts("xhigh");
    effort.apply("max", ports);

    expect(effort.currentLevel(ports.getThinkingLevel)).toBe("max");
  });
});

describe("Effort.apply", () => {
  test("max sets xhigh and activates max", () => {
    const effort = new Effort(100000);
    const { ports, get } = makePorts();

    expect(effort.apply("max", ports)).toBe(true);
    expect(get()).toBe("xhigh");
    expect(effort.currentLevel(ports.getThinkingLevel)).toBe("max");
  });

  test("setting a plain level clears max", () => {
    const effort = new Effort(100000);
    const { ports } = makePorts();
    effort.apply("max", ports);
    effort.apply("low", ports);

    expect(effort.currentLevel(ports.getThinkingLevel)).toBe("low");
  });

  test("returns false when the level is not honored", () => {
    const effort = new Effort(100000);
    const { ports } = makePorts("medium", false);

    expect(effort.apply("xhigh", ports)).toBe(false);
  });

  test("returns false and clears applying when setter throws", () => {
    const effort = new Effort(100000);
    const ports: EffortPorts = {
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => {
        throw new Error("rejected");
      }
    };

    expect(effort.apply("high", ports)).toBe(false);
    effort.onThinkingSelect();
    expect(effort.currentLevel(() => "xhigh")).toBe("xhigh");
  });
});

describe("Effort.step", () => {
  test("steps up and down within the ladder", () => {
    const effort = new Effort(100000);

    expect(effort.step("medium", "up")).toBe("high");
    expect(effort.step("medium", "down")).toBe("low");
    expect(effort.step("high", "up")).toBe("xhigh");
    expect(effort.step("xhigh", "up")).toBe("max");
  });

  test("returns undefined at the boundaries", () => {
    const effort = new Effort(100000);

    expect(effort.step("off", "down")).toBeUndefined();
    expect(effort.step("max", "up")).toBeUndefined();
  });
});

describe("Effort.completions", () => {
  test("filters by prefix over ladder then up/down", () => {
    const effort = new Effort(100000);
    const items = effort.completions("m");

    expect(items?.map(i => i.value)).toEqual(["minimal", "medium", "max"]);
  });

  test("includes up and down", () => {
    const effort = new Effort(100000);

    expect(effort.completions("u")?.map(i => i.value)).toEqual(["up"]);
    expect(effort.completions("d")?.map(i => i.value)).toEqual(["down"]);
  });

  test("empty prefix returns all", () => {
    const effort = new Effort(100000);

    expect(effort.completions("")?.length).toBe(Effort.LADDER.length + 2);
  });

  test("no match returns null", () => {
    const effort = new Effort(100000);

    expect(effort.completions("zzz")).toBeNull();
  });
});

describe("Effort.summary", () => {
  test("renders the active marker and usage line", () => {
    const effort = new Effort(64000);
    const text = effort.summary(() => "high");
    const lines = text.split("\n");

    expect(lines[0]).toBe("reasoning effort: high (deep reasoning for hard problems)");
    expect(lines).toContain("› high    deep reasoning for hard problems");
    expect(lines).toContain("  off     no extended reasoning");
    expect(lines[lines.length - 1]).toBe(
      "Usage: /effort <level>, /effort up, /effort down. max raises token-budget providers to 64000 thinking tokens."
    );
  });
});

describe("Effort.rewriteRequest", () => {
  test("returns undefined when max is not active", () => {
    const effort = new Effort(100000);

    expect(effort.rewriteRequest({ thinking: { budget_tokens: 1000 } })).toBeUndefined();
  });

  function activated(maxBudget: number): Effort {
    const effort = new Effort(maxBudget);
    const { ports } = makePorts("xhigh");
    effort.apply("max", ports);

    return effort;
  }

  test("raises anthropic thinking budget and bumps max_tokens", () => {
    const effort = activated(100000);
    const out = effort.rewriteRequest({ thinking: { budget_tokens: 1000 }, max_tokens: 4096 });

    expect(out).toEqual({ thinking: { budget_tokens: 100000 }, max_tokens: 108192 });
  });

  test("keeps max_tokens when already above budget", () => {
    const effort = activated(100000);
    const out = effort.rewriteRequest({ thinking: { budget_tokens: 1000 }, max_tokens: 200000 });

    expect(out).toEqual({ thinking: { budget_tokens: 100000 }, max_tokens: 200000 });
  });

  test("never lowers an already higher anthropic budget", () => {
    const effort = activated(100000);

    expect(effort.rewriteRequest({ thinking: { budget_tokens: 150000 } })).toBeUndefined();
  });

  test("forces gemini thinkingBudget up to the ceiling", () => {
    const effort = activated(100000);
    const out = effort.rewriteRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 500 } } });

    expect(out).toEqual({ generationConfig: { thinkingConfig: { thinkingBudget: 100000 } } });
  });

  test("leaves the dynamic gemini budget of -1 untouched", () => {
    const effort = activated(100000);

    expect(effort.rewriteRequest({ generationConfig: { thinkingConfig: { thinkingBudget: -1 } } })).toBeUndefined();
  });

  test("leaves a gemini budget already at or above ceiling untouched", () => {
    const effort = activated(100000);

    expect(effort.rewriteRequest({ generationConfig: { thinkingConfig: { thinkingBudget: 100000 } } })).toBeUndefined();
  });

  test("returns undefined when payload has no rewritable shape", () => {
    const effort = activated(100000);

    expect(effort.rewriteRequest({ unrelated: true })).toBeUndefined();
    expect(effort.rewriteRequest("nope")).toBeUndefined();
  });
});

describe("Effort.isDynamicBudget", () => {
  test("negative budgets are dynamic, zero and positive are not", () => {
    expect(Effort.isDynamicBudget(-1)).toBe(true);
    expect(Effort.isDynamicBudget(0)).toBe(false);
    expect(Effort.isDynamicBudget(100)).toBe(false);
  });
});

describe("Effort.onThinkingSelect", () => {
  test("external select clears max", () => {
    const effort = new Effort(100000);
    const { ports } = makePorts("xhigh");
    effort.apply("max", ports);
    effort.onThinkingSelect();

    expect(effort.currentLevel(ports.getThinkingLevel)).toBe("xhigh");
  });
});
