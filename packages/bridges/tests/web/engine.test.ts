import { describe, expect, test } from "bun:test";
import { DiskCache } from "../../src/web/cache.ts";
import type { SqlDatabase, SqlStatement } from "../../src/web/cache.ts";
import type { McpCallResult } from "../../src/web/client.ts";
import {
  FetchEngine,
  PromptSnippet,
  SearchEngine,
  Text,
  Timeout,
  WebError,
} from "../../src/web/index.ts";
import type { ClientProvider, McpClient, WebConfig } from "../../src/web/index.ts";

const CONFIG: WebConfig = {
  endpoint: "https://search.parallel.ai/mcp",
  numResults: 8,
  maxChars: 40000,
  cacheTtlMin: 30,
  cacheMaxEntries: 200,
  timeoutSec: 30,
  promptSnippet: true,
};

class MemoryDb implements SqlDatabase {
  store = new Map<string, { created_at: number; used_at: number; payload: string }>();

  exec(): void {
    void 0;
  }

  prepare(sql: string): SqlStatement {
    const store = this.store;

    if (sql.startsWith("SELECT")) {
      return {
        run: () => undefined,
        get: (key) => {
          const row = store.get(key as string);
          return row ? { created_at: row.created_at, payload: row.payload } : undefined;
        },
      };
    }

    if (sql.startsWith("INSERT")) {
      return {
        run: (key, created, used, payload) => {
          store.set(key as string, { created_at: created as number, used_at: used as number, payload: payload as string });
          return undefined;
        },
        get: () => undefined,
      };
    }

    return { run: () => undefined, get: () => undefined };
  }
}

function makeCache(): DiskCache {
  const db = new MemoryDb();
  return new DiskCache(30, 200, () => db, "/tmp/web-engine-test");
}

class FakeClient implements McpClient {
  constructor(
    private readonly tools: Map<string, Set<string>>,
    private readonly results: Map<string, McpCallResult>,
    public ensureError?: Error,
  ) {}

