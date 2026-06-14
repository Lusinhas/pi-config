import { describe, expect, test } from "bun:test";
import { Btw } from "../../src/sessions/search.ts";

function msg(role: string, text: string): unknown {
  return { type: "message", id: role, message: { role, content: text } };
}

describe("Btw.plainText", () => {
  test("string content", () => {
    expect(Btw.plainText("hello")).toBe("hello");
  });

  test("joins only text blocks", () => {
    expect(Btw.plainText([{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  test("non-array non-string yields empty", () => {
    expect(Btw.plainText({ foo: 1 })).toBe("");
  });
});

describe("Btw.pieceFrom", () => {
  test("user and assistant produce labeled pieces", () => {
    expect(Btw.pieceFrom(msg("user", "hi"))).toEqual({ label: "User", text: "hi" });
    expect(Btw.pieceFrom(msg("assistant", "yo"))).toEqual({ label: "Assistant", text: "yo" });
  });

  test("other roles excluded", () => {
    expect(Btw.pieceFrom(msg("toolResult", "x"))).toBeUndefined();
    expect(Btw.pieceFrom(msg("system", "x"))).toBeUndefined();
  });

  test("empty text excluded", () => {
    expect(Btw.pieceFrom(msg("user", "   "))).toBeUndefined();
  });

  test("non-message entries excluded", () => {
    expect(Btw.pieceFrom({ type: "compaction", summary: "s" })).toBeUndefined();
    expect(Btw.pieceFrom(null)).toBeUndefined();
  });
});

describe("Btw.branchTranscript", () => {
  test("reverse-walks then reorders oldest first", () => {
    const entries = [msg("user", "first"), msg("assistant", "second"), msg("user", "third")];
    const text = Btw.branchTranscript(entries, 12000);

    expect(text).toBe("User: first\n\nAssistant: second\n\nUser: third");
  });

  test("skips non-conversation entries", () => {
    const entries = [
      msg("user", "q"),
      { type: "custom_message", customType: "todos", content: "ignore" },
      msg("assistant", "a"),
    ];

    expect(Btw.branchTranscript(entries, 12000)).toBe("User: q\n\nAssistant: a");
  });

  test("empty when no conversation entries", () => {
    expect(Btw.branchTranscript([{ type: "compaction", summary: "s" }], 12000)).toBe("");
  });

  test("budget drops older pieces keeping the most recent", () => {
    const entries = [msg("user", "x".repeat(100)), msg("assistant", "y".repeat(100))];
    const text = Btw.branchTranscript(entries, 120);

    expect(text.includes("y".repeat(100))).toBe(true);
    expect(text.includes("x".repeat(100))).toBe(false);
  });

  test("first overflowing single piece is tail-sliced with leading ellipsis", () => {
    const entries = [msg("user", "z".repeat(500))];
    const budget = 50;
    const text = Btw.branchTranscript(entries, budget);

    expect(text.startsWith("User: …")).toBe(true);
    const room = Math.max(1, budget - "User".length - 3);
    expect(text).toBe(`User: …${"z".repeat(room)}`);
  });
});

describe("Btw.intro / userMessage", () => {
  test("no-conversation intro", () => {
    expect(Btw.intro("")).toBe("There is no prior conversation in this session.");
  });

  test("transcript intro", () => {
    expect(Btw.intro("User: hi")).toBe("Conversation transcript (oldest first, truncated to fit):\n\nUser: hi");
  });

  test("userMessage composes intro and question", () => {
    expect(Btw.userMessage("", "what is x?")).toBe(
      "There is no prior conversation in this session.\n\nSide question:\nwhat is x?",
    );
  });
});

describe("Btw.resolveAuth", () => {
  test("non-record auth yields empty", () => {
    expect(Btw.resolveAuth("nope")).toEqual({});
    expect(Btw.resolveAuth(null)).toEqual({});
  });

  test("ok:false throws provided error", () => {
    expect(() => Btw.resolveAuth({ ok: false, error: "missing key" })).toThrow("missing key");
  });

  test("ok:false without error throws default message", () => {
    expect(() => Btw.resolveAuth({ ok: false })).toThrow("no credentials are configured for the current model");
  });

  test("extracts apiKey and string headers only", () => {
    const resolved = Btw.resolveAuth({ apiKey: "k", headers: { "x-a": "1", "x-b": 2, "x-c": "3" } });

    expect(resolved.apiKey).toBe("k");
    expect(resolved.headers).toEqual({ "x-a": "1", "x-c": "3" });
  });

  test("empty apiKey and empty headers omitted", () => {
    expect(Btw.resolveAuth({ apiKey: "", headers: {} })).toEqual({});
    expect(Btw.resolveAuth({ headers: { k: 5 } })).toEqual({});
  });
});

describe("Btw.resolveMaxTokens", () => {
  test("min of budget and finite positive model max", () => {
    expect(Btw.resolveMaxTokens(2000, 4096)).toBe(2000);
    expect(Btw.resolveMaxTokens(8000, 4096)).toBe(4096);
  });

  test("falls back to budget when model max invalid", () => {
    expect(Btw.resolveMaxTokens(undefined, 4096)).toBe(4096);
    expect(Btw.resolveMaxTokens(0, 4096)).toBe(4096);
    expect(Btw.resolveMaxTokens(NaN, 4096)).toBe(4096);
    expect(Btw.resolveMaxTokens(-5, 4096)).toBe(4096);
  });
});

describe("Btw.resolveReasoning", () => {
  test("returns level only when reasoning enabled and level valid", () => {
    expect(Btw.resolveReasoning(true, "high")).toBe("high");
    expect(Btw.resolveReasoning(true, "minimal")).toBe("minimal");
  });

  test("undefined when reasoning disabled", () => {
    expect(Btw.resolveReasoning(false, "high")).toBeUndefined();
    expect(Btw.resolveReasoning(undefined, "high")).toBeUndefined();
  });

  test("undefined for unknown level", () => {
    expect(Btw.resolveReasoning(true, "ultra")).toBeUndefined();
    expect(Btw.resolveReasoning(true, 3)).toBeUndefined();
  });
});
