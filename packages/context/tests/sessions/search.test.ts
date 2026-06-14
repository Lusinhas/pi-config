import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Search } from "../../src/sessions/search.ts";
import { Store } from "../../src/sessions/index.ts";
import type { SearchHit, SessionSummary, SessionTranscript } from "../../src/sessions/transcript.ts";

let dir = "";
let pathA = "";
let pathB = "";

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

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    path: "/a.jsonl",
    sessionId: "abcdef12",
    sessionTitle: "Title",
    modified: 0,
    itemIndex: 0,
    label: "user",
    excerpt: "ex",
    ...over,
  };
}

function transcript(items: Array<{ label: string; text: string }>): SessionTranscript {
  return {
    id: "tid",
    cwd: "/repo",
    items: items.map((it, index) => ({ index, entryId: `e${index}`, label: it.label, text: it.text })),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sessions-search-"));
  pathA = join(dir, "aaaa.jsonl");
  pathB = join(dir, "bbbb.jsonl");

  writeFileSync(
    pathA,
    [
      JSON.stringify({ type: "session", id: "aaaa1111", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "1", message: { role: "user", content: "find the NEEDLE here" } }),
      JSON.stringify({ type: "message", id: "2", message: { role: "assistant", content: "no match" } }),
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    pathB,
    [
      JSON.stringify({ type: "session", id: "bbbb2222", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "1", message: { role: "user", content: "another needle appears" } }),
      JSON.stringify({ type: "message", id: "2", message: { role: "user", content: "and one more needle to find" } }),
    ].join("\n"),
    "utf8",
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Search.searchSessions", () => {
  test("case-insensitive literal scan over loaded transcripts", () => {
    const store = new Store(async () => []);
    const search = new Search(store);
    const hits = search.searchSessions(
      "needle",
      [summary({ path: pathA, id: "aaaa1111", modified: 2 }), summary({ path: pathB, id: "bbbb2222", modified: 1 })],
      50,
      160,
    );

    expect(hits.length).toBe(3);
    expect(hits[0].path).toBe(pathA);
    expect(hits[0].itemIndex).toBe(0);
    expect(hits[1].path).toBe(pathB);
  });

  test("empty query yields no hits", () => {
    const store = new Store(async () => []);
    const search = new Search(store);

    expect(search.searchSessions("", [summary({ path: pathA })], 50, 160)).toEqual([]);
  });

  test("caps hits and returns early", () => {
    const store = new Store(async () => []);
    const search = new Search(store);
    const hits = search.searchSessions("needle", [summary({ path: pathB, id: "bbbb2222" })], 1, 160);

    expect(hits.length).toBe(1);
  });

  test("already-aborted signal stops before scanning", () => {
    const store = new Store(async () => []);
    const search = new Search(store);
    const controller = new AbortController();
    controller.abort();

    expect(search.searchSessions("needle", [summary({ path: pathA })], 50, 160, controller.signal)).toEqual([]);
  });

  test("unreadable session files are skipped", () => {
    const store = new Store(async () => []);
    const search = new Search(store);
    const hits = search.searchSessions(
      "needle",
      [summary({ path: join(dir, "missing.jsonl") }), summary({ path: pathA, id: "aaaa1111" })],
      50,
      160,
    );

    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe(pathA);
  });
});

describe("Search.makeExcerpt", () => {
  test("no ellipsis when window covers whole text", () => {
    expect(Search.makeExcerpt("short text", 0, 5, 160)).toBe("short text");
  });

  test("leading ellipsis when starting past 0", () => {
    const text = `${"x".repeat(300)}needle${"y".repeat(300)}`;
    const at = text.indexOf("needle");
    const ex = Search.makeExcerpt(text, at, 6, 160);

    expect(ex.startsWith("…")).toBe(true);
    expect(ex.endsWith("…")).toBe(true);
    expect(ex.includes("needle")).toBe(true);
  });
});

describe("Search.contextFor", () => {
  test("marks the hit item and returns surrounding span", () => {
    const store = new Store(async () => []);
    const search = new Search(store);
    const context = search.contextFor(hit({ path: pathB, itemIndex: 1 }), 1);

    expect(context).toContain("→ [1] user:");
    expect(context.split("\n\n").length).toBe(2);
  });

  test("span beyond bounds clamps", () => {
    const store = new Store(async () => []);
    const search = new Search(store);
    const context = search.contextFor(hit({ path: pathA, itemIndex: 0 }), 10);

    expect(context).toContain("→ [0] user:");
  });
});

describe("Search.listText", () => {
  test("empty local list message", () => {
    expect(Search.listText([], false, "/repo", 20, "")).toBe(
      "No saved sessions were found for /repo. Pass all:true to include other projects.",
    );
  });

  test("empty all-projects message", () => {
    expect(Search.listText([], true, "/repo", 20, "")).toBe("No saved sessions were found.");
  });

  test("header, current marker, padded count, and truncation note", () => {
    const sessions = [
      summary({ path: "/a.jsonl", id: "aaaa1111bbbb", modified: 1000, messageCount: 5, name: "Alpha" }),
      summary({ path: "/b.jsonl", id: "cccc2222dddd", modified: 500, messageCount: 12, name: "Beta" }),
    ];
    const text = Search.listText(sessions, false, "/repo", 1, "/a.jsonl");
    const lines = text.split("\n");

    expect(lines[0]).toBe("2 sessions for /repo (showing 1, most recent first; * = current):");
    expect(lines[1]).toBe("");
    expect(lines[2]).toMatch(/^\* aaaa1111  /);
    expect(lines[2]).toContain("   5 msgs  Alpha");
    expect(lines[3]).toBe("    /a.jsonl");
    expect(text).toContain("(1 older sessions not shown)");
  });

  test("singular session wording", () => {
    const text = Search.listText([summary({ path: "/a.jsonl", id: "x", modified: 1 })], false, "/repo", 20, "");

    expect(text.startsWith("1 session for /repo")).toBe(true);
  });
});

describe("Search.readText", () => {
  test("header with item range and hint lines", () => {
    const t = transcript([
      { label: "user", text: "one" },
      { label: "assistant", text: "two" },
      { label: "user", text: "three" },
    ]);
    const text = Search.readText("/s.jsonl", t, 1, 1);

    expect(text).toContain("Transcript of /s.jsonl (session tid)");
    expect(text).toContain("Items 1-1 of 3.");
    expect(text).toContain("Earlier items exist; re-run with offset:0.");
    expect(text).toContain("Later items exist; re-run with offset:2.");
    expect(text).toContain("[1] assistant: two");
  });

  test("output cap appends truncation hint at the overflowing item", () => {
    const t = transcript([
      { label: "user", text: "a".repeat(30000) },
      { label: "assistant", text: "b".repeat(30000) },
      { label: "user", text: "tail" },
    ]);
    const text = Search.readText("/s.jsonl", t, 0, 10);

    expect(text).toContain("(output truncated for size; continue with offset:1)");
    expect(text).not.toContain("[2] user: tail");
  });
});

describe("Search.searchText / formatHits", () => {
  test("no matches local message", () => {
    expect(Search.searchText("foo", [], 50, false)).toBe('No matches for "foo"; pass all:true to search every project.');
  });

  test("no matches all-projects message", () => {
    expect(Search.searchText("foo", [], 50, true)).toBe('No matches for "foo".');
  });

  test("grouped hits include read instruction; formatHits omits it", () => {
    const hits = [
      hit({ path: "/a.jsonl", sessionId: "aaaa1111", itemIndex: 3, label: "user", excerpt: "match one" }),
      hit({ path: "/a.jsonl", sessionId: "aaaa1111", itemIndex: 4, label: "assistant", excerpt: "match two" }),
      hit({ path: "/b.jsonl", sessionId: "bbbb2222", itemIndex: 0, label: "user", excerpt: "match three" }),
    ];
    const full = Search.searchText("term", hits, 50, false);

    expect(full.startsWith('3 matches for "term" in 2 sessions:')).toBe(true);
    expect(full).toContain("  [3 user] match one");
    expect(full).toContain("  /a.jsonl");
    expect(full).toContain('Read surrounding context with history op:"read", session:"<id>", offset:<item index>.');

    const brief = Search.formatHits("term", hits, 50);

    expect(brief).not.toContain("Read surrounding context");
    expect(full.startsWith(brief)).toBe(true);
  });

  test("cap note appears when hits reach cap", () => {
    const hits = [hit({}), hit({ path: "/c.jsonl" })];

    expect(Search.searchText("q", hits, 2, true)).toContain("(capped at 2)");
  });

  test("singular wording for one match in one session", () => {
    expect(Search.searchText("q", [hit({})], 50, true).startsWith('1 match for "q" in 1 session:')).toBe(true);
  });
});
