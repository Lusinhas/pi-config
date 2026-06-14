import { describe, expect, test } from "bun:test";
import { Messages } from "../../src/compaction/index.ts";
import { Shake } from "../../src/compaction/strategy.ts";

const messages = new Messages();

function resultEntry(callId: string, text: string, toolName = "bash"): Record<string, unknown> {
  return {
    type: "message",
    message: { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError: false },
  };
}

function liveResult(callId: string, text: string, toolName = "bash") {
  return { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError: false };
}

describe("estimateLiveBranch", () => {
  test("counts only tool results over threshold after the last compaction marker", () => {
    const shake = new Shake(messages, 10);
    const branch = [
      resultEntry("old", "x".repeat(100)),
      { type: "compaction" },
      resultEntry("a", "y".repeat(50)),
      resultEntry("b", "small"),
    ];
    const estimate = shake.estimateLiveBranch(branch);

    expect(estimate.count).toBe(1);
    expect(estimate.bytes).toBe(50);
  });

  test("no compaction marker scans the whole branch", () => {
    const shake = new Shake(messages, 10);
    const branch = [resultEntry("a", "y".repeat(20)), resultEntry("b", "z".repeat(20))];

    expect(shake.estimateLiveBranch(branch).count).toBe(2);
  });

  test("empty branch yields zero", () => {
    const shake = new Shake(messages, 10);

    expect(shake.estimateLiveBranch([])).toEqual({ count: 0, bytes: 0 });
  });
});

describe("transformRequest", () => {
  test("elides oversized tool results and preserves order of others", () => {
    const shake = new Shake(messages, 10);
    const incoming: unknown[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      liveResult("a", "x".repeat(40), "read"),
      liveResult("b", "tiny"),
    ];
    const result = shake.transformRequest(incoming);

    expect(result.count).toBe(1);
    expect(result.saved).toBe(40);
    expect(result.messages).toHaveLength(3);
    const elided = result.messages[1] as { content: Array<{ text: string }>; details: unknown };
    expect(elided.content[0].text).toContain("[tool output from read elided by /shake");
    expect(elided.content[0].text).toContain("(40 bytes)");
    expect(elided.details).toBeUndefined();
    expect((result.messages[2] as { content: Array<{ text: string }> }).content[0].text).toBe("tiny");
  });

  test("no oversized results leaves the array intact with zero count", () => {
    const shake = new Shake(messages, 1000);
    const incoming: unknown[] = [liveResult("a", "small")];
    const result = shake.transformRequest(incoming);

    expect(result.count).toBe(0);
    expect(result.messages).toEqual(incoming);
  });
});

describe("tokensFor", () => {
  test("ceils bytes over four", () => {
    const shake = new Shake(messages, 10);

    expect(shake.tokensFor(10)).toBe(3);
    expect(shake.tokensFor(8)).toBe(2);
  });
});
