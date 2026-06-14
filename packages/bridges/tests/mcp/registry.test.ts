import { describe, expect, test } from "bun:test";
import {
  CommandHandler,
  McpRegistry,
  ServerFormatter,
  type CommandSession,
  type ManagedServer,
  type RegistryCollaborators,
} from "../../src/mcp/index.ts";
import { ServerCache, TailTruncator, parsePromptArgs, type ServerSpec } from "../../src/mcp/cache.ts";
import { OAuth, TokenStore } from "../../src/mcp/oauth.ts";

function stdioSpec(overrides: Partial<ServerSpec> = {}): ServerSpec {
  return {
    kind: "stdio",
    name: "alpha",
    command: "node",
    args: [],
    env: {},
    framing: "ndjson",
    enabled: true,
    allow: null,
    deny: [],
    timeoutMs: null,
    lazy: true,
    source: "config",
    ...overrides,
  } as ServerSpec;
}

function httpSpec(overrides: Partial<ServerSpec> = {}): ServerSpec {
  return {
    kind: "http",
    name: "beta",
    url: "https://example.test/mcp",
    headers: {},
    enabled: true,
    allow: null,
    deny: [],
    timeoutMs: null,
    lazy: true,
    source: "config",
    ...overrides,
  } as ServerSpec;
}

function collaborators(overrides: Partial<RegistryCollaborators> = {}): RegistryCollaborators {
  const truncator = new TailTruncator();
  const missingDir = "/tmp/mcp-registry-tests-missing";

  return {
    oauth: new OAuth(new TokenStore(`${missingDir}/suite.json`)),
    cache: new ServerCache(missingDir),
    truncate: (text, options) => truncator.truncate(text, options),
    sendUserMessage: () => undefined,
    toolRegistrar: { register: () => undefined },
    commandRegistrar: { register: () => undefined },
    ...overrides,
  };
}

const options = {
  outputLimit: 25600,
  inlineLimit: 8192,
  requestTimeoutMs: 60000,
  startTimeoutMs: 20000,
  idleMs: 300000,
  stderrLines: 20,
};

describe("parsePromptArgs", () => {
  const defs = [
    { name: "topic", description: "", required: true },
    { name: "depth", description: "", required: false },
  ];

  test("named key=value pairs", () => {
    expect(parsePromptArgs("topic=cats depth=2", defs)).toEqual({ topic: "cats", depth: "2" });
  });

  test("strips wrapping double quotes from a single token", () => {
    expect(parsePromptArgs('topic="bigcats"', defs)).toEqual({ topic: "bigcats" });
  });

  test("leftovers fill the first unset declared arg", () => {
    expect(parsePromptArgs("just some words", defs)).toEqual({ topic: "just some words" });
  });

  test("unknown key=value tokens become leftovers", () => {
    expect(parsePromptArgs("nope=1 depth=3", defs)).toEqual({ depth: "3", topic: "nope=1" });
  });

  test("empty input yields empty object", () => {
    expect(parsePromptArgs("", defs)).toEqual({});
  });
});

describe("ServerFormatter", () => {
  test("empty list message is verbatim", () => {
    const registry = new McpRegistry(options, collaborators());
    const formatter = new ServerFormatter(registry);

    expect(formatter.list()).toBe("No MCP servers configured. Add entries under mcp.servers in suite.json or to .mcp.json.");
  });

  test("servers are listed sorted by name", () => {
    const registry = new McpRegistry(options, collaborators());
    registry.addServer(httpSpec({ name: "zeta" }));
    registry.addServer(stdioSpec({ name: "alpha" }));
    const formatter = new ServerFormatter(registry);
    const lines = formatter.list().split("\n");

    expect(lines[0]).toBe("MCP servers:");
    expect(lines[1]).toContain("alpha:");
    expect(lines[2]).toContain("zeta:");
  });

  test("lazy stopped server with cached tools shows start-on-first-use", () => {
    const registry = new McpRegistry(options, collaborators());
    registry.addServer(stdioSpec());
    const server = registry.get("alpha") as ManagedServer;
    server.tools = [{ name: "t", description: "", inputSchema: null }];
    const formatter = new ServerFormatter(registry);

    expect(formatter.server(server)).toBe(
      "  alpha: stopped [stdio; config; lazy, starts on first use; 1 tools, 0 prompts, 0 resources]",
    );
  });

  test("disabled and error notes render", () => {
    const registry = new McpRegistry(options, collaborators());
    registry.addServer(stdioSpec({ enabled: false }));
    const server = registry.get("alpha") as ManagedServer;
    server.error = "boom";
    const formatter = new ServerFormatter(registry);

    expect(formatter.server(server)).toBe("  alpha: stopped (boom) [stdio; config; lazy; disabled]");
  });

  test("http server needs-auth tag", () => {
    const registry = new McpRegistry(options, collaborators());
    registry.addServer(httpSpec());
    const server = registry.get("beta") as ManagedServer;
    server.needsAuth = true;
    const formatter = new ServerFormatter(registry);

    expect(formatter.server(server)).toBe("  beta: stopped [http; config; lazy; needs auth]");
  });
});

