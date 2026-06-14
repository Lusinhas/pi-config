import { describe, expect, it } from "bun:test";
import { Consolidator } from "../../src/memory/consolidate.ts";
import type { BranchEntry, SessionEntry } from "../../src/memory/consolidate.ts";
import { Store } from "../../src/memory/index.ts";

const directQueue = async (_path: string, run: () => Promise<unknown>): Promise<unknown> => run();

function newConsolidator(): Consolidator {
  return new Consolidator(new Store(directQueue));
}

describe("Consolidator.restore", () => {
  it("resets cursor and turns then takes the last memory.cursor entryId", () => {
    const c = newConsolidator();
    c.bumpTurn();
    c.bumpTurn();

    const entries: SessionEntry[] = [
      { type: "message" },
      { type: "custom", customType: "memory.cursor", data: { entryId: "a" } },
      { type: "custom", customType: "other", data: { entryId: "x" } },
      { type: "custom", customType: "memory.cursor", data: { entryId: "b" } },
    ];
    c.restore(entries);

    expect(c.cursor).toBe("b");
    expect(c.turns).toBe(0);
  });

  it("leaves cursor null when no cursor entries present", () => {
    const c = newConsolidator();
    c.setCursor("stale");
    c.restore([{ type: "message" }]);

    expect(c.cursor).toBeNull();
  });

  it("ignores cursor entries with non-string entryId", () => {
    const c = newConsolidator();
    c.restore([{ type: "custom", customType: "memory.cursor", data: { entryId: 5 } }]);

    expect(c.cursor).toBeNull();
  });
});

describe("Consolidator.partText", () => {
  const c = newConsolidator();

  it("returns strings directly", () => {
    expect(c.partText("plain")).toBe("plain");
  });

  it("joins text parts and ignores non-text", () => {
    const content = [
      { type: "text", text: "one" },
      { type: "image", url: "x" },
      { type: "text", text: "two" },
      { type: "text", text: 5 },
    ];

    expect(c.partText(content)).toBe("one\ntwo");
  });

  it("returns empty for non-array, non-string", () => {
    expect(c.partText(null)).toBe("");
    expect(c.partText(42)).toBe("");
  });
});

describe("Consolidator.messageLine", () => {
  const c = newConsolidator();

  it("formats user and assistant messages", () => {
    expect(c.messageLine({ role: "user", content: "hello" }, 600)).toBe("User: hello");
    expect(c.messageLine({ role: "assistant", content: [{ type: "text", text: "hi" }] }, 600)).toBe("Assistant: hi");
  });

  it("formats only failed tool results with the tool name", () => {
    expect(c.messageLine({ role: "toolResult", isError: true, toolName: "grep", content: "boom" }, 600)).toBe(
      "Tool error (grep): boom",
    );
    expect(c.messageLine({ role: "toolResult", isError: true, content: "boom" }, 600)).toBe("Tool error (tool): boom");
    expect(c.messageLine({ role: "toolResult", isError: false, content: "ok" }, 600)).toBeUndefined();
  });

  it("skips empty text and unknown roles and non-objects", () => {
    expect(c.messageLine({ role: "user", content: "   " }, 600)).toBeUndefined();
    expect(c.messageLine({ role: "system", content: "x" }, 600)).toBeUndefined();
    expect(c.messageLine(null, 600)).toBeUndefined();
    expect(c.messageLine(7, 600)).toBeUndefined();
  });
});

describe("Consolidator.tailClip", () => {
  const c = newConsolidator();

  it("returns text unchanged within budget", () => {
    expect(c.tailClip("hello", 0)).toBe("hello");
    expect(c.tailClip("hello", 99)).toBe("hello");
  });

  it("keeps the tail and drops the partial first line", () => {
    const text = "head\nmiddle\ntail";
    const out = c.tailClip(text, 10);

    expect(out.startsWith("head")).toBe(false);
    expect(text.endsWith(out)).toBe(true);
  });

  it("returns slice when no newline boundary exists in tail", () => {
    const out = c.tailClip("abcdefghij", 4);

    expect(out).toBe("ghij");
  });
});

describe("Consolidator.collect", () => {
  const c = newConsolidator();

  it("starts after the cursor, includes only message entries, and reports lastId", () => {
    const entries: BranchEntry[] = [
      { id: "1", type: "message", message: { role: "user", content: "before cursor" } },
      { id: "2", type: "custom" },
      { id: "3", type: "message", message: { role: "user", content: "question" } },
      { id: "4", type: "message", message: { role: "assistant", content: "answer" } },
      { id: "5", type: "tool" },
    ];
    const result = c.collect(entries, "2", 12000);

    expect(result.lastId).toBe("5");
    expect(result.transcript).toBe("User: question\n\nAssistant: answer");
  });

  it("collects from the start when cursor is null", () => {
    const entries: BranchEntry[] = [
      { id: "1", type: "message", message: { role: "user", content: "hi" } },
    ];
    const result = c.collect(entries, null, 12000);

    expect(result).toEqual({ transcript: "User: hi", lastId: "1" });
  });

  it("collects from the start when cursor is unknown", () => {
    const entries: BranchEntry[] = [
      { id: "1", type: "message", message: { role: "user", content: "hi" } },
    ];
    const result = c.collect(entries, "missing", 12000);

    expect(result.transcript).toBe("User: hi");
  });

  it("reports null lastId for an empty branch", () => {
    expect(c.collect([], null, 12000)).toEqual({ transcript: "", lastId: null });
  });
});

