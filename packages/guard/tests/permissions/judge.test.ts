import { describe, expect, test } from "bun:test";
import { Judge } from "../../src/permissions/judge.ts";
import type { JudgeConfig } from "../../src/permissions/loader.ts";

const config = (overrides: Partial<JudgeConfig> = {}): JudgeConfig => ({
  enabled: true,
  model: "anthropic/claude-haiku-4-5",
  maxRisk: "safe",
  timeoutMs: 20000,
  maxTokens: 200,
  ...overrides,
});

describe("Judge.riskRank", () => {
  test("safe ranks below risky", () => {
    expect(Judge.riskRank("safe")).toBe(0);
    expect(Judge.riskRank("risky")).toBe(1);
  });
});

describe("Judge.splitModel", () => {
  test("splits on the first slash", () => {
    expect(Judge.splitModel("anthropic/claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
  });

  test("rejects models missing provider or id", () => {
    expect(Judge.splitModel("noslash")).toBeUndefined();
    expect(Judge.splitModel("/leading")).toBeUndefined();
    expect(Judge.splitModel("trailing/")).toBeUndefined();
  });
});

describe("Judge.parseVerdict", () => {
  test("parses a single SAFE line with reason", () => {
    expect(Judge.parseVerdict("SAFE: reads a file")).toEqual({ risk: "safe", reason: "reads a file" });
  });

  test("parses RISKY with leading punctuation", () => {
    expect(Judge.parseVerdict("- RISKY: deletes data")).toEqual({ risk: "risky", reason: "deletes data" });
  });

  test("classification with no reason gets a default reason", () => {
    expect(Judge.parseVerdict("safe")).toEqual({ risk: "safe", reason: "classified as safe" });
  });

  test("empty input is undefined", () => {
    expect(Judge.parseVerdict("")).toBeUndefined();
    expect(Judge.parseVerdict("   \n  ")).toBeUndefined();
  });

  test("fallback detects risky keywords over joined text", () => {
    expect(Judge.parseVerdict("this is\ndangerous stuff")).toEqual({ risk: "risky", reason: "this is" });
    expect(Judge.parseVerdict("not safe at all")).toEqual({ risk: "risky", reason: "not safe at all" });
  });

  test("fallback detects safe keyword", () => {
    expect(Judge.parseVerdict("looks\nperfectly safe here")).toEqual({ risk: "safe", reason: "looks" });
  });

  test("no keyword anywhere is undefined", () => {
    expect(Judge.parseVerdict("unrelated text")).toBeUndefined();
  });
});

describe("Judge.buildRequest", () => {
  test("returns undefined when model lacks a slash", () => {
    expect(Judge.buildRequest("bash", "ls", config({ model: "bad" }))).toBeUndefined();
  });

  test("assembles tool, action, and clamps timeout and tokens", () => {
    const request = Judge.buildRequest("bash", "ls -la", config({ timeoutMs: 10, maxTokens: 1 }));

    expect(request).toBeDefined();
    expect(request?.provider).toBe("anthropic");
    expect(request?.modelId).toBe("claude-haiku-4-5");
    expect(request?.timeoutMs).toBe(1000);
    expect(request?.maxTokens).toBe(16);
    expect(request?.userPrompt).toBe("Tool: bash\nAction:\nls -la");
  });

  test("includes origin and clipped request", () => {
    const longRequest = "x".repeat(700);
    const request = Judge.buildRequest("bash", "ls", config(), { origin: "worker", request: longRequest });

    expect(request?.userPrompt).toContain('Origin: subagent "worker"');
    expect(request?.userPrompt).toContain(`User request:\n${"x".repeat(600)}…`);
  });

  test("clips a long action argument", () => {
    const request = Judge.buildRequest("bash", "y".repeat(5000), config());

    expect(request?.userPrompt).toContain(`Action:\n${"y".repeat(4000)}…`);
  });

  test("empty argument becomes the no-arguments marker", () => {
    const request = Judge.buildRequest("read", "", config());

    expect(request?.userPrompt).toBe("Tool: read\nAction:\n(no arguments)");
  });
});

describe("Judge.buildSignal", () => {
  test("returns a signal that aborts when no outer is given", () => {
    const signal = Judge.buildSignal(1000, undefined);

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("combines outer and timeout signals", () => {
    const controller = new AbortController();
    const signal = Judge.buildSignal(1000, controller.signal);

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("uses the outer signal alone when timeout is unavailable", () => {
    const original = AbortSignal.timeout;

    try {
      (AbortSignal as unknown as { timeout?: unknown }).timeout = undefined;

      const controller = new AbortController();

      expect(Judge.buildSignal(1000, controller.signal)).toBe(controller.signal);
      expect(Judge.buildSignal(1000, undefined)).toBeUndefined();
    } finally {
      (AbortSignal as unknown as { timeout: unknown }).timeout = original;
    }
  });
});
