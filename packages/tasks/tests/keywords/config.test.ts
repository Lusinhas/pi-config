import { describe, expect, test } from "bun:test";
import { Config } from "../../src/keywords/config.ts";
import { Scanner } from "../../src/keywords/scan.ts";

describe("Config merge and validation", () => {
  test("defaults when no layers", () => {
    const config = new Config([]);
    expect(config.values.adaptive).toBe(false);
    expect(config.values.orchestrate).toBe(true);
    expect(config.values.ultrawork).toBe(true);
    expect(config.values.restore).toBe(true);
    expect(config.values.adaptiveMin).toBe("low");
    expect(config.values.adaptiveMax).toBe("high");
    expect(config.values.metMarker).toBe("<goal-met/>");
    expect(config.values.keywords).toEqual({
      ultrathink: "xhigh",
      "think harder": "high",
      "think ultra": "high",
      quickthink: "low",
    });
  });

  test("override deep-merges keywords entrywise", () => {
    const config = new Config([{ keywords: { ultrathink: "high", custom: "low" } }]);
    expect(config.values.keywords.ultrathink).toBe("high");
    expect(config.values.keywords.custom).toBe("low");
    expect(config.values.keywords.quickthink).toBe("low");
  });

  test("project layer wins over user layer", () => {
    const config = new Config([{ adaptive: true }, { adaptive: false }]);
    expect(config.values.adaptive).toBe(false);
  });

  test("invalid scalar falls back to default", () => {
    const config = new Config([{ orchestrate: "yes", adaptiveMin: "huge" }]);
    expect(config.values.orchestrate).toBe(true);
    expect(config.values.adaptiveMin).toBe("low");
  });

  test("non-record keywords falls back to defaults copy", () => {
    const config = new Config([{ keywords: ["nope"] }]);
    expect(config.values.keywords).toEqual(Config.defaults.keywords);
  });

  test("adaptiveMin > adaptiveMax triggers swap", () => {
    const config = new Config([{ adaptiveMin: "high", adaptiveMax: "low" }]);
    expect(config.values.adaptiveMin).toBe("low");
    expect(config.values.adaptiveMax).toBe("high");
  });

  test("metMarker stored trimmed; blank falls back to default", () => {
    const config = new Config([{ metMarker: "   <done/>   " }]);
    expect(config.values.metMarker).toBe("<done/>");
    const blank = new Config([{ metMarker: "   " }]);
    expect(blank.values.metMarker).toBe("<goal-met/>");
  });

  test("default keywords object is not mutated by override", () => {
    const config = new Config([{ keywords: { ultrathink: "high" } }]);
    config.values.keywords.ultrathink = "off";
    expect(Config.defaults.keywords.ultrathink).toBe("xhigh");
  });

  test("non-record layers are ignored", () => {
    const config = new Config([null, 42, "string", undefined]);
    expect(config.values.adaptive).toBe(false);
  });
});

describe("note builders", () => {
  const config = new Config([]);

  test("xhigh thinking note", () => {
    expect(config.thinkingNote("xhigh", ["ultrathink"])).toBe(
      '["ultrathink" invoked: maximum reasoning effort was requested for this turn. Think as deeply and as long as needed before acting.]',
    );
  });

  test("high thinking note", () => {
    expect(config.thinkingNote("high", ["think harder"])).toBe(
      '["think harder" invoked: heightened reasoning effort was requested for this turn. Reason carefully before acting.]',
    );
  });

  test("medium thinking note", () => {
    expect(config.thinkingNote("medium", ["a", "b"])).toBe(
      '["a", "b" invoked: reasoning effort for this turn was set to medium.]',
    );
  });

  test("low and others fall through to minimal note", () => {
    expect(config.thinkingNote("low", ["quickthink"])).toBe(
      '["quickthink" invoked: minimal reasoning overhead was requested for this turn. Be quick and direct.]',
    );
    expect(config.thinkingNote("off", ["x"])).toContain("minimal reasoning overhead");
  });

  test("orchestrate note varies by task availability", () => {
    expect(config.orchestrateNote(true)).toContain("delegate the parallelizable ones to the task tool");
    expect(config.orchestrateNote(false)).toContain("work through them systematically");
  });

  test("ultrawork note embeds marker", () => {
    expect(config.ultraworkNote("<goal-met/>")).toContain("include <goal-met/> in your final message");
  });
});

describe("summary formatter", () => {
  test("formats matchers descending by priority and full state", () => {
    const config = new Config([]);
    const matchers = Scanner.buildMatchers(config.values.keywords);
    const text = config.summary({ matchers, adaptive: false, current: "medium", baseline: undefined });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Thinking keywords:");
    expect(lines[1]).toBe("  ultrathink -> xhigh");
    expect(lines).toContain("Orchestrate keyword: on (orchestrate)");
    expect(lines).toContain("Ultrawork keywords: on (ulw, ultrawork)");
    expect(lines).toContain("Adaptive thinking: off (bounds low-high, config default off)");
    expect(lines).toContain("Restore baseline after turn: on");
    expect(lines[lines.length - 1]).toBe("Current level: medium  Baseline: medium");
  });

  test("no matchers reports none configured", () => {
    const config = new Config([{ keywords: { "": "high" } }]);
    const matchers = Scanner.buildMatchers({ "": "high" });
    const text = config.summary({ matchers, adaptive: true, current: undefined, baseline: undefined });
    expect(text.split("\n")[1]).toBe("  (none configured)");
    expect(text).toContain("Current level: unknown  Baseline: unknown");
  });
});