describe("CommandHandler", () => {
  function setup(): { handler: CommandHandler; registry: McpRegistry; notes: [string, string][]; session: CommandSession } {
    const registry = new McpRegistry(options, collaborators());
    registry.addServer(stdioSpec());
    registry.addServer(httpSpec());
    const formatter = new ServerFormatter(registry);
    const handler = new CommandHandler(registry, formatter);
    const notes: [string, string][] = [];
    const session: CommandSession = {
      hasUI: true,
      notify: (message, level) => notes.push([message, level]),
      authorize: async () => undefined,
    };

    return { handler, registry, notes, session };
  }

  test("no args lists servers", async () => {
    const { handler, notes, session } = setup();
    await handler.handle("", session);

    expect(notes[0][1]).toBe("info");
    expect(notes[0][0]).toContain("MCP servers:");
  });

  test("unknown subcommand errors", async () => {
    const { handler, notes, session } = setup();
    await handler.handle("frobnicate alpha", session);

    expect(notes[0]).toEqual([
      'Unknown subcommand "frobnicate". Usage: /mcp | /mcp restart <server> | /mcp auth <server>',
      "error",
    ]);
  });

  test("missing server name errors", async () => {
    const { handler, notes, session } = setup();
    await handler.handle("restart", session);

    expect(notes[0]).toEqual(["Usage: /mcp restart <server>", "error"]);
  });

  test("unknown server lists known names", async () => {
    const { handler, notes, session } = setup();
    await handler.handle("restart ghost", session);

    expect(notes[0][0]).toBe('Unknown MCP server "ghost". Known servers: alpha, beta');
    expect(notes[0][1]).toBe("error");
  });

  test("restart disabled server is rejected", async () => {
    const { handler, registry, notes, session } = setup();
    (registry.get("alpha") as ManagedServer).spec = stdioSpec({ enabled: false });
    await handler.handle("restart alpha", session);

    expect(notes[0]).toEqual(['MCP server "alpha" is disabled in its configuration.', "error"]);
  });

  test("auth on stdio server is rejected", async () => {
    const { handler, notes, session } = setup();
    await handler.handle("auth alpha", session);

    expect(notes[0]).toEqual(['MCP server "alpha" runs over stdio; OAuth only applies to HTTP servers.', "error"]);
  });

  test("auth without UI is silent", async () => {
    const { handler, notes, session } = setup();
    await handler.handle("auth beta", { ...session, hasUI: false });

    expect(notes).toHaveLength(0);
  });

  test("completions filter by prefix and include auth only for http", () => {
    const { handler } = setup();
    const all = handler.completions("");

    expect(all?.map((c) => c.value)).toEqual(["restart alpha", "restart beta", "auth beta"]);

    const filtered = handler.completions("auth");

    expect(filtered?.map((c) => c.value)).toEqual(["auth beta"]);
    expect(handler.completions("nomatch")).toBeNull();
  });
});

describe("McpRegistry hydrateFromCache", () => {
  test("registers cached tools and prompts without connecting", () => {
    const registered: string[] = [];
    const commands: string[] = [];
    const collab = collaborators({
      cache: {
        load: () => ({
          tools: [
            { name: "search", description: "", inputSchema: { type: "object" } },
            { name: "blocked", description: "", inputSchema: null },
          ],
          prompts: [{ name: "ask", description: "", arguments: [] }],
          resourceCount: 0,
        }),
        save: () => undefined,
      } as unknown as ServerCache,
      toolRegistrar: { register: (descriptor) => registered.push(descriptor.name) },
      commandRegistrar: { register: (descriptor) => commands.push(descriptor.name) },
    });
    const registry = new McpRegistry(options, collab);
    registry.addServer(stdioSpec({ deny: ["blocked"] }));
    registry.startAll();
    const server = registry.get("alpha") as ManagedServer;

    expect(server.tools.map((t) => t.name)).toEqual(["search"]);
    expect(registered).toEqual(["mcpalphasearch"]);
    expect(commands).toEqual(["mcp:alpha:ask"]);
  });

  test("disabled servers are skipped by startAll", () => {
    let loads = 0;
    const collab = collaborators({
      cache: {
        load: () => {
          loads += 1;
          return null;
        },
        save: () => undefined,
      } as unknown as ServerCache,
    });
    const registry = new McpRegistry(options, collab);
    registry.addServer(stdioSpec({ enabled: false }));
    registry.startAll();

    expect(loads).toBe(0);
  });
});
