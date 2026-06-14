import { describe, expect, test } from "bun:test";
import { Config } from "../../src/keywords/config.ts";
import { KeywordsEngine } from "../../src/keywords/index.ts";
import type { ThinkingPort } from "../../src/keywords/index.ts";
import type { ThinkingLevel } from "../../src/keywords/scan.ts";

class FakePort implements ThinkingPort {
  level: ThinkingLevel | undefined = "medium";

  task = false;

  failApply = false;

  applied: ThinkingLevel[] = [];

  current(): ThinkingLevel | undefined {
    return this.level;
  }

  apply(target: ThinkingLevel): boolean {
    if (this.failApply) {

      return false;
    }

    this.level = target;
    this.applied.push(target);

    return true;
  }

  taskAvailable(): boolean {
    return this.task;
  }
}

function build(overrides: Record<string, unknown> = {}): { engine: KeywordsEngine; port: FakePort } {
  const port = new FakePort();
  const engine = new KeywordsEngine(new Config([overrides]), port);

  return { engine, port };
}

describe("input gating", () => {
  test("non-interactive source is ignored", () => {
    const { engine } = build();
    expect(engine.processInput("ultrathink please", "file")).toEqual({ action: "continue" });
  });

  test("empty and whitespace prompts continue", () => {
    const { engine } = build();
    expect(engine.processInput("   ", "interactive")).toEqual({ action: "continue" });
  });

  test("slash command lines continue", () => {
    const { engine } = build();
    expect(engine.processInput("  /keywords adaptive", "interactive")).toEqual({ action: "continue" });
  });

  test("non-string text continues", () => {
    const { engine } = build();
    expect(engine.processInput(42, "interactive")).toEqual({ action: "continue" });
  });
});

describe("thinking keyword transform", () => {
  test("strips keyword, applies level, appends note", () => {
    const { engine, port } = build();
    port.level = "medium";
    const result = engine.processInput("ultrathink about the design", "interactive");
    expect(result.action).toBe("transform");

    if (result.action === "transform") {
      expect(result.text).toBe(
        'about the design\n\n["ultrathink" invoked: maximum reasoning effort was requested for this turn. Think as deeply and as long as needed before acting.]',
      );
    }

    expect(port.level).toBe("xhigh");
  });

  test("note-only output when body becomes empty", () => {
    const { engine } = build();
    const result = engine.processInput("ultrathink", "interactive");

    if (result.action === "transform") {
      expect(result.text.startsWith("[")).toBe(true);
      expect(result.text.includes("\n\n")).toBe(false);
    }
  });

  test("does not apply when before equals target", () => {
    const { engine, port } = build();
    port.level = "xhigh";
    engine.processInput("ultrathink now", "interactive");
    expect(port.applied).toEqual([]);
  });
});

describe("orchestrate and ultrawork", () => {
  test("orchestrate note uses task tool variant when available", () => {
    const { engine, port } = build();
    port.task = true;
    const result = engine.processInput("orchestrate the build", "interactive");

    if (result.action === "transform") {
      expect(result.text).toContain("delegate the parallelizable ones to the task tool");
    }
  });

  test("ultrawork embeds the configured marker", () => {
    const { engine } = build({ metMarker: "<custom/>" });
    const result = engine.processInput("ulw on this", "interactive");

    if (result.action === "transform") {
      expect(result.text).toContain("include <custom/> in your final message");
    }
  });

  test("notes appended in order thinking, orchestrate, ultrawork", () => {
    const { engine, port } = build();
    port.level = "low";
    const result = engine.processInput("ultrathink orchestrate ultrawork go", "interactive");

    if (result.action === "transform") {
      const idxThink = result.text.indexOf("maximum reasoning");
      const idxOrch = result.text.indexOf("orchestrate invoked");
      const idxUlw = result.text.indexOf("ultrawork invoked");
      expect(idxThink).toBeLessThan(idxOrch);
      expect(idxOrch).toBeLessThan(idxUlw);
    }
  });

  test("disabled orchestrate keeps the word in text", () => {
    const { engine } = build({ orchestrate: false });
    const result = engine.processInput("orchestrate the thing", "interactive");
    expect(result.action).toBe("continue");
  });
});

