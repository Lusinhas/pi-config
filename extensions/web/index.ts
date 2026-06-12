import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DiskCache, cacheKey } from "./cache.ts";
import { ExaClient, buildEndpoint, pickArgs, resolveApiKey } from "./mcp.ts";
import { directFetch, normalizeText } from "./html.ts";

interface WebConfig {
  apiKey: string;
  endpoint: string;
  tools: string[];
  numResults: number;
  maxChars: number;
  cacheTtlMin: number;
  cacheMaxEntries: number;
  timeoutSec: number;
  promptSnippet: boolean;
}

const DEFAULTS: WebConfig = {
  apiKey: "",
  endpoint: "https://mcp.exa.ai/mcp",
  tools: ["web_search_exa", "web_fetch_exa", "web_search_advanced_exa"],
  numResults: 8,
  maxChars: 40000,
  cacheTtlMin: 30,
  cacheMaxEntries: 200,
  timeoutSec: 30,
  promptSnippet: true,
};

const SEARCH_TOOL = "web_search_exa";
const ADVANCED_TOOL = "web_search_advanced_exa";
const FETCH_TOOL = "web_fetch_exa";
const SEARCH_TEXT_CAP = 20000;

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
  domains?: string[];
  excludeDomains?: string[];
  recentDays?: number;
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
  snippet: string;
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
  source: "exa" | "direct";
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

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
  return out.length > 0 ? out : fallback;
}

function loadConfig(): WebConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "piconfig.json"));
  if (globalConfig && isRecord(globalConfig.web)) merged = deepMerge(merged, globalConfig.web);
  const projectConfig = readJson(join(process.cwd(), ".pi", "piconfig.json"));
  if (projectConfig && isRecord(projectConfig.web)) merged = deepMerge(merged, projectConfig.web);
  return {
    apiKey: typeof merged.apiKey === "string" ? merged.apiKey : DEFAULTS.apiKey,
    endpoint: stringOr(merged.endpoint, DEFAULTS.endpoint),
    tools: stringList(merged.tools, DEFAULTS.tools),
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

function cleanDomains(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const domain = item
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (domain !== "" && !out.includes(domain)) out.push(domain);
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
    const highlights = Array.isArray(entry.highlights)
      ? entry.highlights.filter((part): part is string => typeof part === "string").map(collapse).join(" … ")
      : "";
    const body = highlights !== "" ? highlights : collapse(firstString(entry, ["summary", "snippet", "text"])).slice(0, 400);
    hits.push({
      title: collapse(firstString(entry, ["title"])),
      url,
      publishedDate: firstString(entry, ["publishedDate", "published_date"]).slice(0, 10),
      snippet: body.length > 400 ? `${body.slice(0, 397)}…` : body,
    });
  }
  return hits;
}

