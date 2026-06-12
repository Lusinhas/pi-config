import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DiskCache, cacheKey } from "./cache.ts";
import { ParallelClient, buildEndpoint, pickArgs } from "./mcp.ts";
import { directFetch, normalizeText } from "./html.ts";

interface WebConfig {
  endpoint: string;
  numResults: number;
  maxChars: number;
  cacheTtlMin: number;
  cacheMaxEntries: number;
  timeoutSec: number;
  promptSnippet: boolean;
}

const DEFAULTS: WebConfig = {
  endpoint: "https://search.parallel.ai/mcp",
  numResults: 8,
  maxChars: 40000,
  cacheTtlMin: 30,
  cacheMaxEntries: 200,
  timeoutSec: 30,
  promptSnippet: true,
};

const SEARCH_TOOL = "web_search";
const FETCH_TOOL = "web_fetch";
const SEARCH_TEXT_CAP = 20000;
const EXCERPT_CAP = 2000;

interface ToolText {
  type: "text";
  text: string;
}

interface ToolOutput {
  content: ToolText[];
  details: Record<string, unknown>;
}

interface SearchParams {
  query: string;
  queries?: string[];
  fresh?: boolean;
}

interface FetchParams {
  url: string;
  maxChars?: number;
  fresh?: boolean;
}

interface SearchHit {
  title: string;
  url: string;
  publishedDate: string;
  excerpt: string;
}

interface CachedSearch {
  text: string;
  tool: string;
  count: number;
}

interface CachedPage {
  title: string;
  url: string;
  text: string;
  source: "mcp" | "direct";
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) {
      merged[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function intBetween(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) return fallback;
  return normalized;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function loadConfig(): WebConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "suite.json"));
  if (globalConfig && isRecord(globalConfig.web)) merged = deepMerge(merged, globalConfig.web);
  const projectConfig = readJson(join(process.cwd(), ".pi", "suite.json"));
  if (projectConfig && isRecord(projectConfig.web)) merged = deepMerge(merged, projectConfig.web);
  return {
    endpoint: stringOr(merged.endpoint, DEFAULTS.endpoint),
    numResults: intBetween(merged.numResults, 1, 25, DEFAULTS.numResults),
    maxChars: intBetween(merged.maxChars, 500, 2000000, DEFAULTS.maxChars),
    cacheTtlMin: intBetween(merged.cacheTtlMin, 0, 525600, DEFAULTS.cacheTtlMin),
    cacheMaxEntries: intBetween(merged.cacheMaxEntries, 1, 100000, DEFAULTS.cacheMaxEntries),
    timeoutSec: intBetween(merged.timeoutSec, 0, 600, DEFAULTS.timeoutSec),
    promptSnippet: booleanOr(merged.promptSnippet, DEFAULTS.promptSnippet),
  };
}

function withTimeout(signal: AbortSignal, timeoutSec: number): AbortSignal {
  if (timeoutSec <= 0) return signal;
  try {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutSec * 1000)]);
  } catch {
    return signal;
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanQueries(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const query = collapse(item);
    if (query !== "" && !out.includes(query)) out.push(query);
  }
  return out;
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

function resultArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return [];
  if (Array.isArray(parsed.results)) return parsed.results;
  if (isRecord(parsed.data) && Array.isArray(parsed.data.results)) return parsed.data.results;
  return [];
}

function excerptStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function hitExcerpt(entry: Record<string, unknown>): string {
  const excerpts = excerptStrings(entry.excerpts);
  const body = excerpts.length > 0 ? excerpts.join("\n…\n") : firstString(entry, ["summary", "snippet", "text"]).trim();
  return body.length > EXCERPT_CAP ? `${body.slice(0, EXCERPT_CAP - 1)}…` : body;
}

function parseSearchHits(text: string): SearchHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const hits: SearchHit[] = [];
  for (const entry of resultArray(parsed)) {
    if (!isRecord(entry)) continue;
    const url = firstString(entry, ["url", "id"]);
    if (!/^https?:\/\//i.test(url)) continue;
    hits.push({
      title: collapse(firstString(entry, ["title"])),
      url,
      publishedDate: firstString(entry, ["publish_date", "publishedDate", "published_date"]).slice(0, 10),
      excerpt: hitExcerpt(entry),
    });
  }
  return hits;
}

function formatHits(hits: SearchHit[], query: string): string {
  const lines: string[] = [`${hits.length} results for "${query}":`];
  hits.forEach((hit, index) => {
    lines.push("");
    const date = hit.publishedDate !== "" ? ` (${hit.publishedDate})` : "";
    lines.push(`${index + 1}. ${hit.title !== "" ? hit.title : hit.url}${date}`);
    lines.push(`   ${hit.url}`);
    if (hit.excerpt !== "") lines.push(hit.excerpt);
  });
  lines.push("");
  lines.push("Excerpts are usually enough to answer directly; call webfetch with a url when you need the full page.");
  return lines.join("\n");
}

