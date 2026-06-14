import { describe, expect, it } from "bun:test";
import { GOAL_ENTRY, LOOP_ENTRY } from "../../src/goals/index.ts";
import { Text } from "../../src/goals/text.ts";

describe("Text.flatten", () => {
  it("returns a string content unchanged", () => {
    expect(Text.flatten("hello")).toBe("hello");
  });

  it("joins text blocks with newlines and ignores non-text blocks", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "tool_use", text: "skip" },
      { type: "text", text: "b" },
      { type: "text" },
      "raw",
    ];

    expect(Text.flatten(content)).toBe("a\nb");
  });

  it("returns empty string for non-array non-string content", () => {
    expect(Text.flatten(42)).toBe("");
    expect(Text.flatten(null)).toBe("");
    expect(Text.flatten({ type: "text", text: "x" })).toBe("");
  });
});

describe("Text.lastAssistant", () => {
  it("scans from the end and returns the first non-empty assistant string", () => {
    const messages = [
      { role: "assistant", content: "first" },
      { role: "user", content: "ignored" },
      { role: "assistant", content: "last" },
    ];

    expect(Text.lastAssistant(messages)).toBe("last");
  });

  it("skips assistant messages with empty or whitespace content", () => {
    const messages = [
      { role: "assistant", content: "real" },
      { role: "assistant", content: "   " },
      { role: "assistant", content: "" },
    ];

    expect(Text.lastAssistant(messages)).toBe("real");
  });

  it("joins assistant text blocks and skips empty block sets", () => {
    const messages = [
      { role: "assistant", content: "earlier" },
      { role: "assistant", content: [{ type: "tool_use" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    ];

    expect(Text.lastAssistant(messages)).toBe("one\ntwo");
  });

  it("skips non-assistant and non-record entries", () => {
    const messages = [null, 7, { role: "user", content: "u" }, { role: "assistant", content: "win" }];

    expect(Text.lastAssistant(messages)).toBe("win");
  });

  it("returns empty string when no assistant text exists", () => {
    expect(Text.lastAssistant([{ role: "user", content: "u" }])).toBe("");
    expect(Text.lastAssistant([])).toBe("");
  });
});

describe("Text.clipLine", () => {
  it("collapses whitespace and returns short lines unchanged", () => {
    expect(Text.clipLine("  a   b  c ", 48)).toBe("a b c");
  });

  it("clips long lines with an ellipsis suffix", () => {
    expect(Text.clipLine("a very long   condition that exceeds the limit", 12)).toBe("a very long…");
  });

  it("returns the flat string unchanged when maxChars is non-positive", () => {
    expect(Text.clipLine("  a   b ", 0)).toBe("a b");
  });
});

describe("Text.openTodoLabels", () => {
  it("returns empty when open is non-positive", () => {
    expect(Text.openTodoLabels(0, [{ text: "x" }])).toEqual([]);
    expect(Text.openTodoLabels(-3, [{ text: "x" }])).toEqual([]);
  });

  it("derives labels and skips completed items", () => {
    const labels = Text.openTodoLabels(5, [
      "  raw label  ",
      { done: true, text: "skip" },
      { completed: true, title: "skip" },
      { status: "cancelled", title: "skip" },
      { title: "  trimmed title  " },
      { foo: "bar" },
    ]);

    expect(labels).toEqual(["raw label", "trimmed title", JSON.stringify({ foo: "bar" })]);
  });

  it("produces a synthetic label when open is positive but no labels survive", () => {
    expect(Text.openTodoLabels(1, [{ done: true }])).toEqual(["1 open todo"]);
    expect(Text.openTodoLabels(2, [{ done: true }])).toEqual(["2 open todos"]);
  });
});

describe("wire contract entry constants", () => {
  it("locks the session custom entry types", () => {
    expect(GOAL_ENTRY).toBe("goals:goal");
    expect(LOOP_ENTRY).toBe("goals:loop");
  });
});
