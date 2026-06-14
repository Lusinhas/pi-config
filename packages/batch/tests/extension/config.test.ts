import { describe, expect, test } from "bun:test";
import { Loader } from "../../src/extension/config.ts";

describe("Loader.resolve", () => {
  test("returns the fallback when no layers apply", () => {
    expect(Loader.resolve([null, null])).toEqual(Loader.FALLBACK);
  });

  test("overrides maxCalls with a positive integer", () => {
    const config = Loader.resolve([{ maxCalls: 8 }]);

    expect(config.maxCalls).toBe(8);
  });

  test("ignores invalid maxCalls values", () => {
    expect(Loader.resolve([{ maxCalls: 0 }]).maxCalls).toBe(Loader.FALLBACK.maxCalls);
    expect(Loader.resolve([{ maxCalls: -3 }]).maxCalls).toBe(Loader.FALLBACK.maxCalls);
    expect(Loader.resolve([{ maxCalls: 2.5 }]).maxCalls).toBe(Loader.FALLBACK.maxCalls);
    expect(Loader.resolve([{ maxCalls: "ten" }]).maxCalls).toBe(Loader.FALLBACK.maxCalls);
  });

  test("keeps only known batchable tool names and dedupes", () => {
    const config = Loader.resolve([{ tools: ["read", "read", "todo", "subagent", 5] }]);

    expect(config.tools).toEqual(["read", "todo"]);
  });

  test("falls back when the tools list has no valid names", () => {
    expect(Loader.resolve([{ tools: ["subagent", "web"] }]).tools).toEqual(Loader.FALLBACK.tools);
    expect(Loader.resolve([{ tools: "read" }]).tools).toEqual(Loader.FALLBACK.tools);
  });

  test("later layers override earlier layers", () => {
    const config = Loader.resolve([{ maxCalls: 4, tools: ["read"] }, { maxCalls: 16 }]);

    expect(config).toEqual({ maxCalls: 16, tools: ["read"] });
  });
});