function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n\n[truncated at ${cap} characters]`;
}

function isCachedSearch(value: unknown): value is CachedSearch {
  return isRecord(value) && typeof value.text === "string" && typeof value.tool === "string" && typeof value.count === "number";
}

function isCachedPage(value: unknown): value is CachedPage {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.text === "string" &&
    (value.source === "mcp" || value.source === "direct") &&
    typeof value.truncated === "boolean"
  );
}

function pageBody(entry: Record<string, unknown>): string {
  const direct = firstString(entry, ["full_content", "text", "content", "markdown"]);
  if (direct !== "") return direct;
  return excerptStrings(entry.excerpts).join("\n…\n");
}

function parsePage(text: string, fallbackUrl: string): { title: string; url: string; text: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { title: "", url: fallbackUrl, text };
  }
  for (const entry of resultArray(parsed)) {
    if (!isRecord(entry)) continue;
    const body = pageBody(entry);
    if (body === "") continue;
    return {
      title: firstString(entry, ["title"]),
      url: firstString(entry, ["url", "id"]) || fallbackUrl,
      text: body,
    };
  }
  if (isRecord(parsed)) {
    const body = pageBody(parsed);
    if (body !== "") {
      return { title: firstString(parsed, ["title"]), url: firstString(parsed, ["url"]) || fallbackUrl, text: body };
    }
  }
  return { title: "", url: fallbackUrl, text: isRecord(parsed) || Array.isArray(parsed) ? "" : text };
}

function finishPage(title: string, url: string, rawText: string, source: "mcp" | "direct", maxChars: number): CachedPage {
  const text = normalizeText(rawText);
  const truncated = text.length > maxChars;
  return {
    title: collapse(title),
    url,
    text: truncated ? text.slice(0, maxChars) : text,
    source,
    truncated,
  };
}

function renderPage(page: CachedPage, target: URL, maxChars: number, cached: boolean): ToolOutput {
  const fallbackHeading = target.hostname !== "" ? target.hostname : page.url;
  const heading = page.title !== "" ? page.title : fallbackHeading;
  const note = page.truncated
    ? `\n\n[truncated at ${maxChars} characters — call webfetch again with a larger maxChars to read more]`
    : "";
  return {
    content: [{ type: "text", text: `${heading}\n${page.url}\n\n${page.text}${note}` }],
    details: { url: page.url, source: page.source, cached, truncated: page.truncated, chars: page.text.length },
  };
}

const PROMPT_SNIPPET = [
  "## Web access",
  "Two web tools are available, backed by Parallel's Search MCP server:",
  "- websearch: use it to discover pages and gather current information — research questions, current events, library docs, error messages. Put domain or freshness constraints directly in the query text (e.g. \"... from nodejs.org\", \"... in the last month\"); the optional queries parameter adds 2-3 keyword variants for better coverage. Result excerpts are dense and often answer the question directly.",
  "- webfetch: use it to read the full text of a page when you already have the url, whether from websearch results, the user, or code.",
  "Search first; fetch only the one or two pages whose excerpts are not enough. Responses are cached for a short while; pass fresh: true on either tool when you need live data.",
].join("\n");

export default function web(pi: ExtensionAPI): void {
  const config = loadConfig();
  const cache = new DiskCache(config.cacheTtlMin, config.cacheMaxEntries);
  const sessionId = randomUUID();
  let client: ParallelClient | undefined;

  const getClient = (): ParallelClient => {
    if (client === undefined) {
      client = new ParallelClient(buildEndpoint(config.endpoint));
    }
    return client;
  };

  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description:
      "Search the web through Parallel's Search MCP server. Returns a list of results with title, url, publication date, and a dense excerpt that is often enough to answer directly. Use webfetch afterwards when you need full page content.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Natural-language description of what the search should find. Include any domain or freshness constraints directly in the text, e.g. \"release notes from nodejs.org in the last month\"",
      }),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional 2-3 concise keyword queries (3-6 words each) related to the query; improves coverage",
        })
      ),
      fresh: Type.Optional(Type.Boolean({ description: "Bypass the local cache and force a live search" })),
    }),
    execute: async (_toolCallId: string, params: SearchParams, signal: AbortSignal): Promise<ToolOutput> => {
      const query = typeof params.query === "string" ? collapse(params.query) : "";
      if (query === "") throw new Error("websearch: the query parameter is required");
      const queries = cleanQueries(params.queries);
      const searchQueries = queries.length > 0 ? queries : [query];
      const key = cacheKey(["search", query, searchQueries, config.numResults]);
      if (params.fresh !== true) {
        const hit = cache.get(key);
        if (isCachedSearch(hit)) {
          return {
            content: [{ type: "text", text: hit.text }],
            details: { query, tool: hit.tool, count: hit.count, cached: true },
          };
        }
      }
      const requestSignal = withTimeout(signal, config.timeoutSec);
      const mcp = getClient();
      try {
        await mcp.ensureReady(requestSignal);
        if (!mcp.hasTool(SEARCH_TOOL)) {
          const available = mcp.toolNames().join(", ");
          throw new Error(`server does not expose ${SEARCH_TOOL}; available tools: ${available !== "" ? available : "none"}`);
        }
        const props = mcp.toolProps(SEARCH_TOOL);
        const args = pickArgs(props, {
          objective: query,
          search_queries: searchQueries,
          session_id: sessionId,
        });
        const result = await mcp.callWithRetry(SEARCH_TOOL, args, requestSignal);
        const hits = parseSearchHits(result.text).slice(0, config.numResults);
        const rendered = capText(hits.length > 0 ? formatHits(hits, query) : result.text, SEARCH_TEXT_CAP);
        cache.set(key, { text: rendered, tool: SEARCH_TOOL, count: hits.length } satisfies CachedSearch);
        return {
          content: [{ type: "text", text: rendered }],
          details: { query, tool: SEARCH_TOOL, count: hits.length, cached: false },
        };
      } catch (error) {
        throw new Error(`websearch: ${describeError(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description:
      "Fetch the readable text content of a web page by url through Parallel's Search MCP server, falling back to a direct HTTP fetch with local html-to-text extraction when the server is unavailable.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute url of the page to fetch" }),
      maxChars: Type.Optional(Type.Number({ description: "Maximum characters of page text to return (default 40000)" })),
      fresh: Type.Optional(Type.Boolean({ description: "Bypass the local cache and force a live fetch" })),
    }),
    execute: async (_toolCallId: string, params: FetchParams, signal: AbortSignal): Promise<ToolOutput> => {
      const rawUrl = typeof params.url === "string" ? params.url.trim() : "";
      if (rawUrl === "") throw new Error("webfetch: the url parameter is required");
      let target: URL;
      try {
        target = new URL(rawUrl);
      } catch {
        throw new Error(`webfetch: "${rawUrl}" is not a valid absolute url`);
      }
      const maxChars =
        typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars >= 100
          ? Math.floor(params.maxChars)
          : config.maxChars;
      const key = cacheKey(["fetch", target.href, maxChars]);
      if (params.fresh !== true) {
        const hit = cache.get(key);
        if (isCachedPage(hit)) return renderPage(hit, target, maxChars, true);
      }
      const requestSignal = withTimeout(signal, config.timeoutSec);
      const httpScheme = target.protocol === "http:" || target.protocol === "https:";
      let page: CachedPage | undefined;
      let mcpError = "";
      if (httpScheme) {
        try {
          const mcp = getClient();
          await mcp.ensureReady(requestSignal);
          if (!mcp.hasTool(FETCH_TOOL)) throw new Error(`server does not expose ${FETCH_TOOL}`);
          const props = mcp.toolProps(FETCH_TOOL);
          const args = pickArgs(props, {
            urls: [target.href],
            full_content: true,
            session_id: sessionId,
          });
          if (args.urls === undefined) args.urls = [target.href];
          const result = await mcp.callWithRetry(FETCH_TOOL, args, requestSignal);
          const parsed = parsePage(result.text, target.href);
          if (collapse(parsed.text) !== "") {
            page = finishPage(parsed.title, parsed.url, parsed.text, "mcp", maxChars);
          } else {
            mcpError = "parallel mcp returned no text for this url";
          }
        } catch (error) {
          mcpError = describeError(error);
        }
        if (page === undefined && requestSignal.aborted) {
          throw new Error(`webfetch: request aborted or timed out (${mcpError})`);
        }
      }
      if (page === undefined) {
        try {
          const fetched = await directFetch(target, requestSignal);
          page = finishPage(fetched.title, fetched.url, fetched.text, "direct", maxChars);
        } catch (error) {
          const directError = describeError(error);
          if (mcpError !== "") {
            throw new Error(`webfetch: parallel mcp failed (${mcpError}); direct fetch failed (${directError})`);
          }
          throw new Error(`webfetch: ${directError}`);
        }
      }
      if (page.text === "") {
        throw new Error(`webfetch: no readable text found at ${target.href}`);
      }
      cache.set(key, page);
      return renderPage(page, target, maxChars, false);
    },
  });

  pi.on("before_agent_start", (event: { systemPrompt?: unknown }) => {
    if (!config.promptSnippet) return undefined;
    const base = typeof event.systemPrompt === "string" && event.systemPrompt !== "" ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${PROMPT_SNIPPET}` };
  });
}
