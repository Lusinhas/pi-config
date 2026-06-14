import { CacheKey, DiskCache } from "./cache.ts";
import { ArgPicker, Endpoint, ParallelClient } from "./client.ts";
import type { McpCallResult } from "./client.ts";
import { DirectFetcher, HtmlExtractor } from "./html.ts";

const SEARCH_TOOL = "web_search";
const FETCH_TOOL = "web_fetch";
const SEARCH_TEXT_CAP = 20000;
const EXCERPT_CAP = 2000;

export interface WebConfig {
  endpoint: string;
  numResults: number;
  maxChars: number;
  cacheTtlMin: number;
  cacheMaxEntries: number;
  timeoutSec: number;
  promptSnippet: boolean;
}

export const DEFAULTS: WebConfig = {
  endpoint: "https://search.parallel.ai/mcp",
  numResults: 8,
  maxChars: 40000,
  cacheTtlMin: 30,
  cacheMaxEntries: 200,
  timeoutSec: 30,
  promptSnippet: true,
};

export interface ToolText {
  type: "text";
  text: string;
}

export interface ToolOutput {
  content: ToolText[];
  details: Record<string, unknown>;
}

export interface SearchParams {
  query: string;
  queries?: string[];
  fresh?: boolean;
}

export interface FetchParams {
  url: string;
  maxChars?: number;
  fresh?: boolean;
}

export interface McpClient {
  ensureReady(signal: AbortSignal): Promise<void>;
  hasTool(name: string): boolean;
  toolNames(): string[];
  toolProps(name: string): ReadonlySet<string>;
  callWithRetry(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
}

export interface ClientProvider {
  get(): McpClient;
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

export class WebError {
  static describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export class Text {
  static collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  static cap(text: string, cap: number): string {
    if (text.length <= cap) {
      return text;
    }

    return `${text.slice(0, cap)}\n\n[truncated at ${cap} characters]`;
  }
}

export class Timeout {
  static apply(signal: AbortSignal, timeoutSec: number): AbortSignal {
    if (timeoutSec <= 0) {
      return signal;
    }

    try {
      return AbortSignal.any([signal, AbortSignal.timeout(timeoutSec * 1000)]);
    } catch {
      return signal;
    }
  }
}

export class Records {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static firstString(record: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = record[key];

      if (typeof value === "string" && value.trim() !== "") {
        return value;
      }
    }

    return "";
  }

  static resultArray(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (!Records.isRecord(parsed)) {
      return [];
    }

    if (Array.isArray(parsed.results)) {
      return parsed.results;
    }

    if (Records.isRecord(parsed.data) && Array.isArray(parsed.data.results)) {
      return parsed.data.results;
    }

    return [];
  }

  static excerptStrings(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((part): part is string => typeof part === "string")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
}

export class Config {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = merged[key];

      if (Config.isRecord(current) && Config.isRecord(value)) {
        merged[key] = Config.deepMerge(current, value);
      } else if (value !== undefined) {
        merged[key] = value;
      }
    }

    return merged;
  }

  static intBetween(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }

    const normalized = Math.floor(value);

    if (normalized < min || normalized > max) {
      return fallback;
    }

    return normalized;
  }

  static booleanOr(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  static stringOr(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  }

  resolve(
    shipped: Record<string, unknown> | null,
    globalRaw: Record<string, unknown> | null,
    projectRaw: Record<string, unknown> | null,
  ): WebConfig {
    let merged: Record<string, unknown> = { ...DEFAULTS };

    if (Config.isRecord(shipped)) {
      merged = Config.deepMerge(merged, shipped);
    }

    if (globalRaw && Config.isRecord(globalRaw.web)) {
      merged = Config.deepMerge(merged, globalRaw.web);
    }

    if (projectRaw && Config.isRecord(projectRaw.web)) {
      merged = Config.deepMerge(merged, projectRaw.web);
    }

    return {
      endpoint: Config.stringOr(merged.endpoint, DEFAULTS.endpoint),
      numResults: Config.intBetween(merged.numResults, 1, 25, DEFAULTS.numResults),
      maxChars: Config.intBetween(merged.maxChars, 500, 2000000, DEFAULTS.maxChars),
      cacheTtlMin: Config.intBetween(merged.cacheTtlMin, 0, 525600, DEFAULTS.cacheTtlMin),
      cacheMaxEntries: Config.intBetween(merged.cacheMaxEntries, 1, 100000, DEFAULTS.cacheMaxEntries),
      timeoutSec: Config.intBetween(merged.timeoutSec, 0, 600, DEFAULTS.timeoutSec),
      promptSnippet: Config.booleanOr(merged.promptSnippet, DEFAULTS.promptSnippet),
    };
  }
}

export class LazyClientProvider implements ClientProvider {
  private readonly endpoint: string;
  private client: ParallelClient | undefined;