  async ensureReady(): Promise<void> {
    if (this.ensureError) {
      throw this.ensureError;
    }
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  toolProps(name: string): ReadonlySet<string> {
    return this.tools.get(name) ?? new Set();
  }

  async callWithRetry(name: string): Promise<McpCallResult> {
    const result = this.results.get(name);
    if (!result) {
      throw new Error(`no stub for ${name}`);
    }
    return result;
  }
}

function provider(client: McpClient): ClientProvider {
  return { get: () => client };
}

describe("Text", () => {
  test("collapse normalizes whitespace", () => {
    expect(Text.collapse("  a   b\n\tc  ")).toBe("a b c");
  });

  test("cap returns short text unchanged", () => {
    expect(Text.cap("abc", 10)).toBe("abc");
  });

  test("cap truncates with marker", () => {
    expect(Text.cap("abcdef", 3)).toBe("abc\n\n[truncated at 3 characters]");
  });
});

describe("WebError.describe", () => {
  test("does not unwrap cause", () => {
    const err = new Error("outer");
    (err as { cause?: unknown }).cause = new Error("inner");
    expect(WebError.describe(err)).toBe("outer");
  });

  test("stringifies non-errors", () => {
    expect(WebError.describe(42)).toBe("42");
  });
});

describe("Timeout.apply", () => {
  test("returns raw signal when disabled", () => {
    const signal = new AbortController().signal;
    expect(Timeout.apply(signal, 0)).toBe(signal);
  });

  test("returns a combined signal when enabled", () => {
    const signal = new AbortController().signal;
    const combined = Timeout.apply(signal, 30);
    expect(combined).toBeInstanceOf(AbortSignal);
  });
});

describe("PromptSnippet", () => {
  test("disabled returns undefined", () => {
    expect(new PromptSnippet(false).apply("base")).toBeUndefined();
  });

  test("appends to non-empty base with double newline", () => {
    const out = new PromptSnippet(true).apply("BASE");
    expect(out?.systemPrompt).toBe(`BASE\n\n${PromptSnippet.TEXT}`);
  });

  test("empty or non-string base yields snippet alone", () => {
    expect(new PromptSnippet(true).apply("")?.systemPrompt).toBe(PromptSnippet.TEXT);
    expect(new PromptSnippet(true).apply(undefined)?.systemPrompt).toBe(PromptSnippet.TEXT);
  });

  test("snippet text begins with heading and contains both bullets", () => {
    expect(PromptSnippet.TEXT.startsWith("## Web access")).toBe(true);
    expect(PromptSnippet.TEXT).toContain("Put domain or freshness constraints directly in the query text");
    expect(PromptSnippet.TEXT).toContain("pass fresh: true on either tool when you need live data");
  });
});

describe("SearchEngine", () => {
  test("empty query rejected", async () => {
    const engine = new SearchEngine(CONFIG, makeCache(), provider(new FakeClient(new Map(), new Map())), "sid");
    await expect(engine.execute({ query: "   " }, new AbortController().signal)).rejects.toThrow(
      "websearch: the query parameter is required",
    );
  });

  test("formats hits exactly", async () => {
    const tools = new Map([["web_search", new Set(["objective", "search_queries", "session_id"])]]);
    const serverText = JSON.stringify({
      results: [
        { url: "https://a.test", title: "Title A", publish_date: "2024-01-15T00:00:00Z", excerpts: ["Excerpt one"] },
        { url: "https://b.test", title: "", summary: "Sum B" },
      ],
    });
    const results = new Map([["web_search", { text: serverText, isError: false }]]);
    const engine = new SearchEngine(CONFIG, makeCache(), provider(new FakeClient(tools, results)), "sid");
    const out = await engine.execute({ query: "find things" }, new AbortController().signal);
    expect(out.content[0].text).toBe(
      [
        '2 results for "find things":',
        "",
        "1. Title A (2024-01-15)",
        "   https://a.test",
        "Excerpt one",
        "",
        "2. https://b.test",
        "   https://b.test",
        "Sum B",
        "",
        "Excerpts are usually enough to answer directly; call webfetch with a url when you need the full page.",
      ].join("\n"),
    );
    expect(out.details).toEqual({ query: "find things", tool: "web_search", count: 2, cached: false });
  });

  test("falls back to raw text when no hits parse", async () => {
    const tools = new Map([["web_search", new Set<string>()]]);
    const results = new Map([["web_search", { text: "plain server text", isError: false }]]);
    const engine = new SearchEngine(CONFIG, makeCache(), provider(new FakeClient(tools, results)), "sid");
    const out = await engine.execute({ query: "q" }, new AbortController().signal);
    expect(out.content[0].text).toBe("plain server text");
    expect(out.details.count).toBe(0);
  });

  test("returns cached search on repeat", async () => {
    const tools = new Map([["web_search", new Set<string>()]]);
    const results = new Map([["web_search", { text: JSON.stringify({ results: [{ url: "https://c.test", title: "C" }] }), isError: false }]]);
    const cache = makeCache();
    const engine = new SearchEngine(CONFIG, cache, provider(new FakeClient(tools, results)), "sid");
    const first = await engine.execute({ query: "q" }, new AbortController().signal);
    const second = await engine.execute({ query: "q" }, new AbortController().signal);
    expect(second.details.cached).toBe(true);
    expect(second.content[0].text).toBe(first.content[0].text);
  });

  test("missing search tool reports available tools", async () => {
    const tools = new Map([["other", new Set<string>()]]);
    const engine = new SearchEngine(CONFIG, makeCache(), provider(new FakeClient(tools, new Map())), "sid");
    await expect(engine.execute({ query: "q" }, new AbortController().signal)).rejects.toThrow(
      "websearch: server does not expose web_search; available tools: other",
    );
  });

  test("slices to numResults", async () => {
    const cfg = { ...CONFIG, numResults: 1 };
    const tools = new Map([["web_search", new Set<string>()]]);
    const serverText = JSON.stringify({ results: [{ url: "https://a.test", title: "A" }, { url: "https://b.test", title: "B" }] });
    const results = new Map([["web_search", { text: serverText, isError: false }]]);
    const engine = new SearchEngine(cfg, makeCache(), provider(new FakeClient(tools, results)), "sid");
    const out = await engine.execute({ query: "q" }, new AbortController().signal);
    expect(out.details.count).toBe(1);
    expect(out.content[0].text).toContain('1 results for "q":');
  });
});

describe("FetchEngine", () => {
  test("empty url rejected", async () => {
    const engine = new FetchEngine(CONFIG, makeCache(), provider(new FakeClient(new Map(), new Map())), "sid");
    await expect(engine.execute({ url: "  " }, new AbortController().signal)).rejects.toThrow(
      "webfetch: the url parameter is required",
    );
  });

  test("invalid url rejected with exact message", async () => {
    const engine = new FetchEngine(CONFIG, makeCache(), provider(new FakeClient(new Map(), new Map())), "sid");
    await expect(engine.execute({ url: "notaurl" }, new AbortController().signal)).rejects.toThrow(
      'webfetch: "notaurl" is not a valid absolute url',
    );
  });

  test("renders mcp page with heading and url", async () => {
    const tools = new Map([["web_fetch", new Set(["urls", "full_content", "session_id"])]]);
    const serverText = JSON.stringify({ results: [{ url: "https://x.test/p", title: "Page X", full_content: "Hello body" }] });
    const results = new Map([["web_fetch", { text: serverText, isError: false }]]);
    const engine = new FetchEngine(CONFIG, makeCache(), provider(new FakeClient(tools, results)), "sid");
    const out = await engine.execute({ url: "https://x.test/p" }, new AbortController().signal);
    expect(out.content[0].text).toBe("Page X\nhttps://x.test/p\n\nHello body");
    expect(out.details).toEqual({ url: "https://x.test/p", source: "mcp", cached: false, truncated: false, chars: 10 });
  });

  test("truncates and adds note when over maxChars", async () => {
    const cfg = { ...CONFIG, maxChars: 5 };
    const tools = new Map([["web_fetch", new Set<string>()]]);
    const serverText = JSON.stringify({ results: [{ url: "https://x.test", title: "T", full_content: "abcdefghij" }] });
    const results = new Map([["web_fetch", { text: serverText, isError: false }]]);
    const engine = new FetchEngine(cfg, makeCache(), provider(new FakeClient(tools, results)), "sid");
    const out = await engine.execute({ url: "https://x.test", maxChars: 50 }, new AbortController().signal);
    expect(out.details.truncated).toBe(true);
    expect(out.content[0].text).toContain("[truncated at 5 characters — call webfetch again with a larger maxChars to read more]");
  });

  test("uses param maxChars only when >= 100", async () => {
    const tools = new Map([["web_fetch", new Set<string>()]]);
    const body = "z".repeat(200);
    const serverText = JSON.stringify({ results: [{ url: "https://x.test", title: "T", full_content: body }] });
    const results = new Map([["web_fetch", { text: serverText, isError: false }]]);
    const engine = new FetchEngine(CONFIG, makeCache(), provider(new FakeClient(tools, results)), "sid");
    const out = await engine.execute({ url: "https://x.test", maxChars: 50 }, new AbortController().signal);
    expect(out.details.truncated).toBe(false);
    expect(out.details.chars).toBe(200);
  });

  test("non-http scheme skips mcp and direct, throws", async () => {
    const engine = new FetchEngine(CONFIG, makeCache(), provider(new FakeClient(new Map(), new Map())), "sid");
    await expect(engine.execute({ url: "ftp://x.test/file" }, new AbortController().signal)).rejects.toThrow("webfetch:");
  });
});
