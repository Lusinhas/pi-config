import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
import { Messages } from "../../src/compaction/index.ts";
import { Supersede } from "../../src/compaction/strategy.ts";

const messages = new Messages();

function readCall(id: string, path: string): Record<string, unknown> {
  return {
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }] },
  };
}

function toolResult(callId: string, text: string, toolName = "read"): Record<string, unknown> {
  return {
    type: "message",
    message: { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError: false },
  };
}

function liveResult(callId: string, text: string, toolName = "read") {
  return { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError: false };
}

describe("normalizePath", () => {
  test("absolute paths are normalized, relative resolved against cwd", () => {
    const supersede = new Supersede(messages, { keepRecentTokens: 20000, dropOverBytes: 20480 });

    expect(isAbsolute(supersede.normalizePath("/a/b/../c", "/root"))).toBe(true);
    expect(supersede.normalizePath("a/b", "/root")).toBe(resolve("/root", "a/b"));
  });
});

describe("readPathOf", () => {
  test("picks first present key in declared order", () => {
    const supersede = new Supersede(messages, { keepRecentTokens: 20000, dropOverBytes: 20480 });

    expect(supersede.readPathOf({ file: "f", path: "p" })).toBe("p");
    expect(supersede.readPathOf({ filePath: "x" })).toBe("x");
    expect(supersede.readPathOf({ other: "n" })).toBeUndefined();
  });
});

describe("supersede transform", () => {
  test("blanks all but the newest read of a file", () => {
    const supersede = new Supersede(messages, { keepRecentTokens: 20000, dropOverBytes: 20480 });
    const branch = [
      readCall("c1", "src/a.ts"),
      toolResult("c1", "old contents"),
      readCall("c2", "src/a.ts"),
      toolResult("c2", "new contents"),
    ];
    const summarize: unknown[] = [liveResult("c1", "old contents"), liveResult("c2", "new contents")];
    const result = supersede.transform({
      summarize,
      prefix: [],
      branchEntries: branch,
      cwd: "/root",
      settingsKeepRecentTokens: undefined,
    });

    expect(result.supersededCount).toBe(1);
    const blanked = summarize[0] as { content: Array<{ text: string }> };
    expect(blanked.content[0].text).toContain("superseded read of");
    expect(blanked.content[0].text).toContain(resolve("/root", "src/a.ts"));
    const kept = summarize[1] as { content: Array<{ text: string }> };
    expect(kept.content[0].text).toBe("new contents");
  });

  test("does not supersede a single read", () => {
    const supersede = new Supersede(messages, { keepRecentTokens: 20000, dropOverBytes: 20480 });
    const branch = [readCall("c1", "only.ts"), toolResult("c1", "data")];
    const summarize: unknown[] = [liveResult("c1", "data")];
    const result = supersede.transform({
      summarize,
      prefix: [],
      branchEntries: branch,
      cwd: "/root",
      settingsKeepRecentTokens: undefined,
    });

    expect(result.supersededCount).toBe(0);
    expect(result.notifyText).toBeUndefined();
  });

  test("drops oversized tool results outside the recent token window", () => {
    const supersede = new Supersede(messages, { keepRecentTokens: 20, dropOverBytes: 10 });
    const big = "x".repeat(200);
    const summarize: unknown[] = [liveResult("t1", big, "bash"), liveResult("t2", "y".repeat(50), "bash")];
    const result = supersede.transform({
      summarize,
      prefix: [],
      branchEntries: [],
      cwd: "/root",
      settingsKeepRecentTokens: 1,
    });

    expect(result.droppedCount).toBe(1);
    const dropped = summarize[0] as { content: Array<{ text: string }> };
    expect(dropped.content[0].text).toContain("oversized bash result elided before compaction");
    const recent = summarize[1] as { content: Array<{ text: string }> };
    expect(recent.content[0].text).toBe("y".repeat(50));
  });

  test("recent oversized results inside keepRecentTokens are not dropped", () => {
    const supersede = new Supersede(messages, { keepRecentTokens: 100000, dropOverBytes: 10 });
    const big = "x".repeat(2000);
    const summarize: unknown[] = [liveResult("t1", big, "bash")];
    const result = supersede.transform({
      summarize,
      prefix: [],
      branchEntries: [],
      cwd: "/root",
      settingsKeepRecentTokens: 20000,
    });

    expect(result.droppedCount).toBe(0);
  });

  test("writes replacements back to summarize and prefix windows", () => {
    const supersede = new Supersede(messages, { keepRecentTokens: 1, dropOverBytes: 10 });
    const big = "z".repeat(400);
    const summarize: unknown[] = [liveResult("s1", big, "bash")];
    const prefix: unknown[] = [liveResult("p1", big, "bash")];
    const result = supersede.transform({
      summarize,
      prefix,
      branchEntries: [],
      cwd: "/root",
      settingsKeepRecentTokens: 1,
    });

    expect(result.droppedCount).toBe(2);
    expect((summarize[0] as { content: Array<{ text: string }> }).content[0].text).toContain("oversized");
    expect((prefix[0] as { content: Array<{ text: string }> }).content[0].text).toContain("oversized");
  });

  test("notify text reports both counts and combined bytes", () => {
    const supersede = new Supersede(messages, { keepRecentTokens: 1, dropOverBytes: 10 });
    const branch = [
      readCall("c1", "a.ts"),
      toolResult("c1", "x".repeat(50)),
      readCall("c2", "a.ts"),
      toolResult("c2", "newer"),
    ];
    const summarize: unknown[] = [liveResult("c1", "x".repeat(50)), liveResult("c2", "newer")];
    const result = supersede.transform({
      summarize,
      prefix: [],
      branchEntries: branch,
      cwd: "/root",
      settingsKeepRecentTokens: 1,
    });

    expect(result.notifyText).toContain("supersede: elided");
    expect(result.notifyText).toContain("superseded read(s)");
    expect(result.notifyText).toContain("oversized tool result(s)");
  });
});
