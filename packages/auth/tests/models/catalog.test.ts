import { describe, expect, test } from "bun:test";
import { LONG_CONTEXT_BETA, ModelCatalog } from "../../src/models/catalog.ts";

const catalog = new ModelCatalog();

describe("ModelCatalog", () => {
  test("exposes the four Claude Code models", () => {
    const ids = catalog.models().map((m) => m.id);

    expect(ids).toEqual([
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  test("getOverride matches by substring in insertion order", () => {
    expect(catalog.getOverride("claude-haiku-4-5")).toMatchObject({ disableEffort: true });
    expect(catalog.getOverride("claude-opus-4-8")).toMatchObject({ adaptiveThinking: true });
    expect(catalog.getOverride("claude-opus-4-7")).toMatchObject({ adaptiveThinking: true });
    expect(catalog.getOverride("claude-sonnet-4-6")).toMatchObject({ longContext: true });
    expect(catalog.getOverride("unknown-model")).toBeNull();
  });

  test("haiku betas exclude interleaved thinking and effort and long context", () => {
    const betas = catalog.computeBetas("claude-haiku-4-5");

    expect(betas).not.toContain("interleaved-thinking-2025-05-14");
    expect(betas).not.toContain("effort-2025-11-24");
    expect(betas).not.toContain(LONG_CONTEXT_BETA);
  });

  test("opus 4-8 betas include effort and long context with no duplicates", () => {
    const betas = catalog.computeBetas("claude-opus-4-8");

    expect(betas).toContain("effort-2025-11-24");
    expect(betas).toContain(LONG_CONTEXT_BETA);
    expect(new Set(betas).size).toBe(betas.length);
  });

  test("requestBetas strips the 1M beta when longContext is false", () => {
    expect(catalog.requestBetas("claude-opus-4-8", false)).not.toContain(LONG_CONTEXT_BETA);
  });

  test("requestBetas keeps the 1M beta when longContext is true", () => {
    expect(catalog.requestBetas("claude-opus-4-8", true)).toContain(LONG_CONTEXT_BETA);
  });
});
