import { describe, expect, test } from "bun:test";
import { FallbackEngine, type FallbackPorts } from "../../src/router/fallback.ts";
import type { FallbackConfig } from "../../src/router/index.ts";
import type { AgentModel } from "../../src/router/models.ts";

const catalog: AgentModel[] = [
  { id: "claude-opus-4-8", provider: "anthropic" },
  { id: "claude-sonnet-4-6", provider: "anthropic" },
  { id: "claude-haiku-4-5", provider: "anthropic" }
];

function config(overrides: Partial<FallbackConfig> = {}): FallbackConfig {
  return {
    enabled: true,
    threshold: 2,
    failWindowSec: 120,
    restoreAfterMin: 10,
    chains: { "claude-opus": ["claude-sonnet-4-6", "claude-haiku-4-5"], "claude-sonnet": ["claude-haiku-4-5"] },
    ...overrides
  };
}

interface Recorder {
  current: AgentModel;
  selected: AgentModel[];
  notices: Array<{ text: string; kind: string }>;
  confirmResult: boolean;
  confirmAsked: boolean;
  setModelResult: boolean;
}

function makePorts(recorder: Recorder, hasUI = false): FallbackPorts {
  return {
    registry: { getAll: () => catalog },
    get currentModel() {
      return recorder.current;
    },
    hasUI,
    setModel: async (model: AgentModel) => {
      if (recorder.setModelResult) {
        recorder.selected.push(model);
        recorder.current = model;
      }

      return recorder.setModelResult;
    },
    confirm: async () => {
      recorder.confirmAsked = true;

      return recorder.confirmResult;
    },
    notify: (text, kind) => {
      recorder.notices.push({ text, kind });
    }
  };
}

function recorder(start: AgentModel): Recorder {
  return { current: start, selected: [], notices: [], confirmResult: true, confirmAsked: false, setModelResult: true };
}

describe("FallbackEngine.statusOf", () => {
  test("parses number and numeric string", () => {
    expect(FallbackEngine.statusOf({ status: 503 })).toBe(503);
    expect(FallbackEngine.statusOf({ status: "429" })).toBe(429);
    expect(FallbackEngine.statusOf({ status: "abc" })).toBeUndefined();
    expect(FallbackEngine.statusOf({})).toBeUndefined();
    expect(FallbackEngine.statusOf(undefined)).toBeUndefined();
  });
});

describe("FallbackEngine status classification", () => {
  test("isFailure covers 429 and 5xx only", () => {
    expect(FallbackEngine.isFailure(429)).toBe(true);
    expect(FallbackEngine.isFailure(503)).toBe(true);
    expect(FallbackEngine.isFailure(404)).toBe(false);
    expect(FallbackEngine.isFailure(200)).toBe(false);
  });

  test("isSuccess covers the 2xx range only", () => {
    expect(FallbackEngine.isSuccess(200)).toBe(true);
    expect(FallbackEngine.isSuccess(204)).toBe(true);
    expect(FallbackEngine.isSuccess(404)).toBe(false);
    expect(FallbackEngine.isSuccess(503)).toBe(false);
  });
});

describe("FallbackEngine.chainFor", () => {
  test("first matching pattern in insertion order wins", () => {
    const engine = new FallbackEngine(config());

    expect(engine.chainFor("anthropic/claude-opus-4-8")).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5"]);
    expect(engine.chainFor("anthropic/claude-sonnet-4-6")).toEqual(["claude-haiku-4-5"]);
    expect(engine.chainFor("openai/gpt-5")).toBeUndefined();
  });
});

