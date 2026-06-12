const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  deg: "°",
  times: "×",
  laquo: "«",
  raquo: "»",
  sect: "§",
  para: "¶",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x") || lower.startsWith("#")) {
      const hex = lower.startsWith("#x");
      const code = Number.parseInt(lower.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    return NAMED[lower] ?? match;
  });
}

export function normalizeText(text: string): string {
  const unified = text.replace(/\r\n?/g, "\n").replace(/[\t\f\v\u00a0\u200b ]+/g, " ");
  const lines = unified.split("\n").map((line) => line.replace(/ {2,}/g, " ").trim());
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === "") {
      blanks += 1;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

export interface ExtractedPage {
  title: string;
  text: string;
}

export function htmlToText(html: string): ExtractedPage {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? normalizeText(decodeEntities(titleMatch[1])).replace(/\n+/g, " ") : "";
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  let body = bodyMatch ? bodyMatch[1] : html;
  body = body
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\s*\/?\s*(p|div|section|article|main|header|footer|nav|aside|table|tr|ul|ol|dl|dt|dd|blockquote|pre|h[1-6]|figure|figcaption|form)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return { title, text: normalizeText(decodeEntities(body)) };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message !== "") return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml|javascript|rss|atom))|[+](json|xml)(\s*;|$)/i;
const MAX_BODY_BYTES = 20000000;

export interface FetchedPage {
  title: string;
  url: string;
  text: string;
}

export async function directFetch(target: URL, signal: AbortSignal): Promise<FetchedPage> {
  let response: Response;
  try {
    response = await fetch(target, {
      redirect: "follow",
      signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "user-agent": "Mozilla/5.0 (compatible; pi-config-web/1.0)",
      },
    });
  } catch (error) {
    if (signal.aborted) throw new Error("request aborted");
    throw new Error(`request failed: ${describeError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${response.statusText !== "" ? ` ${response.statusText}` : ""}`);
  }
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new Error(`response too large (${length} bytes)`);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw new Error(`response body could not be read: ${describeError(error)}`);
  }
  if (raw.length > MAX_BODY_BYTES) raw = raw.slice(0, MAX_BODY_BYTES);
  const looksHtml = /<\s*(!doctype|html|body|div|p|title)\b/i.test(raw.slice(0, 4000));
  if (contentType.includes("html") || (contentType === "" && looksHtml)) {
    const extracted = htmlToText(raw);
    return { title: extracted.title, url: response.url !== "" ? response.url : target.href, text: extracted.text };
  }
  if (contentType === "" || TEXTUAL.test(contentType)) {
    return { title: "", url: response.url !== "" ? response.url : target.href, text: normalizeText(raw) };
  }
  throw new Error(`unsupported content type "${contentType}"`);
}
