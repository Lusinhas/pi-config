import { describe, expect, test } from "bun:test";
import {
  ModeState,
  globToRegex,
  isHashMode,
  matchedPattern,
  modeForModel,
} from "../../src/lines/mode.ts";
import type { HashMode } from "../../src/lines/mode.ts";

describe("isHashMode", () => {
  test("accepts the two known modes", () => {
    expect(isHashMode("hashline")).toBe(true);
    expect(isHashMode("compat")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isHashMode("auto")).toBe(false);
    expect(isHashMode("")).toBe(false);
    expect(isHashMode(null)).toBe(false);
    expect(isHashMode(7)).toBe(false);
  });
});

describe("globToRegex", () => {
  test("translates star to dot-star anchored case-insensitive", () => {
    const regex = globToRegex("claude-*");
    expect(regex).not.toBeNull();
    expect(regex?.test("claude-opus")).toBe(true);
    expect(regex?.test("CLAUDE-sonnet")).toBe(true);
    expect(regex?.test("gpt-4")).toBe(false);
  });

  test("escapes regex metacharacters in literal parts", () => {
    const regex = globToRegex("a.b*");
    expect(regex?.test("a.bcd")).toBe(true);
    expect(regex?.test("axbcd")).toBe(false);
  });

  test("anchors so partial does not match", () => {
    const regex = globToRegex("foo");
    expect(regex?.test("foo")).toBe(true);
    expect(regex?.test("foobar")).toBe(false);
  });
});

describe("matchedPattern", () => {
  const modes: Record<string, HashMode> = {
    "gpt-*": "compat",
    sonnet: "hashline",
  };

  test("empty model id matches nothing", () => {
    expect(matchedPattern("", modes)).toBeNull();
  });

  test("glob pattern matches model id", () => {
    expect(matchedPattern("gpt-4o", modes)).toBe("gpt-*");
  });

  test("substring pattern is case insensitive", () => {
    expect(matchedPattern("Claude-3.5-Sonnet", modes)).toBe("sonnet");
  });

  test("no match returns null", () => {
    expect(matchedPattern("haiku", modes)).toBeNull();
  });

  test("iterates insertion order returning first match", () => {
    const ordered: Record<string, HashMode> = { "*opus*": "compat", "claude-opus*": "hashline" };
    expect(matchedPattern("claude-opus-4", ordered)).toBe("*opus*");
  });

  test("skips empty pattern keys", () => {
    const withEmpty: Record<string, HashMode> = { "": "compat", opus: "hashline" };
    expect(matchedPattern("opus", withEmpty)).toBe("opus");
  });
});

describe("modeForModel", () => {
  const modes: Record<string, HashMode> = { "gpt-*": "compat" };

  test("returns mapped mode on match", () => {
    expect(modeForModel("gpt-4", modes, "hashline")).toBe("compat");
  });

  test("returns fallback on no match", () => {
    expect(modeForModel("claude", modes, "hashline")).toBe("hashline");
  });
});

describe("ModeState", () => {
  test("defaults to fallback with default origin", () => {
    const state = new ModeState({}, "hashline");
    expect(state.current()).toBe("hashline");
    expect(state.origin()).toBe("default");
    expect(state.model()).toBe("");
  });

  test("model match drives mode with model origin", () => {
    const state = new ModeState({ "gpt-*": "compat" }, "hashline");
    state.setModel("gpt-4o");
    expect(state.current()).toBe("compat");
    expect(state.origin()).toBe("model");
    expect(state.model()).toBe("gpt-4o");
  });

  test("manual override wins over model mapping", () => {
    const state = new ModeState({ "gpt-*": "compat" }, "hashline");
    state.setModel("gpt-4o");
    state.setOverride("hashline");
    expect(state.current()).toBe("hashline");
    expect(state.origin()).toBe("manual");
  });

  test("clearing override returns to model mapping", () => {
    const state = new ModeState({ "gpt-*": "compat" }, "hashline");
    state.setModel("gpt-4o");
    state.setOverride("hashline");
    state.setOverride(null);
    expect(state.current()).toBe("compat");
    expect(state.origin()).toBe("model");
  });

  test("setModel returns the resulting mode", () => {
    const state = new ModeState({ "gpt-*": "compat" }, "hashline");
    expect(state.setModel("gpt-4")).toBe("compat");
  });
});
