import { afterEach, describe, expect, test } from "bun:test";
import { ArgPicker, Endpoint, MessageParser, ParallelClient } from "../../src/web/client.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Endpoint.build", () => {
  test("keeps a valid url", () => {
    expect(Endpoint.build("https://example.test/mcp")).toBe("https://example.test/mcp");
  });

  test("falls back on invalid url", () => {
    expect(Endpoint.build("not a url")).toBe("https://search.parallel.ai/mcp");
  });
});

describe("ArgPicker.pick", () => {
  test("empty prop set passes everything except undefined", () => {
    const args = ArgPicker.pick(new Set(), { a: 1, b: undefined, c: "x" });
    expect(args).toEqual({ a: 1, c: "x" });
  });

  test("filters to advertised props", () => {
    const args = ArgPicker.pick(new Set(["a", "c"]), { a: 1, b: 2, c: 3 });
    expect(args).toEqual({ a: 1, c: 3 });
  });

  test("drops undefined values", () => {
    const args = ArgPicker.pick(new Set(["a"]), { a: undefined });
    expect(args).toEqual({});
  });
});

describe("MessageParser.parse", () => {
  test("parses SSE data lines", () => {
    const body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
    const msgs = MessageParser.parse(body, "text/event-stream");
    expect(msgs.length).toBe(1);
    expect(msgs[0].id).toBe(1);
  });

  test("parses single JSON object", () => {
    const msgs = MessageParser.parse('{"jsonrpc":"2.0","id":2,"result":7}', "application/json");
    expect(msgs.length).toBe(1);
    expect(msgs[0].result).toBe(7);
  });

  test("parses JSON array", () => {
    const msgs = MessageParser.parse('[{"jsonrpc":"2.0","id":1},{"jsonrpc":"2.0","id":2}]', "application/json");
    expect(msgs.length).toBe(2);
  });

  test("empty body yields no messages", () => {
    expect(MessageParser.parse("   ", "application/json")).toEqual([]);
  });

  test("invalid json yields no messages", () => {
    expect(MessageParser.parse("{bad", "application/json")).toEqual([]);
  });
});

describe("MessageParser.contentText", () => {
  test("joins text blocks and trims", () => {
    const text = MessageParser.contentText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    expect(text).toBe("a\nb");
  });

  test("ignores non-text blocks", () => {
    const text = MessageParser.contentText({ content: [{ type: "image" }, { type: "text", text: "ok" }] });
    expect(text).toBe("ok");
  });

  test("non-record or missing content yields empty", () => {
    expect(MessageParser.contentText(null)).toBe("");
    expect(MessageParser.contentText({})).toBe("");
  });
});

describe("ParallelClient.failure", () => {
  const client = new ParallelClient("https://example.test/mcp");

  test("401 and 403 mapped to rejection message", () => {
    expect(client.failure(401, "x").message).toBe(
      "parallel mcp rejected the request with http 401; check the web.endpoint setting",
    );
    expect(client.failure(403, "x").message).toBe(
      "parallel mcp rejected the request with http 403; check the web.endpoint setting",
    );
  });

  test("429 mapped to rate limit", () => {
    expect(client.failure(429, "x").message).toBe("parallel mcp rate limit hit; retry later");
  });

  test("other status includes trimmed detail", () => {
    expect(client.failure(500, "  boom  ").message).toBe("parallel mcp request failed with http 500: boom");
  });

  test("other status with empty body omits detail", () => {
    expect(client.failure(503, "   ").message).toBe("parallel mcp request failed with http 503");
  });

  test("detail capped at 300 chars", () => {
    const long = "y".repeat(400);
    const msg = client.failure(500, long).message;
    expect(msg.endsWith("y".repeat(300))).toBe(true);
  });
});

function jsonResponse(payload: unknown, headers: Record<string, string> = {}, status = 200): Response {
  const h = new Headers({ "content-type": "application/json", ...headers });
  return new Response(JSON.stringify(payload), { status, headers: h });
}

describe("ParallelClient handshake", () => {
  test("ensureReady records tool prop sets and rejects empty tool list", async () => {
    let step = 0;
    globalThis.fetch = (async () => {
      step += 1;
      if (step === 1) {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }, { "mcp-session-id": "sess-1" });
      }
      if (step === 2) {
        return new Response("", { status: 202 });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "web_search", inputSchema: { properties: { objective: {}, session_id: {} } } }] },
      });
    }) as unknown as typeof fetch;

    const client = new ParallelClient("https://example.test/mcp");
    await client.ensureReady(new AbortController().signal);
    expect(client.isReady()).toBe(true);
    expect(client.hasTool("web_search")).toBe(true);
    expect([...client.toolProps("web_search")].sort()).toEqual(["objective", "session_id"]);
  });

  test("empty tools list throws", async () => {
    let step = 0;
    globalThis.fetch = (async () => {
      step += 1;
      if (step === 1) {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "s" });
      }
      if (step === 2) {
        return new Response("", { status: 202 });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    }) as unknown as typeof fetch;

    const client = new ParallelClient("https://example.test/mcp");
    await expect(client.ensureReady(new AbortController().signal)).rejects.toThrow(
      "parallel mcp listed no tools; check the endpoint setting",
    );
  });
});

describe("ParallelClient.callWithRetry", () => {
  test("retries once when handshake never completed and not aborted", async () => {
    let attempts = 0;
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? "{}") as { method?: string; id?: number };
      if (body.method === "initialize") {
        attempts += 1;
        if (attempts === 1) {
          return new Response("server error", { status: 500 });
        }
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": "s" });
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (body.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "web_search", inputSchema: { properties: {} } }] },
        });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "done" }] } });
    }) as unknown as typeof fetch;

    const client = new ParallelClient("https://example.test/mcp");
    const result = await client.callWithRetry("web_search", { objective: "q" }, new AbortController().signal);
    expect(result.text).toBe("done");
    expect(attempts).toBe(2);
  });

  test("does not retry when signal aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      controller.abort();
      return new Response("err", { status: 500 });
    }) as unknown as typeof fetch;

    const client = new ParallelClient("https://example.test/mcp");
    await expect(client.callWithRetry("web_search", {}, controller.signal)).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});
