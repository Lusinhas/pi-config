import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Config } from "../../src/status/config.ts";
import { SegmentStore } from "../../src/status/store.ts";
import { SEGMENT_IDS, type SegmentId, type SegmentToggle } from "../../src/status/index.ts";

const shipped = {
  order: ["model", "mode", "role", "git", "context", "ide", "usage", "todos", "cwd", "clock"],
  separator: " │ ",
  segments: {
    model: { enabled: true },
    mode: { enabled: true },
    role: { enabled: true },
    git: { enabled: true },
    context: { enabled: true },
    ide: { enabled: true },
    usage: { enabled: true },
    todos: { enabled: true },
    cwd: { enabled: true },
    clock: { enabled: true }
  },
  gitIntervalMs: 5000,
  gitTimeoutMs: 3000,
  refreshMs: 30000,
  warnPercent: 80,
  errorPercent: 95
};

function segments(overrides: Partial<Record<SegmentId, boolean>>): Record<SegmentId, SegmentToggle> {
  const out = {} as Record<SegmentId, SegmentToggle>;

  for (const id of SEGMENT_IDS) {
    out[id] = { enabled: overrides[id] ?? true };
  }

  return out;
}

describe("Config.fromRaw merge and fallbacks", () => {
  test("shipped defaults produce the canonical config", () => {
    const config = Config.fromRaw(shipped, undefined, undefined);

    expect(config.order).toEqual([...SEGMENT_IDS]);
    expect(config.separator).toBe(" │ ");
    expect(config.gitIntervalMs).toBe(5000);
    expect(config.gitTimeoutMs).toBe(3000);
    expect(config.refreshMs).toBe(30000);
    expect(config.warnPercent).toBe(80);
    expect(config.errorPercent).toBe(95);
  });

  test("project overlay wins over global overlay", () => {
    const global = { statusline: { separator: " - ", refreshMs: 1000 } };
    const project = { statusline: { separator: " :: " } };
    const config = Config.fromRaw(shipped, global, project);

    expect(config.separator).toBe(" :: ");
    expect(config.refreshMs).toBe(1000);
  });

  test("invalid per-key values fall back individually", () => {
    const global = {
      statusline: {
        separator: "",
        gitIntervalMs: -5,
        refreshMs: "no",
        warnPercent: 0,
        errorPercent: 250
      }
    };
    const config = Config.fromRaw(shipped, global, undefined);

    expect(config.separator).toBe(" │ ");
    expect(config.gitIntervalMs).toBe(5000);
    expect(config.refreshMs).toBe(30000);
    expect(config.warnPercent).toBe(80);
    expect(config.errorPercent).toBe(95);
  });

  test("percent boundary accepts 100 and rejects above", () => {
    const at = Config.fromRaw(shipped, { statusline: { warnPercent: 100 } }, undefined);
    const over = Config.fromRaw(shipped, { statusline: { warnPercent: 100.1 } }, undefined);

    expect(at.warnPercent).toBe(100);
    expect(over.warnPercent).toBe(80);
  });
});

describe("Config.sanitizeOrder", () => {
  test("keeps valid ids in order, dedupes, appends missing", () => {
    const order = Config.sanitizeOrder(["clock", "model", "clock", "bogus", "cwd"]);

    expect(order.slice(0, 3)).toEqual(["clock", "model", "cwd"]);
    expect(order.length).toBe(SEGMENT_IDS.length);
    expect(new Set(order).size).toBe(SEGMENT_IDS.length);
  });

  test("non-array falls back to canonical order", () => {
    expect(Config.sanitizeOrder("nope")).toEqual([...SEGMENT_IDS]);
    expect(Config.sanitizeOrder(undefined)).toEqual([...SEGMENT_IDS]);
  });
});

describe("Config.sanitizeSegments", () => {
  test("reads booleans and falls back to true otherwise", () => {
    const out = Config.sanitizeSegments({
      model: { enabled: false },
      git: { enabled: "yes" },
      clock: 5
    });

    expect(out.model.enabled).toBe(false);
    expect(out.git.enabled).toBe(true);
    expect(out.clock.enabled).toBe(true);
    expect(Object.keys(out).length).toBe(SEGMENT_IDS.length);
  });

  test("non-object value yields all-enabled", () => {
    const out = Config.sanitizeSegments(null);

    for (const id of SEGMENT_IDS) {
      expect(out[id].enabled).toBe(true);
    }
  });
});

describe("Config.readJson and overlayFrom", () => {
  test("readJson swallows missing or invalid files", () => {
    expect(Config.readJson(join(tmpdir(), "definitely-missing-xyz.json"))).toBeUndefined();
  });

  test("overlayFrom extracts the statusline section", () => {
    expect(Config.overlayFrom({ statusline: { separator: "x" } })).toEqual({ separator: "x" });
    expect(Config.overlayFrom({ other: 1 })).toBeUndefined();
    expect(Config.overlayFrom([1, 2])).toBeUndefined();
    expect(Config.overlayFrom(null)).toBeUndefined();
  });
});

describe("SegmentStore.persist", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "statusline-"));
    file = join(dir, "suite.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes only segments, preserves other root and statusline keys", () => {
    writeFileSync(
      file,
      JSON.stringify({ other: { keep: 1 }, statusline: { separator: " - ", segments: { model: { enabled: true } } } }),
      "utf8"
    );

    const store = new SegmentStore(dir, file);
    const outcome = store.persist(segments({ model: false, git: false }));

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe(`Statusline preferences saved to ${file}`);

    const written = JSON.parse(readFileSync(file, "utf8"));

    expect(written.other).toEqual({ keep: 1 });
    expect(written.statusline.separator).toBe(" - ");
    expect(written.statusline.segments.model).toEqual({ enabled: false });
    expect(written.statusline.segments.git).toEqual({ enabled: false });
    expect(Object.keys(written.statusline.segments).length).toBe(SEGMENT_IDS.length);
  });

  test("creates file when missing with trailing newline", () => {
    const store = new SegmentStore(dir, file);
    const outcome = store.persist(segments({}));

    expect(outcome.ok).toBe(true);
    const text = readFileSync(file, "utf8");

    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).statusline.segments.clock).toEqual({ enabled: true });
  });

  test("refuses invalid JSON", () => {
    writeFileSync(file, "{ not json", "utf8");
    const store = new SegmentStore(dir, file);
    const outcome = store.persist(segments({}));

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(`Statusline not saved: ${file} contains invalid JSON`);
  });

  test("refuses non-object JSON", () => {
    writeFileSync(file, "[1,2,3]", "utf8");
    const store = new SegmentStore(dir, file);
    const outcome = store.persist(segments({}));

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(`Statusline not saved: ${file} is not a JSON object`);
  });

  test("empty existing file is treated as fresh root", () => {
    writeFileSync(file, "   ", "utf8");
    const store = new SegmentStore(dir, file);
    const outcome = store.persist(segments({ model: false }));

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).statusline.segments.model).toEqual({ enabled: false });
  });
});
