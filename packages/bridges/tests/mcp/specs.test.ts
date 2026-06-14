import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Policy,
  collectServerSpecs,
  parseServerSpec,
  readMcpJson,
  sanitize,
  type ServerSpec,
} from "../../src/mcp/cache.ts";

describe("sanitize", () => {
  test("lowercases and strips non-alphanumerics", () => {
    expect(sanitize("My-Server_1")).toBe("myserver1");
    expect(sanitize("Hello World")).toBe("helloworld");
  });

  test("empty result becomes x", () => {
    expect(sanitize("___")).toBe("x");
    expect(sanitize("")).toBe("x");
  });
});

describe("parseServerSpec", () => {
  test("returns null for non-records and blank names", () => {
    expect(parseServerSpec("a", null, true, "config", "ndjson")).toBeNull();
    expect(parseServerSpec("", { command: "x" }, true, "config", "ndjson")).toBeNull();
  });

  test("http takes precedence over command", () => {
    const spec = parseServerSpec("a", { url: "https://h", command: "c" }, true, "config", "ndjson");

    expect(spec?.kind).toBe("http");
  });

  test("stdio framing falls back to default", () => {
    const spec = parseServerSpec("a", { command: "c" }, true, "config", "lsp");

    expect(spec?.kind).toBe("stdio");
    expect((spec as { framing: string }).framing).toBe("lsp");
  });

  test("explicit framing overrides default", () => {
    const spec = parseServerSpec("a", { command: "c", framing: "ndjson" }, true, "config", "lsp");

    expect((spec as { framing: string }).framing).toBe("ndjson");
  });

  test("enabled defaults true unless literally false", () => {
    expect(parseServerSpec("a", { command: "c" }, true, "config", "ndjson")?.enabled).toBe(true);
    expect(parseServerSpec("a", { command: "c", enabled: false }, true, "config", "ndjson")?.enabled).toBe(false);
    expect(parseServerSpec("a", { command: "c", enabled: 0 }, true, "config", "ndjson")?.enabled).toBe(true);
  });

  test("lazy honours boolean, else default", () => {
    expect(parseServerSpec("a", { command: "c" }, false, "config", "ndjson")?.lazy).toBe(false);
    expect(parseServerSpec("a", { command: "c", lazy: true }, false, "config", "ndjson")?.lazy).toBe(true);
    expect(parseServerSpec("a", { command: "c", lazy: "yes" }, false, "config", "ndjson")?.lazy).toBe(false);
  });

  test("allow null vs deny default and timeout validation", () => {
    const spec = parseServerSpec("a", { command: "c" }, true, "config", "ndjson");

    expect(spec?.allow).toBeNull();
    expect(spec?.deny).toEqual([]);
    expect(spec?.timeoutMs).toBeNull();

    const withLists = parseServerSpec(
      "a",
      { command: "c", allow: ["x", 5], deny: ["y"], timeoutMs: 5000 },
      true,
      "config",
      "ndjson",
    );

    expect(withLists?.allow).toEqual(["x"]);
    expect(withLists?.deny).toEqual(["y"]);
    expect(withLists?.timeoutMs).toBe(5000);

    const badTimeout = parseServerSpec("a", { command: "c", timeoutMs: 0 }, true, "config", "ndjson");

    expect(badTimeout?.timeoutMs).toBeNull();
  });

  test("env and headers coerce scalar values to strings", () => {
    const stdio = parseServerSpec("a", { command: "c", env: { A: 1, B: true, C: "x", D: {} } }, true, "config", "ndjson");

    expect((stdio as { env: Record<string, string> }).env).toEqual({ A: "1", B: "true", C: "x" });

    const http = parseServerSpec("a", { url: "https://h", headers: { X: 2 } }, true, "config", "ndjson");

    expect((http as { headers: Record<string, string> }).headers).toEqual({ X: "2" });
  });
});

describe("Policy.toolAllowed", () => {
  const base = parseServerSpec("a", { command: "c" }, true, "config", "ndjson") as ServerSpec;

  test("deny wins over allow", () => {
    const spec: ServerSpec = { ...base, allow: ["t"], deny: ["t"] };

    expect(Policy.toolAllowed(spec, "t")).toBe(false);
  });

  test("allow null permits all", () => {
    expect(Policy.toolAllowed({ ...base, allow: null }, "anything")).toBe(true);
  });

  test("allow list restricts", () => {
    const spec: ServerSpec = { ...base, allow: ["keep"], deny: [] };

    expect(Policy.toolAllowed(spec, "keep")).toBe(true);
    expect(Policy.toolAllowed(spec, "drop")).toBe(false);
  });
});

describe("collectServerSpecs merge order", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-specs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("project .mcp.json wins by name over config", () => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { dup: { command: "project" } } }));
    const specs = collectServerSpecs({ dup: { command: "config" } }, "ndjson", dir, true);
    const dup = specs.find((s) => s.name === "dup");

    expect(dup?.source).toBe("project .mcp.json");
    expect((dup as { command: string }).command).toBe("project");
  });

  test("invalid entries are dropped", () => {
    const specs = collectServerSpecs({ good: { command: "c" }, bad: { nope: true } }, "ndjson", dir, true);

    expect(specs.map((s) => s.name)).toEqual(["good"]);
  });
});

describe("readMcpJson", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-json-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file yields empty object", () => {
    expect(readMcpJson(join(dir, "absent.json"))).toEqual({});
  });

  test("reads mcpServers map", () => {
    const path = join(dir, ".mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { a: { command: "c" } } }));

    expect(readMcpJson(path)).toEqual({ a: { command: "c" } });
  });

  test("non-record mcpServers yields empty", () => {
    const path = join(dir, ".mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: [] }));

    expect(readMcpJson(path)).toEqual({});
  });
});
