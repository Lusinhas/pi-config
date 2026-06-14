import { describe, expect, test } from "bun:test";
import { HANDOFFSYSTEM, Handoff } from "../../src/compaction/handoff.ts";
import { Messages } from "../../src/compaction/index.ts";

const messages = new Messages();
const handoff = new Handoff(messages);

function entry(message: Record<string, unknown>): Record<string, unknown> {
  return { type: "message", message };
}

describe("HANDOFFSYSTEM", () => {
  test("contains the four required sections", () => {
    expect(HANDOFFSYSTEM).toContain("## Goal");
    expect(HANDOFFSYSTEM).toContain("## Current state");
    expect(HANDOFFSYSTEM).toContain("## Decisions");
    expect(HANDOFFSYSTEM).toContain("## Open items");
  });
});

describe("clip", () => {
  test("short text passes through", () => {
    expect(handoff.clip("hello", 10)).toBe("hello");
  });

  test("long text is clipped head + marker + tail", () => {
    const text = "a".repeat(100);
    const clipped = handoff.clip(text, 50);

    expect(clipped).toContain("[...50 chars clipped...]");
    expect(clipped.startsWith("a".repeat(35))).toBe(true);
  });
});

describe("renderMessage", () => {
  test("user message", () => {
    expect(handoff.renderMessage({ role: "user", content: [{ type: "text", text: "do it" }] })).toBe("USER:\ndo it");
  });

  test("empty user message omitted", () => {
    expect(handoff.renderMessage({ role: "user", content: [] })).toBe("");
  });

  test("assistant text plus tool calls", () => {
    const rendered = handoff.renderMessage({
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
      ],
    });

    expect(rendered).toBe('ASSISTANT:\nthinking\nTOOL CALL read({"path":"a.ts"})');
  });

  test("assistant tool call with circular args falls back to empty object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rendered = handoff.renderMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: circular }],
    });

    expect(rendered).toBe("ASSISTANT:\nTOOL CALL bash({})");
  });

  test("tool result with error flag", () => {
    const rendered = handoff.renderMessage({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });

    expect(rendered).toBe("TOOL RESULT bash (error):\nboom");
  });

  test("developer note", () => {
    expect(handoff.renderMessage({ role: "developer", content: [{ type: "text", text: "note" }] })).toBe(
      "SYSTEM NOTE:\nnote",
    );
  });

  test("unknown role yields empty", () => {
    expect(handoff.renderMessage({ role: "system", content: "x" })).toBe("");
  });
});

describe("serializeRecentEntries", () => {
  test("keeps recent entries in order under the budget", () => {
    const entries = [
      entry({ role: "user", content: [{ type: "text", text: "one" }] }),
      entry({ role: "assistant", content: [{ type: "text", text: "two" }] }),
    ];

    expect(handoff.serializeRecentEntries(entries, 1000)).toBe("USER:\none\n\nASSISTANT:\ntwo");
  });

  test("always keeps at least the newest piece even when it alone exceeds the budget", () => {
    const entries = [
      entry({ role: "user", content: [{ type: "text", text: "old" }] }),
      entry({ role: "assistant", content: [{ type: "text", text: "z".repeat(500) }] }),
    ];
    const result = handoff.serializeRecentEntries(entries, 10);

    expect(result.startsWith("ASSISTANT:")).toBe(true);
    expect(result).not.toContain("USER:");
  });

  test("skips non-message entries", () => {
    const entries = [{ type: "compaction" }, entry({ role: "user", content: [{ type: "text", text: "hi" }] })];

    expect(handoff.serializeRecentEntries(entries, 1000)).toBe("USER:\nhi");
  });
});

describe("buildPrompt", () => {
  test("omits instruction line when empty", () => {
    expect(handoff.buildPrompt("BODY", "")).toBe("Write the handoff document for the session below.\n\n<session>\nBODY\n</session>");
  });

  test("includes instruction line when present", () => {
    const prompt = handoff.buildPrompt("BODY", "focus on tests");

    expect(prompt).toBe(
      "The user gave these instructions for the handoff: focus on tests\n\nWrite the handoff document for the session below.\n\n<session>\nBODY\n</session>",
    );
  });
});

describe("extractText", () => {
  test("joins text blocks and trims", () => {
    expect(handoff.extractText([{ type: "text", text: " a " }, { type: "image" }, { type: "text", text: "b" }])).toBe(
      "a \nb",
    );
  });

  test("non-array returns empty", () => {
    expect(handoff.extractText("x")).toBe("");
  });
});

describe("openingText", () => {
  test("frames the saved handoff document", () => {
    expect(handoff.openingText(".pi/handoff.md", "DOC")).toBe(
      "Continuing work from a previous session. The handoff document below was saved to .pi/handoff.md.\n\nDOC",
    );
  });
});