describe("baseline and restore", () => {
  test("session_start sets baseline; agent_end restores", () => {
    const { engine, port } = build();
    port.level = "medium";
    engine.onSessionStart();
    engine.processInput("ultrathink", "interactive");
    expect(port.level).toBe("xhigh");
    engine.onAgentEnd();
    expect(port.level).toBe("medium");
  });

  test("agent_end with no pending restore does nothing", () => {
    const { engine, port } = build();
    port.level = "high";
    engine.onAgentEnd();
    expect(port.applied).toEqual([]);
  });

  test("restore off keeps the new level after the turn", () => {
    const { engine, port } = build({ restore: false });
    port.level = "low";
    engine.processInput("ultrathink", "interactive");
    engine.onAgentEnd();
    expect(port.level).toBe("xhigh");
  });
});

describe("selfQueue protocol", () => {
  test("self change is consumed by thinking_level_select head match", () => {
    const { engine, port } = build();
    port.level = "low";
    engine.onSessionStart();
    engine.processInput("ultrathink", "interactive");
    engine.onThinkingLevelSelect("xhigh");
    engine.onAgentEnd();
    expect(port.level).toBe("low");
  });

  test("user selection sets baseline so restore returns there after a keyword turn", () => {
    const { engine, port } = build();
    port.level = "low";
    engine.onSessionStart();
    engine.onThinkingLevelSelect("high");
    port.level = "high";
    engine.processInput("ultrathink please", "interactive");
    expect(port.level).toBe("xhigh");
    engine.onAgentEnd();
    expect(port.level).toBe("high");
  });

  test("failed apply rolls back the queued entry", () => {
    const { engine, port } = build();
    port.level = "low";
    port.failApply = true;
    engine.processInput("ultrathink", "interactive");
    port.failApply = false;
    engine.onThinkingLevelSelect("xhigh");
    expect(port.applied).toEqual([]);
  });
});

describe("adaptive nudge", () => {
  const heavyPrompt =
    "please refactor and audit the whole architecture so the system stays maintainable across the entire codebase for the team";

  test("nudges up on heavy prompt when enabled and no explicit selection", () => {
    const { engine, port } = build({ adaptive: true });
    port.level = "low";
    engine.onSessionStart();
    engine.processInput(heavyPrompt, "interactive");
    expect(port.level).toBe("medium");
  });

  test("does not nudge after explicit user selection in same turn", () => {
    const { engine, port } = build({ adaptive: true });
    port.level = "low";
    engine.onSessionStart();
    engine.onThinkingLevelSelect("low");
    engine.processInput(heavyPrompt, "interactive");
    expect(port.applied).toEqual([]);
  });

  test("disabled adaptive does nothing", () => {
    const { engine, port } = build({ adaptive: false });
    port.level = "low";
    engine.processInput("please refactor and audit the architecture thoroughly", "interactive");
    expect(port.applied).toEqual([]);
  });

  test("nudge still returns continue", () => {
    const { engine } = build({ adaptive: true });
    const result = engine.processInput("fix this typo", "interactive");
    expect(result.action).toBe("continue");
  });

  test("baseline is restored after a swapped-bounds adaptive nudge", () => {
    const { engine, port } = build({ adaptive: true, adaptiveMin: "high", adaptiveMax: "low" });
    port.level = "low";
    engine.onSessionStart();
    engine.processInput(heavyPrompt, "interactive");
    expect(port.level).toBe("medium");
    engine.onAgentEnd();
    expect(port.level).toBe("low");
  });
});

describe("command and completions", () => {
  test("empty args returns summary info", () => {
    const { engine } = build();
    const result = engine.command("");
    expect(result.kind).toBe("info");
    expect(result.message.startsWith("Thinking keywords:")).toBe(true);
  });

  test("adaptive toggles runtime flag without persisting", () => {
    const { engine } = build({ adaptive: false });
    const first = engine.command("adaptive");
    expect(first.message).toContain("enabled");
    const second = engine.command("adaptive off");
    expect(second.message).toContain("disabled");
    const on = engine.command("adaptive on");
    expect(on.message).toContain("enabled");
  });

  test("garbage args returns usage error", () => {
    const { engine } = build();
    const result = engine.command("wat");
    expect(result.kind).toBe("error");
    expect(result.message.startsWith("Usage:")).toBe(true);
  });

  test("completions filter by prefix and return null when empty", () => {
    const { engine } = build();
    expect(engine.completions("ad")).toEqual([
      { value: "adaptive", label: "adaptive" },
      { value: "adaptive on", label: "adaptive on" },
      { value: "adaptive off", label: "adaptive off" },
    ]);
    expect(engine.completions("adaptive o")).toEqual([
      { value: "adaptive on", label: "adaptive on" },
      { value: "adaptive off", label: "adaptive off" },
    ]);
    expect(engine.completions("zzz")).toBeNull();
  });
});
