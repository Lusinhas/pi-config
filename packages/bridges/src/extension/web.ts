import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DiskCache } from "../web/cache.ts";
import {
  FetchEngine,
  LazyClientProvider,
  PromptSnippet,
  SearchEngine,
  type FetchParams,
  type SearchParams,
  type ToolOutput,
  type WebConfig,
} from "../web/index.ts";
import type { LifecycleHub } from "./lifecycle.ts";

interface BeforeAgentStartEvent {
  systemPrompt?: unknown;
}

export class WebRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: WebConfig;
  private readonly hub: LifecycleHub;
  private readonly cache: DiskCache;
  private readonly provider: LazyClientProvider;
  private readonly sessionId: string;
  private readonly search: SearchEngine;
  private readonly fetch: FetchEngine;
  private readonly snippet: PromptSnippet;

  constructor(pi: ExtensionAPI, config: WebConfig, hub: LifecycleHub) {
    this.pi = pi;
    this.config = config;
    this.hub = hub;
    this.cache = new DiskCache(config.cacheTtlMin, config.cacheMaxEntries);
    this.provider = new LazyClientProvider(config.endpoint);
    this.sessionId = randomUUID();
    this.search = new SearchEngine(config, this.cache, this.provider, this.sessionId);
    this.fetch = new FetchEngine(config, this.cache, this.provider, this.sessionId);
    this.snippet = new PromptSnippet(config.promptSnippet);
  }

  register(): void {
    this.pi.registerTool({
      name: "websearch",
      label: "Web Search",
      description:
        "Search the web through Parallel's Search MCP server. Returns a list of results with title, url, publication date, and a dense excerpt that is often enough to answer directly. Use webfetch afterwards when you need full page content.",
      parameters: Type.Object({
        query: Type.String({
          description:
            'Natural-language description of what the search should find. Include any domain or freshness constraints directly in the text, e.g. "release notes from nodejs.org in the last month"',
        }),
        queries: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional 2-3 concise keyword queries (3-6 words each) related to the query; improves coverage",
          }),
        ),
        fresh: Type.Optional(Type.Boolean({ description: "Bypass the local cache and force a live search" })),
      }),
      execute: async (_toolCallId: string, params: SearchParams, signal: AbortSignal): Promise<ToolOutput> =>
        this.search.execute(params, signal),
    });

    this.pi.registerTool({
      name: "webfetch",
      label: "Web Fetch",
      description:
        "Fetch the readable text content of a web page by url through Parallel's Search MCP server, falling back to a direct HTTP fetch with local html-to-text extraction when the server is unavailable.",
      parameters: Type.Object({
        url: Type.String({ description: "Absolute url of the page to fetch" }),
        maxChars: Type.Optional(
          Type.Number({ description: "Maximum characters of page text to return (default 40000)" }),
        ),
        fresh: Type.Optional(Type.Boolean({ description: "Bypass the local cache and force a live fetch" })),
      }),
      execute: async (_toolCallId: string, params: FetchParams, signal: AbortSignal): Promise<ToolOutput> =>
        this.fetch.execute(params, signal),
    });

    this.hub.on<BeforeAgentStartEvent, { systemPrompt: string }>("before_agent_start", (event) =>
      this.snippet.apply(event.systemPrompt),
    );
  }
}