describe("FallbackEngine.recordResponse failure counting", () => {
  test("falls back after threshold failures and notifies", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec);

    await engine.recordResponse({ status: 503 }, ports, 1000);
    expect(engine.active).toBeNull();
    expect(rec.selected.length).toBe(0);

    await engine.recordResponse({ status: 503 }, ports, 2000);
    expect(engine.active?.fallbackId).toBe("anthropic/claude-sonnet-4-6");
    expect(rec.selected[0].id).toBe("claude-sonnet-4-6");
    expect(rec.notices[0].kind).toBe("warning");
    expect(rec.notices[0].text).toBe(
      "router: anthropic/claude-opus-4-8 failed 2x (last HTTP 503) — fell back to anthropic/claude-sonnet-4-6; anthropic/claude-opus-4-8 will be offered back after 10 min of stable turns"
    );
  });

  test("resets the streak when outside the window", async () => {
    const engine = new FallbackEngine(config({ failWindowSec: 1 }));
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec);

    await engine.recordResponse({ status: 429 }, ports, 0);
    await engine.recordResponse({ status: 429 }, ports, 5000);

    expect(engine.active).toBeNull();
  });

  test("a 2xx clears the failure counter", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec);

    await engine.recordResponse({ status: 500 }, ports, 0);
    await engine.recordResponse({ status: 200 }, ports, 10);
    await engine.recordResponse({ status: 500 }, ports, 20);

    expect(engine.active).toBeNull();
  });

  test("no chain match notifies and does not switch", async () => {
    const engine = new FallbackEngine(config({ chains: {} }));
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec);

    await engine.recordResponse({ status: 503 }, ports, 0);
    await engine.recordResponse({ status: 503 }, ports, 10);

    expect(engine.active).toBeNull();
    expect(rec.notices[0].text).toBe(
      "router: anthropic/claude-opus-4-8 failed 2x (HTTP 503) but no fallback chain matches it"
    );
  });

  test("ignores unknown current model", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder({});
    const ports = makePorts(rec);

    await engine.recordResponse({ status: 503 }, ports, 0);
    await engine.recordResponse({ status: 503 }, ports, 10);

    expect(engine.active).toBeNull();
    expect(rec.notices.length).toBe(0);
  });

  test("skips chain entries recently over threshold", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[1]);
    const ports = makePorts(rec);

    await engine.recordResponse({ status: 503 }, ports, 0);
    await engine.recordResponse({ status: 503 }, ports, 10);

    expect(engine.active?.fallbackId).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("FallbackEngine.onModelSelect", () => {
  test("drops active fallback on a real select away", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec);
    await engine.recordResponse({ status: 503 }, ports, 0);
    await engine.recordResponse({ status: 503 }, ports, 10);
    expect(engine.active).not.toBeNull();

    engine.onModelSelect({ id: "claude-opus-4-8", provider: "anthropic" });

    expect(engine.active).toBeNull();
  });

  test("keeps active when select targets the fallback id", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec);
    await engine.recordResponse({ status: 503 }, ports, 0);
    await engine.recordResponse({ status: 503 }, ports, 10);

    engine.onModelSelect({ id: "claude-sonnet-4-6", provider: "anthropic" });

    expect(engine.active?.fallbackId).toBe("anthropic/claude-sonnet-4-6");
  });

  test("non-record model leaves active untouched", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec);
    await engine.recordResponse({ status: 503 }, ports, 0);
    await engine.recordResponse({ status: 503 }, ports, 10);

    engine.onModelSelect("not a record");

    expect(engine.active).not.toBeNull();
  });
});

describe("FallbackEngine.onTurnEnd restore", () => {
  async function activate(engine: FallbackEngine, rec: Recorder, ports: FallbackPorts): Promise<void> {
    await engine.recordResponse({ status: 503 }, ports, 0);
    await engine.recordResponse({ status: 503 }, ports, 10);
  }

  test("restores after a stable streak when confirmed", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec, true);
    await activate(engine, rec, ports);

    const streakBase = 1000;
    await engine.recordResponse({ status: 200 }, ports, streakBase);

    await engine.onTurnEnd(ports, streakBase + 9 * 60 * 1000);
    expect(engine.active).not.toBeNull();

    await engine.onTurnEnd(ports, streakBase + 10 * 60 * 1000);
    expect(rec.confirmAsked).toBe(true);
    expect(engine.active).toBeNull();
    expect(rec.current.id).toBe("claude-opus-4-8");
    expect(rec.notices.some(n => n.text === "router: restored anthropic/claude-opus-4-8 after the provider recovered")).toBe(true);
  });

  test("declining the restore drops the active fallback", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    rec.confirmResult = false;
    const ports = makePorts(rec, true);
    await activate(engine, rec, ports);
    await engine.recordResponse({ status: 200 }, ports, 1000);

    await engine.onTurnEnd(ports, 1000 + 10 * 60 * 1000);

    expect(engine.active).toBeNull();
    expect(rec.current.id).toBe("claude-sonnet-4-6");
  });

  test("a failure on the fallback model resets the streak", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec, true);
    await activate(engine, rec, ports);
    await engine.recordResponse({ status: 200 }, ports, 1000);
    await engine.recordResponse({ status: 503 }, ports, 2000);

    await engine.onTurnEnd(ports, 2000 + 20 * 60 * 1000);

    expect(engine.active).not.toBeNull();
    expect(rec.confirmAsked).toBe(false);
  });

  test("no UI auto-approves restore", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec, false);
    await activate(engine, rec, ports);
    await engine.recordResponse({ status: 200 }, ports, 1000);

    await engine.onTurnEnd(ports, 1000 + 10 * 60 * 1000);

    expect(rec.confirmAsked).toBe(false);
    expect(engine.active).toBeNull();
    expect(rec.current.id).toBe("claude-opus-4-8");
  });
});

describe("FallbackEngine.onSessionStart", () => {
  test("clears failures and active", async () => {
    const engine = new FallbackEngine(config());
    const rec = recorder(catalog[0]);
    const ports = makePorts(rec);
    await engine.recordResponse({ status: 503 }, ports, 0);
    await engine.recordResponse({ status: 503 }, ports, 10);
    expect(engine.active).not.toBeNull();

    engine.onSessionStart();

    expect(engine.active).toBeNull();
  });
});