function formatHits(hits: SearchHit[], query: string): string {
  const lines: string[] = [`${hits.length} results for "${query}":`, ""];
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title !== "" ? hit.title : hit.url}`);
    lines.push(`   ${hit.url}`);
    const meta = [hit.publishedDate, hit.snippet].filter((part) => part !== "").join(" — ");
    if (meta !== "") lines.push(`   ${meta}`);
    lines.push("");
  });
  lines.push("Call webfetch with one of these urls to read the full page content.");
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
    (value.source === "exa" || value.source === "direct") &&
    typeof value.truncated === "boolean"
  );
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
    const body = firstString(entry, ["text", "content", "markdown"]);
    if (body === "") continue;
    return {
      title: firstString(entry, ["title"]),
      url: firstString(entry, ["url", "id"]) || fallbackUrl,
      text: body,
    };
  }
  if (isRecord(parsed)) {
    const body = firstString(parsed, ["text", "content", "markdown"]);
    if (body !== "") {
      return { title: firstString(parsed, ["title"]), url: firstString(parsed, ["url"]) || fallbackUrl, text: body };
    }
  }
  return { title: "", url: fallbackUrl, text };
}

function finishPage(title: string, url: string, rawText: string, source: "exa" | "direct", maxChars: number): CachedPage {
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
  "Two web tools are available, backed by Exa's MCP server:",
  "- websearch: use it to discover pages when you do not know the url — research questions, current events, library docs, error messages. Supports domains, excludeDomains, and recentDays filters when the server's advanced search tool is enabled.",
  "- webfetch: use it to read the full text of a page when you already have the url, whether from websearch results, the user, or code.",
  "Search first to find candidate sources, then fetch the one or two most promising results. Responses are cached for a short while; pass fresh: true on either tool when you need live data.",
].join("\n");

export default function web(pi: ExtensionAPI): void {
  const config = loadConfig();
  const cache = new DiskCache(config.cacheTtlMin, config.cacheMaxEntries);
  let client: ExaClient | undefined;
  let clientKey = "";

  const getClient = (): ExaClient => {
    const apiKey = resolveApiKey(config.apiKey);
    if (client === undefined || clientKey !== apiKey) {
      client = new ExaClient(buildEndpoint(config.endpoint, config.tools), apiKey);
      clientKey = apiKey;
    }
    return client;
  };

  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description:
      "Search the web through Exa's MCP server. Returns a numbered list of results with title, url, publication date, and snippet. Use webfetch afterwards to read full page content.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      domains: Type.Optional(Type.Array(Type.String(), { description: "Only return results from these domains (needs the advanced search tool)" })),
      excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Never return results from these domains (needs the advanced search tool)" })),
      recentDays: Type.Optional(Type.Number({ description: "Only return results published within the last N days (needs the advanced search tool)" })),
      fresh: Type.Optional(Type.Boolean({ description: "Bypass the local cache and force a live search" })),
    }),
    execute: async (_toolCallId: string, params: SearchParams, signal: AbortSignal): Promise<ToolOutput> => {
      const query = typeof params.query === "string" ? collapse(params.query) : "";
      if (query === "") throw new Error("websearch: the query parameter is required");
      const domains = cleanDomains(params.domains);
      const excludeDomains = cleanDomains(params.excludeDomains);
      let startPublishedDate: string | undefined;
      if (typeof params.recentDays === "number" && Number.isFinite(params.recentDays) && params.recentDays > 0) {
        const start = new Date(Date.now() - Math.ceil(params.recentDays) * 86400000);
        startPublishedDate = `${start.toISOString().slice(0, 10)}T00:00:00.000Z`;
      }
      const wantsFilters = domains.length > 0 || excludeDomains.length > 0 || startPublishedDate !== undefined;
      const key = cacheKey(["search", query, domains, excludeDomains, startPublishedDate ?? "", config.numResults]);
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
      const exa = getClient();
      let text: string;
      let toolName: string;
      try {
        await exa.ensureReady(requestSignal);
        toolName = wantsFilters && exa.hasTool(ADVANCED_TOOL) ? ADVANCED_TOOL : SEARCH_TOOL;
        if (!exa.hasTool(toolName)) {
          const available = exa.toolNames().join(", ");
          throw new Error(`server does not expose ${toolName}; available tools: ${available !== "" ? available : "none"}`);
        }
        const props = exa.toolProps(toolName);
        const args = pickArgs(props, {
          query,
          numResults: config.numResults,
          includeDomains: domains.length > 0 ? domains : undefined,
          excludeDomains: excludeDomains.length > 0 ? excludeDomains : undefined,
          startPublishedDate,
        });
        const result = await exa.callWithRetry(toolName, args, requestSignal);
        text = result.text;
        const dropped = [
          domains.length > 0 && args.includeDomains === undefined ? "domains" : "",
          excludeDomains.length > 0 && args.excludeDomains === undefined ? "excludeDomains" : "",
          startPublishedDate !== undefined && args.startPublishedDate === undefined ? "recentDays" : "",
        ].filter((part) => part !== "");
        const hits = parseSearchHits(text);
        let rendered = hits.length > 0 ? formatHits(hits, query) : capText(text, SEARCH_TEXT_CAP);
        if (dropped.length > 0) {
          rendered += `\n\n[note: the ${toolName} tool does not support these filters, which were ignored: ${dropped.join(", ")}]`;
        }
        cache.set(key, { text: rendered, tool: toolName, count: hits.length } satisfies CachedSearch);
        return {
          content: [{ type: "text", text: rendered }],
          details: { query, tool: toolName, count: hits.length, cached: false },
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
      "Fetch the readable text content of a web page by url through Exa's MCP server, falling back to a direct HTTP fetch with local html-to-text extraction when the server is unavailable.",
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
      let exaError = "";
      if (httpScheme) {
        try {
          const exa = getClient();
          await exa.ensureReady(requestSignal);
          if (!exa.hasTool(FETCH_TOOL)) throw new Error(`server does not expose ${FETCH_TOOL}`);
          const props = exa.toolProps(FETCH_TOOL);
          const args = pickArgs(props, {
            url: target.href,
            urls: props.has("urls") ? [target.href] : undefined,
            maxCharacters: maxChars + 1,
          });
          if (args.url === undefined && args.urls === undefined) args.url = target.href;
          const result = await exa.callWithRetry(FETCH_TOOL, args, requestSignal);
          const parsed = parsePage(result.text, target.href);
          if (collapse(parsed.text) !== "") {
            page = finishPage(parsed.title, parsed.url, parsed.text, "exa", maxChars);
          } else {
            exaError = "exa mcp returned no text for this url";
          }
        } catch (error) {
          exaError = describeError(error);
        }
        if (page === undefined && requestSignal.aborted) {
          throw new Error(`webfetch: request aborted or timed out (${exaError})`);
        }
      }
      if (page === undefined) {
        try {
          const fetched = await directFetch(target, requestSignal);
          page = finishPage(fetched.title, fetched.url, fetched.text, "direct", maxChars);
        } catch (error) {
          const directError = describeError(error);
          if (exaError !== "") {
            throw new Error(`webfetch: exa mcp failed (${exaError}); direct fetch failed (${directError})`);
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
