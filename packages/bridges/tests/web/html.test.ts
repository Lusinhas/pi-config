import { afterEach, describe, expect, test } from "bun:test";
import { DirectFetcher, HtmlError, HtmlExtractor } from "../../src/web/html.ts";

const extractor = new HtmlExtractor();
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (input: unknown, init?: unknown) => Promise<Response>): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

function makeResponse(
  body: string,
  options: { status?: number; statusText?: string; contentType?: string | null; contentLength?: string; url?: string },
): Response {
  const headers = new Headers();

  if (options.contentType !== null && options.contentType !== undefined) {
    headers.set("content-type", options.contentType);
  }

  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength);
  }

  const res = new Response(body, { status: options.status ?? 200, statusText: options.statusText ?? "", headers });

  if (options.url !== undefined) {
    Object.defineProperty(res, "url", { value: options.url });
  }

  return res;
}

describe("decodeEntities", () => {
  test("named entities", () => {
    expect(extractor.decodeEntities("a&amp;b&lt;c&gt;d&nbsp;e")).toBe("a&b<c>d e");
  });

  test("decimal and hex numeric", () => {
    expect(extractor.decodeEntities("&#65;&#x42;")).toBe("AB");
  });

  test("surrogate range is rejected", () => {
    expect(extractor.decodeEntities("&#xD800;")).toBe("&#xD800;");
    expect(extractor.decodeEntities("&#55296;")).toBe("&#55296;");
  });

  test("zero codepoint rejected", () => {
    expect(extractor.decodeEntities("&#0;")).toBe("&#0;");
  });

  test("unknown named entity passes through", () => {
    expect(extractor.decodeEntities("&notreal;")).toBe("&notreal;");
  });

  test("out of range codepoint rejected", () => {
    expect(extractor.decodeEntities("&#x110000;")).toBe("&#x110000;");
  });
});

describe("normalizeText", () => {
  test("CRLF to LF and whitespace collapse", () => {
    expect(extractor.normalizeText("a\r\nb\t\tc")).toBe("a\nb c");
  });

  test("nbsp and zwsp collapse to space", () => {
    expect(extractor.normalizeText("a ​b")).toBe("a b");
  });

  test("collapses runs of blank lines to one", () => {
    expect(extractor.normalizeText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("trims each line and overall", () => {
    expect(extractor.normalizeText("  a  \n   \n  b  ")).toBe("a\n\nb");
  });
});

describe("htmlToText", () => {
  test("extracts title and strips tags", () => {
    const out = extractor.htmlToText("<html><head><title>Hi &amp; Bye</title></head><body><p>One</p><p>Two</p></body></html>");
    expect(out.title).toBe("Hi & Bye");
    expect(out.text).toBe("One\n\nTwo");
  });

  test("drops script and style content", () => {
    const out = extractor.htmlToText("<body><script>var x=1;</script><p>Visible</p><style>.a{}</style></body>");
    expect(out.text).toBe("Visible");
  });

  test("li becomes dash bullet, br becomes newline", () => {
    const out = extractor.htmlToText("<body><ul><li>a</li><li>b</li></ul>x<br>y</body>");
    expect(out.text).toContain("- a");
    expect(out.text).toContain("- b");
    expect(out.text).toContain("x\ny");
  });
});

describe("HtmlError.describe", () => {
  test("unwraps cause", () => {
    const err = new Error("outer");
    (err as { cause?: unknown }).cause = new Error("inner");
    expect(HtmlError.describe(err)).toBe("outer (inner)");
  });

  test("plain error message", () => {
    expect(HtmlError.describe(new Error("boom"))).toBe("boom");
  });

  test("non-error stringified", () => {
    expect(HtmlError.describe("raw")).toBe("raw");
  });
});

describe("DirectFetcher.fetch", () => {
  const fetcher = new DirectFetcher(extractor);
  const target = new URL("https://example.test/page");

  test("html content type extracts text", async () => {
    stubFetch(async () => makeResponse("<title>T</title><body><p>Body</p></body>", { contentType: "text/html; charset=utf-8", url: "https://example.test/page" }));
    const page = await fetcher.fetch(target, new AbortController().signal);
    expect(page.title).toBe("T");
    expect(page.text).toBe("Body");
    expect(page.url).toBe("https://example.test/page");
  });

  test("empty content type with html-looking body is treated as html", async () => {
    stubFetch(async () => makeResponse("<!doctype html><body>Hi</body>", { contentType: null }));
    const page = await fetcher.fetch(target, new AbortController().signal);
    expect(page.text).toBe("Hi");
  });

  test("textual content type normalized", async () => {
    stubFetch(async () => makeResponse("line1\r\nline2", { contentType: "text/plain" }));
    const page = await fetcher.fetch(target, new AbortController().signal);
    expect(page.text).toBe("line1\nline2");
    expect(page.title).toBe("");
  });

  test("unsupported content type throws", async () => {
    stubFetch(async () => makeResponse("data", { contentType: "image/png" }));
    await expect(fetcher.fetch(target, new AbortController().signal)).rejects.toThrow('unsupported content type "image/png"');
  });

  test("non-ok status throws HTTP message with statusText", async () => {
    stubFetch(async () => makeResponse("nope", { status: 404, statusText: "Not Found", contentType: "text/html" }));
    await expect(fetcher.fetch(target, new AbortController().signal)).rejects.toThrow("HTTP 404 Not Found");
  });

  test("oversized content-length rejected", async () => {
    stubFetch(async () => makeResponse("x", { contentType: "text/html", contentLength: "20000001" }));
    await expect(fetcher.fetch(target, new AbortController().signal)).rejects.toThrow("response too large (20000001 bytes)");
  });

  test("aborted fetch throws request aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(async () => {
      throw new Error("aborted");
    });
    await expect(fetcher.fetch(target, controller.signal)).rejects.toThrow("request aborted");
  });

  test("network failure wrapped as request failed", async () => {
    stubFetch(async () => {
      throw new Error("dns");
    });
    await expect(fetcher.fetch(target, new AbortController().signal)).rejects.toThrow("request failed: dns");
  });
});