describe("Consolidator.extractionPrompt", () => {
  const c = newConsolidator();

  it("embeds the cap and preserves the verbatim six-line prompt", () => {
    const prompt = c.extractionPrompt(3);
    const lines = prompt.split("\n");

    expect(lines.length).toBe(6);
    expect(lines[0]).toBe("You maintain long-term memory for a coding agent working in one project.");
    expect(lines[1]).toBe(
      "Read the session excerpt and extract at most 3 durable facts genuinely worth remembering in future sessions.",
    );
    expect(lines[4]).toContain('JSON array only');
    expect(lines[4]).toContain('{"topic": "<short noun phrase>", "text": "<one to three plain sentences>"}');
    expect(lines[5]).toBe("If nothing qualifies, respond with [].");
  });
});

describe("Consolidator.parseFacts", () => {
  const c = newConsolidator();

  it("slices the bracketed array, dedupes by slug, and caps maxFacts", () => {
    const raw = 'prose [{"topic":"Build","text":"make"},{"topic":"build","text":"dup"},{"topic":"Test","text":"go test"}] tail';
    const facts = c.parseFacts(raw, 5);

    expect(facts).toEqual([
      { topic: "Build", text: "make" },
      { topic: "Test", text: "go test" },
    ]);
  });

  it("caps to maxFacts", () => {
    const raw = '[{"topic":"a","text":"1"},{"topic":"b","text":"2"},{"topic":"c","text":"3"}]';

    expect(c.parseFacts(raw, 2)).toEqual([
      { topic: "a", text: "1" },
      { topic: "b", text: "2" },
    ]);
  });

  it("skips entries missing topic or text", () => {
    const raw = '[{"topic":"","text":"x"},{"topic":"y","text":""},{"topic":"z","text":"keep"}]';

    expect(c.parseFacts(raw, 5)).toEqual([{ topic: "z", text: "keep" }]);
  });

  it("returns empty for missing brackets or invalid json or non-array", () => {
    expect(c.parseFacts("no brackets here", 5)).toEqual([]);
    expect(c.parseFacts("][", 5)).toEqual([]);
    expect(c.parseFacts("[not json]", 5)).toEqual([]);
    expect(c.parseFacts('{"topic":"a","text":"b"}', 5)).toEqual([]);
  });

  it("trims topic and text", () => {
    expect(c.parseFacts('[{"topic":"  T  ","text":"  body  "}]', 5)).toEqual([{ topic: "T", text: "body" }]);
  });
});

describe("Consolidator turn counter", () => {
  it("bumps and resets", () => {
    const c = newConsolidator();
    c.bumpTurn();
    c.bumpTurn();

    expect(c.turns).toBe(2);
    c.resetTurns();

    expect(c.turns).toBe(0);
  });
});

describe("Consolidator.skipReason", () => {
  const c = newConsolidator();
  const long = "x".repeat(120);

  it("skips when there is no last id", () => {
    expect(c.skipReason(long, null)).toBe("nothing new to consolidate");
  });

  it("skips when the transcript is below the minimum length", () => {
    expect(c.skipReason("tiny", "5")).toBe("nothing new to consolidate");
  });

  it("does not skip a fresh long transcript", () => {
    expect(c.skipReason(long, "5")).toBeUndefined();
  });

  it("skips an identical transcript after it was marked consolidated", () => {
    const fresh = newConsolidator();
    const transcript = "y".repeat(200);

    expect(fresh.skipReason(transcript, "9")).toBeUndefined();

    fresh.markConsolidated(transcript, "9");

    expect(fresh.skipReason(transcript, "9")).toBe("no new content since last consolidation");
    expect(fresh.cursor).toBe("9");
  });
});

describe("Consolidator.runPlan", () => {
  it("returns a skip plan with no facts when the transcript is too small", () => {
    const c = newConsolidator();
    const plan = c.runPlan("tiny", "1", '[{"topic":"a","text":"b"}]', 3);

    expect(plan.skip).toBe(true);
    expect(plan.reason).toBe("nothing new to consolidate");
    expect(plan.facts).toEqual([]);
  });

  it("parses facts for a fresh transcript and reports no skip", () => {
    const c = newConsolidator();
    const transcript = "z".repeat(200);
    const plan = c.runPlan(transcript, "7", '[{"topic":"Build","text":"make all"}]', 3);

    expect(plan.skip).toBe(false);
    expect(plan.reason).toBe("");
    expect(plan.facts).toEqual([{ topic: "Build", text: "make all" }]);
  });

  it("reports the no-facts reason when the model returns an empty array", () => {
    const c = newConsolidator();
    const transcript = "z".repeat(200);
    const plan = c.runPlan(transcript, "7", "[]", 3);

    expect(plan.skip).toBe(false);
    expect(plan.reason).toBe("no durable facts found");
    expect(plan.facts).toEqual([]);
  });
});
