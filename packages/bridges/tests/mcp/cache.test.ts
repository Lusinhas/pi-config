import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerCache, specHash, type ServerSpec } from "../../src/mcp/cache.ts";

function stdioSpec(overrides: Partial<ServerSpec> = {}): ServerSpec {
  return {
    kind: "stdio",
    name: "demo",
    command: "node",
    args: ["server.js"],
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

function httpSpec(): ServerSpec {
  return {
    kind: "http",
    name: "demo",
    url: "https://example.test/mcp",
    headers: {},
    enabled: true,
    allow: null,
    deny: [],
    timeoutMs: null,
    lazy: true,
    source: "config",
  };
}

describe("specHash", () => {
  test("twelve hex chars and stable", () => {
    const hash = specHash(stdioSpec());

    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(specHash(stdioSpec())).toBe(hash);
  });

  test("changes with command and allow but not with name", () => {
    const base = specHash(stdioSpec());

    expect(specHash(stdioSpec({ name: "other" }))).toBe(base);
    expect(specHash(stdioSpec({ command: "deno" }))).not.toBe(base);
    expect(specHash(stdioSpec({ allow: ["only"] }))).not.toBe(base);
  });

  test("stdio and http identities differ", () => {
    expect(specHash(stdioSpec())).not.toBe(specHash(httpSpec()));
  });
});

describe("ServerCache", () => {
  let dir: string;
  let cache: ServerCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-cache-"));
    cache = new ServerCache(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("save then load roundtrips lists", () => {
    const spec = stdioSpec();
    cache.save(spec, {
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      prompts: [{ name: "p", description: "", arguments: [{ name: "a", description: "", required: true }] }],
      resourceCount: 2,
    });

    const loaded = cache.load(spec);

    expect(loaded?.tools).toEqual([{ name: "t", description: "d", inputSchema: { type: "object" } }]);
    expect(loaded?.prompts[0].arguments[0].required).toBe(true);
    expect(loaded?.resourceCount).toBe(2);
  });

  test("load returns null when missing", () => {
    expect(cache.load(stdioSpec())).toBeNull();
  });

  test("load rejects when stored hash differs", () => {
    const spec = stdioSpec();
    const path = join(dir, `demo-${specHash(spec)}.json`);
    writeFileSync(path, JSON.stringify({ hash: "deadbeefdead", tools: [], prompts: [], resourceCount: 0 }));

    expect(cache.load(spec)).toBeNull();
  });

  test("save does not prune stale sibling files", () => {
    const stale = join(dir, "demo-aaaaaaaaaaaa.json");
    writeFileSync(stale, "{}");
    const other = join(dir, "another-bbbbbbbbbbbb.json");
    writeFileSync(other, "{}");

    cache.save(stdioSpec(), { tools: [], prompts: [], resourceCount: 0 });
    const files = readdirSync(dir).sort();

    expect(files).toContain("another-bbbbbbbbbbbb.json");
    expect(files).toContain("demo-aaaaaaaaaaaa.json");
    expect(files).toContain(`demo-${specHash(stdioSpec())}.json`);
  });

  test("malformed tools array is rejected on load", () => {
    const spec = stdioSpec();
    const path = join(dir, `demo-${specHash(spec)}.json`);
    writeFileSync(path, JSON.stringify({ hash: specHash(spec), tools: [{ description: "no name" }], prompts: [] }));

    expect(cache.load(spec)).toBeNull();
  });
});