  constructor(endpoint: string) {
    this.endpoint = Endpoint.build(endpoint);
  }

  get(): McpClient {
    if (this.client === undefined) {
      this.client = new ParallelClient(this.endpoint);
    }

    return this.client;
  }
}

export class PromptSnippet {
  static readonly TEXT = [
    "## Web access",
    "Two web tools are available, backed by Parallel's Search MCP server:",
    "- websearch: use it to discover pages and gather current information — research questions, current events, library docs, error messages. Put domain or freshness constraints directly in the query text (e.g. \"... from nodejs.org\", \"... in the last month\"); the optional queries parameter adds 2-3 keyword variants for better coverage. Result excerpts are dense and often answer the question directly.",
    "- webfetch: use it to read the full text of a page when you already have the url, whether from websearch results, the user, or code.",
    "Search first; fetch only the one or two pages whose excerpts are not enough. Responses are cached for a short while; pass fresh: true on either tool when you need live data.",
  ].join("\n");

  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  apply(systemPrompt: unknown): { systemPrompt: string } | undefined {
    if (!this.enabled) {
      return undefined;
    }

    const base = typeof systemPrompt === "string" && systemPrompt !== "" ? `${systemPrompt}\n\n` : "";

    return { systemPrompt: `${base}${PromptSnippet.TEXT}` };
  }
}

export class SearchEngine {
  private readonly config: WebConfig;
  private readonly cache: DiskCache;
  private readonly provider: ClientProvider;
  private readonly sessionId: string;

  constructor(config: WebConfig, cache: DiskCache, provider: ClientProvider, sessionId: string) {
    this.config = config;
    this.cache = cache;
    this.provider = provider;
    this.sessionId = sessionId;
  }

  private cleanQueries(value: string[] | undefined): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const out: string[] = [];

    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }

      const query = Text.collapse(item);

