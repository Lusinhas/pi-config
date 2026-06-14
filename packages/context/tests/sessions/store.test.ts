import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/sessions/index.ts";
import type { SessionSummary } from "../../src/sessions/transcript.ts";

let dir = "";
let sessionPath = "";

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    path: "/x.jsonl",
    id: "id",
    name: "",
    firstMessage: "",
    messageCount: 0,
    modified: 0,
    created: 0,
    cwd: "",
    ...over,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sessions-store-"));
  sessionPath = join(dir, "abcd1234.jsonl");

  const lines = [
    JSON.stringify({ type: "session", id: "abcd1234efgh", cwd: "/repo" }),
    JSON.stringify({ type: "message", id: "e1", message: { role: "user", content: "hello world" } }),
    JSON.stringify({ type: "message", id: "e2", message: { role: "assistant", content: [{ type: "text", text: "hi there" }, { type: "thinking", thinking: "secret" }] } }),
    JSON.stringify({ type: "message", id: "e3", message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "a.ts" } }] } }),
    JSON.stringify({ type: "message", id: "e4", message: { role: "toolResult", toolName: "edit", content: "done\n\n  ok" } }),
    JSON.stringify({ type: "custom_message", id: "e5", customType: "todos", content: "remember this" }),
    JSON.stringify({ type: "compaction", id: "e6", summary: "compacted summary" }),
    JSON.stringify({ type: "branch_summary", id: "e7", summary: "branch summary" }),
    JSON.stringify({ type: "model_change", id: "e8", provider: "anthropic", modelId: "opus" }),
    JSON.stringify({ type: "message", id: "e9", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] } }),
    "not json",
    "",
  ];

  writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Store.loadTranscript", () => {
  test("derives id and cwd from session line and builds sequential items", () => {
    const store = new Store(async () => []);
    const t = store.loadTranscript(sessionPath);

    expect(t.id).toBe("abcd1234efgh");
    expect(t.cwd).toBe("/repo");
    expect(t.items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("renders each entry type with the expected label and text", () => {
    const store = new Store(async () => []);
    const items = store.loadTranscript(sessionPath).items;

    expect(items[0]).toMatchObject({ label: "user", text: "hello world" });
    expect(items[1]).toMatchObject({ label: "assistant", text: "hi there" });
    expect(items[2]).toMatchObject({ label: "assistant", text: '[tool edit({"path":"a.ts"})]' });
    expect(items[3]).toMatchObject({ label: "tool", text: "[edit result] done ok" });
    expect(items[4]).toMatchObject({ label: "note:todos", text: "remember this" });
    expect(items[5]).toMatchObject({ label: "compaction", text: "compacted summary" });
    expect(items[6]).toMatchObject({ label: "branch", text: "branch summary" });
    expect(items[7]).toMatchObject({ label: "model", text: "switched to anthropic/opus" });
  });

  test("thinking-only assistant entry is dropped", () => {
    const store = new Store(async () => []);
    const items = store.loadTranscript(sessionPath).items;

    expect(items.find((i) => i.text.includes("secret"))).toBeUndefined();
    expect(items.length).toBe(8);
  });

  test("read failure wraps path with cause", () => {
    const store = new Store(async () => []);

    expect(() => store.loadTranscript(join(dir, "missing.jsonl"))).toThrow(/could not read session file/);
  });

  test("missing id falls back to basename without extension", () => {
    const store = new Store(async () => []);
    const p = join(dir, "fallback.jsonl");
    writeFileSync(p, `${JSON.stringify({ type: "message", id: "z", message: { role: "user", content: "hi" } })}\n`, "utf8");

    expect(store.loadTranscript(p).id).toBe("fallback");
  });

  test("second load returns cached object until cleared", () => {
    const store = new Store(async () => []);
    const first = store.loadTranscript(sessionPath);
    const second = store.loadTranscript(sessionPath);

    expect(second).toBe(first);

    store.clearCache();
    const third = store.loadTranscript(sessionPath);

    expect(third).not.toBe(first);
    expect(third).toEqual(first);
  });
});

describe("Store.entriesToItems edges", () => {
  test("clips long item text with [+N chars] suffix", () => {
    const long = "a".repeat(2000);
    const items = Store.entriesToItems([{ type: "message", id: "1", message: { role: "user", content: long } }]);

    expect(items[0].text.endsWith(`[+${2000 - 1600} chars]`)).toBe(true);
    expect(items[0].text.startsWith("a".repeat(1600))).toBe(true);
  });

  test("empty and whitespace-only items are skipped", () => {
    const items = Store.entriesToItems([
      { type: "message", id: "1", message: { role: "user", content: "   " } },
      { type: "message", id: "2", message: { role: "assistant", content: [{ type: "thinking" }] } },
    ]);

    expect(items.length).toBe(0);
  });

  test("unknown role with non-empty name renders generically", () => {
    const items = Store.entriesToItems([{ type: "message", id: "1", message: { role: "system", content: "boot" } }]);

    expect(items[0]).toMatchObject({ label: "system", text: "boot" });
  });

  test("custom_message without customType uses extension label", () => {
    const items = Store.entriesToItems([{ type: "custom_message", id: "1", content: "note body" }]);

    expect(items[0].label).toBe("note:extension");
  });

  test("non-record entries ignored", () => {
    expect(Store.entriesToItems([1, "x", null, []])).toEqual([]);
  });
});

describe("Store.blockText / contentText", () => {
  test("string content passes through", () => {
    expect(Store.contentText("plain")).toBe("plain");
  });

  test("image block", () => {
    expect(Store.blockText({ type: "image" })).toBe("[image]");
  });

  test("toolCall uses input when arguments absent", () => {
    expect(Store.blockText({ type: "toolCall", name: "run", input: { cmd: "ls" } })).toBe('[tool run({"cmd":"ls"})]');
  });

  test("toolCall default name when missing", () => {
    expect(Store.blockText({ type: "toolCall" })).toBe("[tool tool({})]");
  });

  test("unknown block yields empty string", () => {
    expect(Store.blockText({ type: "weird" })).toBe("");
  });

  test("contentText joins non-empty blocks with newline and drops empties", () => {
    const text = Store.contentText([{ type: "text", text: "one" }, { type: "thinking" }, { type: "text", text: "two" }]);

    expect(text).toBe("one\ntwo");
  });
});

describe("Store.sessionTitle", () => {
  test("prefers name", () => {
    expect(Store.sessionTitle(summary({ name: "  My Session  ", firstMessage: "ignored" }))).toBe("My Session");
  });

  test("falls back to firstMessage", () => {
    expect(Store.sessionTitle(summary({ firstMessage: "first thing said" }))).toBe("first thing said");
  });

  test("untitled when both blank", () => {
    expect(Store.sessionTitle(summary({}))).toBe("(untitled)");
  });
});

describe("Store.listSessions", () => {
  test("normalizes records, sorts by modified desc, drops pathless", async () => {
    const store = new Store(async () => [
      { path: "/a.jsonl", id: "a", modified: 100, messageCount: 3 },
      { id: "no-path" },
      { path: "/b.jsonl", modified: 300 },
      "garbage",
    ]);
    const list = await store.listSessions("/repo", false);

    expect(list.map((s) => s.path)).toEqual(["/b.jsonl", "/a.jsonl"]);
    expect(list[0].id).toBe("b");
    expect(list[1].messageCount).toBe(3);
  });

  test("lister receives the all flag", async () => {
    let captured: boolean | undefined;
    const store = new Store(async (_cwd, all) => {
      captured = all;
      return [];
    });
    await store.listSessions("/repo", true);

    expect(captured).toBe(true);
  });

  test("non-array lister output yields empty list", async () => {
    const store = new Store(async () => ({ not: "array" }));

    expect(await store.listSessions("/repo", false)).toEqual([]);
  });

  test("equal modified keeps input order (stable)", async () => {
    const store = new Store(async () => [
      { path: "/x.jsonl", id: "x", modified: 5 },
      { path: "/y.jsonl", id: "y", modified: 5 },
    ]);
    const list = await store.listSessions("/repo", false);

    expect(list.map((s) => s.id)).toEqual(["x", "y"]);
  });
});

describe("Store.resolveSession", () => {
  test("empty spec throws", async () => {
    const store = new Store(async () => []);

    await expect(store.resolveSession("   ", "/repo")).rejects.toThrow(/required/);
  });

  test("literal existing file path used directly", async () => {
    const store = new Store(async () => []);

    expect(await store.resolveSession(sessionPath, "/repo")).toBe(sessionPath);
  });

  test("exact id match in local list", async () => {
    const store = new Store(async () => [{ path: "/repo/s1.jsonl", id: "sess1", modified: 1 }]);

    expect(await store.resolveSession("sess1", "/repo")).toBe("/repo/s1.jsonl");
  });

  test("prefix match falls through to all projects", async () => {
    let calls = 0;
    const store = new Store(async (_cwd, all) => {
      calls += 1;

      if (all) {
        return [{ path: "/other/sx.jsonl", id: "sessionX", modified: 1 }];
      }

      return [];
    });

    expect(await store.resolveSession("sessionX", "/repo")).toBe("/other/sx.jsonl");
    expect(calls).toBe(2);
  });

  test("no match throws guidance error", async () => {
    const store = new Store(async () => []);

    await expect(store.resolveSession("nope", "/repo")).rejects.toThrow(/no session matches "nope"/);
  });

  test("ambiguous prefix throws", async () => {
    const store = new Store(async () => [
      { path: "/repo/p1.jsonl", id: "prefixone", modified: 1 },
      { path: "/repo/p2.jsonl", id: "prefixtwo", modified: 1 },
    ]);

    await expect(store.resolveSession("prefix", "/repo")).rejects.toThrow(/is ambiguous \(2 sessions match\)/);
  });

  test("duplicate paths dedupe to single resolution", async () => {
    const store = new Store(async () => [
      { path: "/repo/dup.jsonl", id: "dup", modified: 1 },
      { path: "/repo/dup.jsonl", id: "dup", modified: 1 },
    ]);

    expect(await store.resolveSession("dup", "/repo")).toBe("/repo/dup.jsonl");
  });
});
