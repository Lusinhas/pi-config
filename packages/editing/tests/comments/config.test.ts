import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Config, isMode, isRecord, MODES } from "../../src/comments/config.ts";

const shipped = {
  mode: "block",
  maxFindings: 10,
  allowMarker: "@allow-comment",
  ignore: ["**/node_modules/**", "**/dist/**"],
  detectors: { narration: true, fillerdoc: true, changemarker: true, todo: true, separator: true },
};

const configUrl = new URL("../../config.json", import.meta.url);
const configPath = configUrl.pathname;
const hasPackageConfig = existsSync(configPath);

function commentsSection(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(configUrl, "utf8")) as Record<string, unknown>;
  const section = raw.comments;

  if (!isRecord(section)) {
    throw new Error("config.json is missing a 'comments' section");
  }

  return section;
}

describe("MODES + guards", () => {
  test("MODES order is block, warn, off", () => {
    expect([...MODES]).toEqual(["block", "warn", "off"]);
  });

  test("isMode accepts only the three modes", () => {
    expect(isMode("block")).toBe(true);
    expect(isMode("warn")).toBe(true);
    expect(isMode("off")).toBe(true);
    expect(isMode("loud")).toBe(false);
    expect(isMode(undefined)).toBe(false);
    expect(isMode(3)).toBe(false);
  });

  test("isRecord rejects arrays and null", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("default config", () => {
  test("derives defaults from shipped json", () => {
    const config = new Config(shipped);
    expect(config.defaultConfig()).toEqual(shipped);
  });

  test("invalid shipped values fall back to hard defaults", () => {
    const config = new Config({ mode: "loud", maxFindings: 0, allowMarker: "  ", ignore: "nope" });
    const out = config.defaultConfig();
    expect(out.mode).toBe("block");
    expect(out.maxFindings).toBe(10);
    expect(out.allowMarker).toBe("@allow-comment");
    expect(out.ignore).toEqual(Config.hardDefaults().ignore);
    expect(out.detectors).toEqual(Config.hardDefaults().detectors);
  });
});

describe("resolve / merge", () => {
  test("no overrides returns the defaults", () => {
    const config = new Config(shipped);
    expect(config.resolve([])).toEqual(shipped);
  });

  test("project override wins over user override", () => {
    const config = new Config(shipped);
    const out = config.resolve([{ mode: "warn" }, { mode: "off" }]);
    expect(out.mode).toBe("off");
  });

  test("invalid mode override falls back to shipped default", () => {
    const config = new Config(shipped);
    expect(config.resolve([{ mode: "yelling" }]).mode).toBe("block");
  });

  test("maxFindings floored and clamped, invalid falls back", () => {
    const config = new Config(shipped);
    expect(config.resolve([{ maxFindings: 4.9 }]).maxFindings).toBe(4);
    expect(config.resolve([{ maxFindings: 0 }]).maxFindings).toBe(10);
    expect(config.resolve([{ maxFindings: -3 }]).maxFindings).toBe(10);
    expect(config.resolve([{ maxFindings: Number.POSITIVE_INFINITY }]).maxFindings).toBe(10);
    expect(config.resolve([{ maxFindings: "5" }]).maxFindings).toBe(10);
  });

  test("allowMarker trimmed; blank falls back", () => {
    const config = new Config(shipped);
    expect(config.resolve([{ allowMarker: "  @keep  " }]).allowMarker).toBe("@keep");
    expect(config.resolve([{ allowMarker: "   " }]).allowMarker).toBe("@allow-comment");
    expect(config.resolve([{ allowMarker: 5 }]).allowMarker).toBe("@allow-comment");
  });

  test("ignore arrays replace, not merge; blanks/non-strings dropped", () => {
    const config = new Config(shipped);
    const out = config.resolve([{ ignore: ["**/a/**", "", "  ", 5, "**/b/**"] }]);
    expect(out.ignore).toEqual(["**/a/**", "**/b/**"]);
  });

  test("non-array ignore falls back to shipped default ignore", () => {
    const config = new Config(shipped);
    expect(config.resolve([{ ignore: "x" }]).ignore).toEqual(shipped.ignore);
  });

  test("detector toggles: only strict booleans apply, unknown keys ignored", () => {
    const config = new Config(shipped);
    const out = config.resolve([{ detectors: { narration: false, todo: "no", bogus: true } }]);
    expect(out.detectors.narration).toBe(false);
    expect(out.detectors.todo).toBe(true);
    expect(out.detectors).not.toHaveProperty("bogus");
  });

  test("non-record detectors keeps defaults", () => {
    const config = new Config(shipped);
    expect(config.resolve([{ detectors: [] }]).detectors).toEqual(shipped.detectors);
  });

  test("deepMerge merges nested records and replaces arrays", () => {
    const config = new Config(shipped);
    const merged = config.deepMerge({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 9 }, list: [3] });
    expect(merged).toEqual({ a: { x: 1, y: 9 }, list: [3] });
  });

  test("resolve does not mutate the default config", () => {
    const config = new Config(shipped);
    config.resolve([{ ignore: ["**/x/**"], detectors: { todo: false } }]);
    expect(config.defaultConfig().ignore).toEqual(shipped.ignore);
    expect(config.defaultConfig().detectors.todo).toBe(true);
  });
});

describe.skipIf(!hasPackageConfig)("package-root config.json comments section", () => {
  test("shipped defaults parse and seed a Config equal to hard defaults", () => {
    const config = new Config(commentsSection());
    expect(config.defaultConfig()).toEqual(Config.hardDefaults());
  });

  test("a .comments override deep-merges over the shipped defaults", () => {
    const config = new Config(commentsSection());
    const out = config.resolve([{ mode: "warn", detectors: { todo: false } }]);
    expect(out.mode).toBe("warn");
    expect(out.detectors.todo).toBe(false);
    expect(out.detectors.narration).toBe(true);
    expect(out.ignore).toEqual(Config.hardDefaults().ignore);
  });
});