      if (query !== "" && !out.includes(query)) {
        out.push(query);
      }
    }

    return out;
  }

  private hitExcerpt(entry: Record<string, unknown>): string {
    const excerpts = Records.excerptStrings(entry.excerpts);
    const body =
      excerpts.length > 0 ? excerpts.join("\n…\n") : Records.firstString(entry, ["summary", "snippet", "text"]).trim();

    return body.length > EXCERPT_CAP ? `${body.slice(0, EXCERPT_CAP - 1)}…` : body;
  }

  private parseHits(text: string): SearchHit[] {
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }

    const hits: SearchHit[] = [];

    for (const entry of Records.resultArray(parsed)) {
      if (!Records.isRecord(entry)) {
        continue;
      }

      const url = Records.firstString(entry, ["url", "id"]);

      if (!/^https?:\/\//i.test(url)) {
        continue;
      }

      hits.push({
        title: Text.collapse(Records.firstString(entry, ["title"])),
        url,
        publishedDate: Records.firstString(entry, ["publish_date", "publishedDate", "published_date"]).slice(0, 10),
        excerpt: this.hitExcerpt(entry),
      });
    }

    return hits;
  }

  private formatHits(hits: SearchHit[], query: string): string {
    const lines: string[] = [`${hits.length} results for "${query}":`];

    hits.forEach((hit, index) => {
      lines.push("");
      const date = hit.publishedDate !== "" ? ` (${hit.publishedDate})` : "";
      lines.push(`${index + 1}. ${hit.title !== "" ? hit.title : hit.url}${date}`);
      lines.push(`   ${hit.url}`);

      if (hit.excerpt !== "") {
        lines.push(hit.excerpt);
      }
    });

    lines.push("");
    lines.push(
      "Excerpts are usually enough to answer directly; call webfetch with a url when you need the full page.",
    );

    return lines.join("\n");
  }

  private isCachedSearch(value: unknown): value is CachedSearch {
    return (
      Records.isRecord(value) &&
      typeof value.text === "string" &&
      typeof value.tool === "string" &&
      typeof value.count === "number"
    );
  }

  async execute(params: SearchParams, signal: AbortSignal): Promise<ToolOutput> {
    const query = typeof params.query === "string" ? Text.collapse(params.query) : "";

    if (query === "") {
      throw new Error("websearch: the query parameter is required");
    }

    const queries = this.cleanQueries(params.queries);
    const searchQueries = queries.length > 0 ? queries : [query];
    const key = CacheKey.of(["search", query, searchQueries, this.config.numResults]);

    if (params.fresh !== true) {
      const hit = this.cache.get(key);

      if (this.isCachedSearch(hit)) {
        return {
          content: [{ type: "text", text: hit.text }],
          details: { query, tool: hit.tool, count: hit.count, cached: true },
        };
      }
    }

    const requestSignal = Timeout.apply(signal, this.config.timeoutSec);
    const mcp = this.provider.get();

    try {
      await mcp.ensureReady(requestSignal);

      if (!mcp.hasTool(SEARCH_TOOL)) {
        const available = mcp.toolNames().join(", ");

        throw new Error(
          `server does not expose ${SEARCH_TOOL}; available tools: ${available !== "" ? available : "none"}`,
        );
      }

      const props = mcp.toolProps(SEARCH_TOOL);
      const args = ArgPicker.pick(props, {
        objective: query,
        search_queries: searchQueries,
        session_id: this.sessionId,
      });
      const result = await mcp.callWithRetry(SEARCH_TOOL, args, requestSignal);
      const hits = this.parseHits(result.text).slice(0, this.config.numResults);
      const rendered = Text.cap(hits.length > 0 ? this.formatHits(hits, query) : result.text, SEARCH_TEXT_CAP);
      this.cache.set(key, { text: rendered, tool: SEARCH_TOOL, count: hits.length } satisfies CachedSearch);

      return {
        content: [{ type: "text", text: rendered }],
        details: { query, tool: SEARCH_TOOL, count: hits.length, cached: false },
      };
    } catch (error) {
      throw new Error(`websearch: ${WebError.describe(error)}`);
    }
  }
}

export class FetchEngine {
  private readonly config: WebConfig;
  private readonly cache: DiskCache;
  private readonly provider: ClientProvider;
  private readonly sessionId: string;
  private readonly extractor: HtmlExtractor;
  private readonly direct: DirectFetcher;

  constructor(
    config: WebConfig,
    cache: DiskCache,
    provider: ClientProvider,
    sessionId: string,
    extractor: HtmlExtractor = new HtmlExtractor(),
    direct: DirectFetcher = new DirectFetcher(extractor),
  ) {
    this.config = config;
    this.cache = cache;
    this.provider = provider;
    this.sessionId = sessionId;
    this.extractor = extractor;
    this.direct = direct;
  }

  private resolveMaxChars(value: number | undefined): number {
    if (typeof value === "number" && Number.isFinite(value) && value >= 100) {
      return Math.floor(value);
    }

    return this.config.maxChars;
  }

  private pageBody(entry: Record<string, unknown>): string {
    const direct = Records.firstString(entry, ["full_content", "text", "content", "markdown"]);

    if (direct !== "") {
      return direct;
    }

    return Records.excerptStrings(entry.excerpts).join("\n…\n");
  }

  private parsePage(text: string, fallbackUrl: string): { title: string; url: string; text: string } {
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      return { title: "", url: fallbackUrl, text };
    }

    for (const entry of Records.resultArray(parsed)) {
      if (!Records.isRecord(entry)) {
        continue;
      }

      const body = this.pageBody(entry);

      if (body === "") {
        continue;
      }

      return {
        title: Records.firstString(entry, ["title"]),
        url: Records.firstString(entry, ["url", "id"]) || fallbackUrl,
        text: body,
      };
    }

