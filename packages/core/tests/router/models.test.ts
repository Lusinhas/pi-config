import { describe, expect, test } from "bun:test";
import { ModelCatalog, Models, asThinking, THINKING_LEVELS, errorText, isRecord, type AgentModel } from "../../src/router/models.ts";

const catalog: AgentModel[] = [
  { id: "claude-opus-4-8", provider: "anthropic", name: "Opus" },
  { id: "claude-haiku-4-5", provider: "anthropic", name: "Haiku" },
  { id: "claude-sonnet-4-6", provider: "anthropic", name: "Sonnet" },
  { id: "gpt-5", provider: "openai", name: "GPT 5" }
];

describe("primitives", () => {
  test("isRecord rejects arrays and null", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  test("asThinking accepts only the six levels", () => {
    for (const level of THINKING_LEVELS) {
      expect(asThinking(level)).toBe(level);
    }

    expect(asThinking("max")).toBeUndefined();
    expect(asThinking(5)).toBeUndefined();
  });

  test("errorText unwraps Error and stringifies others", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
  });
});

describe("Models.describe", () => {
  test("provider + id", () => {
    expect(Models.describe({ id: "x", provider: "p" })).toBe("p/x");
  });

  test("id only", () => {
    expect(Models.describe({ id: "x" })).toBe("x");
  });

  test("neither yields unknown", () => {
    expect(Models.describe({ provider: "p" })).toBe("unknown");
    expect(Models.describe(null)).toBe("unknown");
    expect(Models.describe(undefined)).toBe("unknown");
  });
});

describe("Models.same", () => {
  test("compares id and provider", () => {
    expect(Models.same({ id: "x", provider: "p" }, { id: "x", provider: "p" })).toBe(true);
    expect(Models.same({ id: "x", provider: "p" }, { id: "x", provider: "q" })).toBe(false);
    expect(Models.same({ id: "x" }, { id: "y" })).toBe(false);
  });
});

describe("Models.list", () => {
  test("uses getAll when it returns models", async () => {
    const registry = { getAll: () => catalog };

    expect(await Models.list(registry)).toEqual(catalog);
  });

  test("falls through to getAvailable when getAll empty", async () => {
    const registry = { getAll: () => [], getAvailable: () => catalog };

    expect(await Models.list(registry)).toEqual(catalog);
  });

  test("filters entries lacking a string id", async () => {
    const registry = { getAll: () => [{ id: "" }, { provider: "p" }, { id: "ok" }] };

    expect(await Models.list(registry)).toEqual([{ id: "ok" }]);
  });

  test("throwing method is skipped", async () => {
    const registry = {
      getAll: () => {
        throw new Error("nope");
      },
      getAvailable: () => catalog
    };

    expect(await Models.list(registry)).toEqual(catalog);
  });

  test("non-record registry yields empty", async () => {
    expect(await Models.list(null)).toEqual([]);
    expect(await Models.list("x")).toEqual([]);
  });
});

describe("Models.resolveIn", () => {
  test("exact id match", () => {
    const r = Models.resolveIn(catalog, "claude-opus-4-8");

    expect(r.model?.id).toBe("claude-opus-4-8");
    expect(r.suggestions).toEqual([]);
  });

  test("exact provider/id match", () => {
    const r = Models.resolveIn(catalog, "openai/gpt-5");

    expect(r.model?.id).toBe("gpt-5");
  });

  test("exact name match case-insensitive", () => {
    const r = Models.resolveIn(catalog, "haiku");

    expect(r.model?.id).toBe("claude-haiku-4-5");
  });

  test("partial substring returns first match", () => {
    const r = Models.resolveIn(catalog, "opus");

    expect(r.model?.id).toBe("claude-opus-4-8");
  });

  test("empty query yields first five suggestions and no model", () => {
    const r = Models.resolveIn(catalog, "   ");

    expect(r.model).toBeUndefined();
    expect(r.suggestions).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5"
    ]);
  });

  test("unmatched query produces token-scored suggestions", () => {
    const r = Models.resolveIn(catalog, "claude zzz");

    expect(r.model).toBeUndefined();
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.suggestions.every(id => id.includes("claude"))).toBe(true);
  });

  test("empty catalog returns suggestions only", () => {
    const r = Models.resolveIn([], "anything");

    expect(r.model).toBeUndefined();
    expect(r.suggestions).toEqual([]);
  });
});

describe("Models.suggestionsFor", () => {
  test("scores by token length over substring hits, top five", () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ id: `claude-model-${i}`, provider: "anthropic" }));
    const out = Models.suggestionsFor("claude", big);

    expect(out.length).toBe(5);
    expect(out.every(id => id.includes("claude"))).toBe(true);
  });

  test("falls back to first five when no token hits", () => {
    const out = Models.suggestionsFor("zz", catalog);

    expect(out.length).toBe(4);
  });
});

describe("ModelCatalog", () => {
  test("enumerates the registry only once per instance", async () => {
    let calls = 0;
    const registry = {
      getAll: () => {
        calls += 1;

        return catalog;
      }
    };
    const cache = new ModelCatalog(registry);

    expect(await cache.list()).toEqual(catalog);
    expect((await cache.resolve("opus")).model?.id).toBe("claude-opus-4-8");
    expect((await cache.resolve("haiku")).model?.id).toBe("claude-haiku-4-5");
    expect(calls).toBe(1);
  });

  test("invalidate forces a fresh enumeration", async () => {
    let calls = 0;
    const registry = {
      getAll: () => {
        calls += 1;

        return catalog;
      }
    };
    const cache = new ModelCatalog(registry);

    await cache.list();
    cache.invalidate();
    await cache.list();

    expect(calls).toBe(2);
  });
});
