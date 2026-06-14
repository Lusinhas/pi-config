import { describe, expect, it } from "bun:test";
import { Judge, Verdict } from "../../src/goals/judge.ts";
import type { CompleteResponse, JudgeRegistry } from "../../src/goals/judge.ts";

describe("Verdict.instructions", () => {
  it("is the verbatim eight-line block", () => {
    const lines = Verdict.instructions.split("\n");

    expect(lines.length).toBe(8);
    expect(lines[0]).toBe("You judge whether a coding agent has satisfied a completion condition.");
    expect(lines[3]).toBe("VERDICT: met | unmet | blocked");
    expect(lines[7]).toBe("Otherwise use unmet.");
  });
});

describe("Verdict.clipTail", () => {
  it("returns text unchanged when within or below the limit or when limit disabled", () => {
    expect(Verdict.clipTail("abc", 5)).toBe("abc");
    expect(Verdict.clipTail("abcde", 5)).toBe("abcde");
    expect(Verdict.clipTail("abcdef", 0)).toBe("abcdef");
    expect(Verdict.clipTail("abcdef", -3)).toBe("abcdef");
  });

  it("keeps the tail with a truncation prefix", () => {
    expect(Verdict.clipTail("abcdef", 3)).toBe("[earlier output truncated]\ndef");
  });
});

describe("Verdict.marker", () => {
  it("returns met when the marker is present", () => {
    const v = Verdict.marker("done <goal-met/> now", "<goal-met/>", "judge aborted");

    expect(v.status).toBe("met");
    expect(v.source).toBe("marker");
    expect(v.reason).toBe("found <goal-met/> in the last assistant message (judge aborted)");
  });

  it("returns unmet when the marker is absent", () => {
    const v = Verdict.marker("nope", "<goal-met/>", "reason");

    expect(v.status).toBe("unmet");
    expect(v.reason).toBe("no <goal-met/> marker in the last assistant message (reason)");
  });

  it("never reports met for an empty marker", () => {
    const v = Verdict.marker("anything", "", "cause");

    expect(v.status).toBe("unmet");
  });
});

describe("Verdict.parse", () => {
  it("prefers a tagged verdict line and reason line", () => {
    const v = Verdict.parse("VERDICT: met\nREASON: tests pass");

    expect(v).toEqual({ status: "met", reason: "tests pass", source: "judge" });
  });

  it("parses bold and dashed tag punctuation", () => {
    const v = Verdict.parse("Verdict - **blocked**\nReason: cannot proceed");

    expect(v?.status).toBe("blocked");
    expect(v?.reason).toBe("cannot proceed");
  });

  it("falls back to keyword scan in blocked > unmet > met priority", () => {
    expect(Verdict.parse("it is blocked and unmet")?.status).toBe("blocked");
    expect(Verdict.parse("this is unmet still")?.status).toBe("unmet");
    expect(Verdict.parse("the condition is met")?.status).toBe("met");
  });

  it("downgrades a bare met with a not word to unmet", () => {
    expect(Verdict.parse("the goal is not met")?.status).toBe("unmet");
  });

  it("returns undefined when no status keyword appears or reply is blank", () => {
    expect(Verdict.parse("nothing meaningful here")).toBeUndefined();
    expect(Verdict.parse("   ")).toBeUndefined();
  });

  it("uses the whole reply as the reason when no reason line and clamps to 400 chars", () => {
    const v = Verdict.parse("met because everything works");

    expect(v?.reason).toBe("met because everything works");

    const long = `VERDICT: met\nREASON: ${"x".repeat(500)}`;
    const parsed = Verdict.parse(long);

    expect(parsed?.reason.length).toBe(401);
    expect(parsed?.reason.endsWith("…")).toBe(true);
  });

  it("keeps the punctuation the reason regex captures even when only whitespace follows", () => {
    const v = Verdict.parse("met\nREASON:    ");

    expect(v?.status).toBe("met");
    expect(v?.reason).toBe(":");
  });
});

function registry(overrides: Partial<JudgeRegistry> = {}): JudgeRegistry {
  return { find: () => ({ id: "model" }), ...overrides };
}