    if (Records.isRecord(parsed)) {
      const body = this.pageBody(parsed);

      if (body !== "") {
        return {
          title: Records.firstString(parsed, ["title"]),
          url: Records.firstString(parsed, ["url"]) || fallbackUrl,
          text: body,
        };
      }
    }

    return {
      title: "",
      url: fallbackUrl,
      text: Records.isRecord(parsed) || Array.isArray(parsed) ? "" : text,
    };
  }

  private finishPage(
    title: string,
    url: string,
    rawText: string,
    source: "mcp" | "direct",
    maxChars: number,
  ): CachedPage {
    const text = this.extractor.normalizeText(rawText);
    const truncated = text.length > maxChars;

    return {
      title: Text.collapse(title),
      url,
      text: truncated ? text.slice(0, maxChars) : text,
      source,
      truncated,
    };
  }

  private renderPage(page: CachedPage, target: URL, maxChars: number, cached: boolean): ToolOutput {
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

  private isCachedPage(value: unknown): value is CachedPage {
    return (
      Records.isRecord(value) &&
      typeof value.title === "string" &&
      typeof value.url === "string" &&
      typeof value.text === "string" &&
      (value.source === "mcp" || value.source === "direct") &&
      typeof value.truncated === "boolean"
    );
  }

  async execute(params: FetchParams, signal: AbortSignal): Promise<ToolOutput> {
    const rawUrl = typeof params.url === "string" ? params.url.trim() : "";

    if (rawUrl === "") {
      throw new Error("webfetch: the url parameter is required");
    }

    let target: URL;

    try {
      target = new URL(rawUrl);
    } catch {
      throw new Error(`webfetch: "${rawUrl}" is not a valid absolute url`);
    }

    const maxChars = this.resolveMaxChars(params.maxChars);
    const key = CacheKey.of(["fetch", target.href, maxChars]);

    if (params.fresh !== true) {
      const hit = this.cache.get(key);

      if (this.isCachedPage(hit)) {
        return this.renderPage(hit, target, maxChars, true);
      }
    }

    const requestSignal = Timeout.apply(signal, this.config.timeoutSec);
    const httpScheme = target.protocol === "http:" || target.protocol === "https:";
    let page: CachedPage | undefined;
    let mcpError = "";

    if (httpScheme) {
      try {
        const mcp = this.provider.get();
        await mcp.ensureReady(requestSignal);

        if (!mcp.hasTool(FETCH_TOOL)) {
          throw new Error(`server does not expose ${FETCH_TOOL}`);
        }

        const props = mcp.toolProps(FETCH_TOOL);
        const args = ArgPicker.pick(props, {
          urls: [target.href],
          full_content: true,
          session_id: this.sessionId,
        });

        if (args.urls === undefined) {
          args.urls = [target.href];
        }

        const result = await mcp.callWithRetry(FETCH_TOOL, args, requestSignal);
        const parsed = this.parsePage(result.text, target.href);

        if (Text.collapse(parsed.text) !== "") {
          page = this.finishPage(parsed.title, parsed.url, parsed.text, "mcp", maxChars);
        } else {
          mcpError = "parallel mcp returned no text for this url";
        }
      } catch (error) {
        mcpError = WebError.describe(error);
      }

      if (page === undefined && requestSignal.aborted) {
        throw new Error(`webfetch: request aborted or timed out (${mcpError})`);
      }
    }

    if (page === undefined) {
      try {
        const fetched = await this.direct.fetch(target, requestSignal);
        page = this.finishPage(fetched.title, fetched.url, fetched.text, "direct", maxChars);
      } catch (error) {
        const directError = WebError.describe(error);

        if (mcpError !== "") {
          throw new Error(`webfetch: parallel mcp failed (${mcpError}); direct fetch failed (${directError})`);
        }

        throw new Error(`webfetch: ${directError}`);
      }
    }

    if (page.text === "") {
      throw new Error(`webfetch: no readable text found at ${target.href}`);
    }

    this.cache.set(key, page);

    return this.renderPage(page, target, maxChars, false);
  }
}