describe("Judge.resolveModel", () => {
  const judge = new Judge(async () => ({ content: "" }));

  it("splits provider/modelId and looks it up", () => {
    let seen: [string, string] | undefined;
    const model = judge.resolveModel(
      "anthropic/claude",
      registry({
        find: (provider, modelId) => {
          seen = [provider, modelId];

          return { ok: true };
        },
      }),
    );

    expect(seen).toEqual(["anthropic", "claude"]);
    expect(model).toEqual({ ok: true });
  });

  it("rejects refs without a usable separator position", () => {
    expect(judge.resolveModel("/claude", registry())).toBeUndefined();
    expect(judge.resolveModel("anthropic/", registry())).toBeUndefined();
    expect(judge.resolveModel("noseparator", registry())).toBeUndefined();
  });

  it("rejects when trimmed halves are empty", () => {
    expect(judge.resolveModel("  /  ", registry())).toBeUndefined();
  });

  it("returns undefined when the registry throws or returns a non-object", () => {
    expect(
      judge.resolveModel(
        "a/b",
        registry({
          find: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toBeUndefined();
    expect(judge.resolveModel("a/b", registry({ find: () => undefined }))).toBeUndefined();
  });
});

describe("Judge.resolveAuth", () => {
  it("uses getApiKey first, returning the key even when undefined", async () => {
    const judge = new Judge(async () => ({ content: "" }));
    const auth = await judge.resolveAuth(registry({ getApiKey: async () => "k" }), {});

    expect(auth).toEqual({ apiKey: "k" });

    const empty = await judge.resolveAuth(registry({ getApiKey: async () => undefined }), {});

    expect(empty).toEqual({ apiKey: undefined });
  });

  it("returns no auth when getApiKey throws", async () => {
    const judge = new Judge(async () => ({ content: "" }));
    const auth = await judge.resolveAuth(
      registry({
        getApiKey: async () => {
          throw new Error("x");
        },
      }),
      {},
    );

    expect(auth).toEqual({});
  });

  it("uses getApiKeyAndHeaders only when ok is true and filters headers", async () => {
    const judge = new Judge(async () => ({ content: "" }));
    const auth = await judge.resolveAuth(
      registry({
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "key",
          headers: { a: "1", b: 2, c: "3" },
        }),
      }),
      {},
    );

    expect(auth).toEqual({ apiKey: "key", headers: { a: "1", c: "3" } });
  });

  it("omits empty apiKey and drops headers when none are string-valued", async () => {
    const judge = new Judge(async () => ({ content: "" }));
    const auth = await judge.resolveAuth(
      registry({
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "", headers: { a: 1 } }),
      }),
      {},
    );

    expect(auth).toEqual({});
  });

  it("returns no auth when ok is not true or result is not an object", async () => {
    const judge = new Judge(async () => ({ content: "" }));

    expect(await judge.resolveAuth(registry({ getApiKeyAndHeaders: async () => ({ ok: false, apiKey: "k" }) }), {})).toEqual(
      {},
    );
    expect(await judge.resolveAuth(registry({ getApiKeyAndHeaders: async () => null }), {})).toEqual({});
  });

  it("returns no auth when the registry exposes neither method", async () => {
    const judge = new Judge(async () => ({ content: "" }));

    expect(await judge.resolveAuth(registry(), {})).toEqual({});
  });
});

describe("Judge.judge", () => {
  const base = {
    condition: "ship it",
    lastText: "all done <goal-met/>",
    modelRef: "anthropic/claude",
    timeoutMs: 1000,
    maxChars: 8000,
    metMarker: "<goal-met/>",
  };

  it("returns a marker verdict when the signal is already aborted", async () => {
    const judge = new Judge(async () => ({ content: "VERDICT: met\nREASON: x" }));
    const controller = new AbortController();
    controller.abort();
    const v = await judge.judge({ ...base, registry: registry(), signal: controller.signal });

    expect(v.source).toBe("marker");
    expect(v.reason).toContain("judge aborted");
  });

  it("returns a marker verdict when the model is unresolved", async () => {
    const judge = new Judge(async () => ({ content: "" }));
    const v = await judge.judge({ ...base, modelRef: "bad", registry: registry() });

    expect(v.source).toBe("marker");
    expect(v.reason).toContain('judge model "bad" unavailable');
    expect(v.status).toBe("met");
  });

  it("forwards the prompt and parses a successful judge reply", async () => {
    let captured: { model: unknown; content: string; options: unknown } | undefined;
    const judge = new Judge(async (model, req, options) => {
      captured = { model, content: req.messages[0].content, options };

      return { content: "VERDICT: unmet\nREASON: tests fail", stopReason: "stop" };
    });
    const v = await judge.judge({
      ...base,
      registry: registry({ getApiKey: async () => "k" }),
    });

    expect(v).toEqual({ status: "unmet", reason: "tests fail", source: "judge" });
    expect(captured?.content).toContain("Completion condition:\nship it");
    expect(captured?.content).toContain("Last assistant message:\nall done <goal-met/>");
    expect((captured?.options as { apiKey?: string }).apiKey).toBe("k");
  });

  it("uses the no-output placeholder when last text is blank", async () => {
    let body = "";
    const judge = new Judge(async (_model, req) => {
      body = req.messages[0].content;

      return { content: "VERDICT: unmet\nREASON: nothing", stopReason: "stop" } satisfies CompleteResponse;
    });
    await judge.judge({ ...base, lastText: "   ", registry: registry() });

    expect(body).toContain("Last assistant message:\n(the agent produced no text output)");
  });

  it("falls back to marker on stopReason error with the error message", async () => {
    const judge = new Judge(async () => ({ content: "", stopReason: "error", errorMessage: "rate limited" }));
    const v = await judge.judge({ ...base, registry: registry() });

    expect(v.source).toBe("marker");
    expect(v.reason).toContain("judge call failed: rate limited");
    expect(v.status).toBe("met");
  });

  it("falls back to marker on stopReason aborted without an error message", async () => {
    const judge = new Judge(async () => ({ content: "", stopReason: "aborted" }));
    const v = await judge.judge({ ...base, lastText: "no marker here", registry: registry() });

    expect(v.reason).toContain("judge call aborted");
    expect(v.status).toBe("unmet");
  });

  it("falls back to marker when the reply is unparsable", async () => {
    const judge = new Judge(async () => ({ content: "totally ambiguous", stopReason: "stop" }));
    const v = await judge.judge({ ...base, registry: registry() });

    expect(v.source).toBe("marker");
    expect(v.reason).toContain("judge reply was unparsable");
  });

  it("falls back to marker when the completion throws", async () => {
    const judge = new Judge(async () => {
      throw new Error("network down");
    });
    const v = await judge.judge({ ...base, registry: registry() });

    expect(v.reason).toContain("judge call failed: network down");
  });
});
