import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager, ProfileStore, type ProfilePorts } from "../../src/router/profiles.ts";
import type { ProfileSpec } from "../../src/router/index.ts";
import type { AgentModel } from "../../src/router/models.ts";

const catalog: AgentModel[] = [
  { id: "claude-opus-4-8", provider: "anthropic" },
  { id: "claude-haiku-4-5", provider: "anthropic" }
];

interface Recorder {
  current: AgentModel | null;
  thinking: string;
  activeTools: string[];
  allTools: string[];
  theme: string;
  notices: Array<{ text: string; kind: string }>;
  themeResult: unknown;
  setModelResult: boolean;
  setToolsThrows: boolean;
}

function makeRecorder(): Recorder {
  return {
    current: catalog[0],
    thinking: "medium",
    activeTools: ["read", "write", "bash"],
    allTools: ["read", "write", "bash", "grep"],
    theme: "light",
    notices: [],
    themeResult: { success: true },
    setModelResult: true,
    setToolsThrows: false
  };
}

function makePorts(rec: Recorder, cwd: string, hasUI = true, home = cwd): ProfilePorts {
  return {
    registry: { getAll: () => catalog },
    get currentModel() {
      return rec.current;
    },
    hasUI,
    cwd,
    home,
    setModel: async (model: AgentModel) => {
      if (rec.setModelResult) {
        rec.current = model;
      }

      return rec.setModelResult;
    },
    setThinkingLevel: (level: string) => {
      rec.thinking = level;
    },
    getThinkingLevel: () => rec.thinking,
    getActiveTools: () => rec.activeTools,
    setActiveTools: async (tools: string[]) => {
      if (rec.setToolsThrows) {
        throw new Error("locked");
      }

      rec.activeTools = tools;
    },
    getAllTools: () => rec.allTools,
    setTheme: (theme: string) => {
      rec.theme = theme;

      return rec.themeResult;
    },
    notify: (text, kind) => {
      rec.notices.push({ text, kind });
    }
  };
}

describe("ProfileManager.render", () => {
  test("renders parts in order with active marker", () => {
    const manager = new ProfileManager({
      deep: { model: "claude-opus-4-8", thinking: "xhigh" },
      readonly: { tools: ["read", "grep"] }
    });

    expect(manager.render()).toBe(
      "Profiles (* = active, /profile <name> applies, /profile off reverts):\n" +
        "  deep      model=claude-opus-4-8  thinking=xhigh\n" +
        "  readonly  tools=[read, grep]"
    );
  });

  test("no profiles message", () => {
    expect(new ProfileManager({}).render()).toBe(
      "router: no profiles configured (add them under router.profiles in suite.json)"
    );
  });
});

describe("ProfileManager.unknownProfile", () => {
  test("close matches hint", () => {
    const manager = new ProfileManager({ deep: { model: "m" }, deeper: { model: "m" } });

    expect(manager.unknownProfile("deep")).toBe(
      'router: unknown profile "deep". Close matches: deep, deeper.'
    );
    expect(manager.unknownProfile("deep-x")).toBe(
      'router: unknown profile "deep-x". Close matches: deep.'
    );
  });

  test("available hint when none close", () => {
    const manager = new ProfileManager({ fast: {} });

    expect(manager.unknownProfile("zzz")).toBe('router: unknown profile "zzz". Available: fast.');
  });

  test("no profiles hint", () => {
    expect(new ProfileManager({}).unknownProfile("x")).toBe(
      'router: unknown profile "x". No profiles are configured (add them under router.profiles in suite.json).'
    );
  });
});

describe("ProfileManager apply/revert", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "router-profile-"));
    mkdirSync(join(dir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("applies model, thinking and tools then summarizes", async () => {
    const manager = new ProfileManager({ deep: { model: "claude-haiku-4-5", thinking: "xhigh", tools: ["read", "grep"] } });
    const rec = makeRecorder();
    const ports = makePorts(rec, dir);

    await manager.apply("deep", ports);

    expect(rec.current?.id).toBe("claude-haiku-4-5");
    expect(rec.thinking).toBe("xhigh");
    expect(rec.activeTools).toEqual(["read", "grep"]);
    expect(manager.activeProfile).toBe("deep");
    expect(rec.notices[0]).toEqual({
      text: "router: profile \"deep\" applied — model anthropic/claude-haiku-4-5, thinking xhigh, tools [read, grep]",
      kind: "info"
    });
  });

  test("reports issues for missing model and unknown tools", async () => {
    const manager = new ProfileManager({ x: { model: "ghost", tools: ["read", "nope"] } });
    const rec = makeRecorder();
    const ports = makePorts(rec, dir);

    await manager.apply("x", ports);

    const notice = rec.notices[0];
    expect(notice.kind).toBe("warning");
    expect(notice.text).toContain('model "ghost" not found in the registry');
    expect(notice.text).toContain("unknown tools skipped: nope");
  });

  test("surfaces a thrown setActiveTools error", async () => {
    const manager = new ProfileManager({ x: { tools: ["read"] } });
    const rec = makeRecorder();
    rec.setToolsThrows = true;
    const ports = makePorts(rec, dir);

    await manager.apply("x", ports);

    expect(rec.notices[0].text).toContain("active tool set could not be changed: locked");
  });

  test("unknown profile notifies error", async () => {
    const manager = new ProfileManager({ deep: {} });
    const rec = makeRecorder();
    const ports = makePorts(rec, dir);

    await manager.apply("ghost", ports);

    expect(rec.notices[0].kind).toBe("error");
    expect(rec.notices[0].text.startsWith('router: unknown profile "ghost".')).toBe(true);
  });

  test("revert restores the captured snapshot", async () => {
    const manager = new ProfileManager({ deep: { model: "claude-haiku-4-5", thinking: "xhigh" } });
    const rec = makeRecorder();
    const ports = makePorts(rec, dir);

    await manager.apply("deep", ports);
    await manager.revert(ports);

    expect(rec.current?.id).toBe("claude-opus-4-8");
    expect(rec.thinking).toBe("medium");
    expect(manager.activeProfile).toBeUndefined();
    const revertNotice = rec.notices[rec.notices.length - 1];
    expect(revertNotice.text).toBe('router: profile "deep" off — restored model anthropic/claude-opus-4-8, thinking medium');
  });

  test("revert with no active profile says so", async () => {
    const manager = new ProfileManager({ deep: {} });
    const rec = makeRecorder();
    const ports = makePorts(rec, dir);

    await manager.revert(ports);

    expect(rec.notices[0]).toEqual({ text: "router: no profile is active", kind: "info" });
  });

  test("nothing-to-apply summary when spec has only a theme without UI", async () => {
    const manager = new ProfileManager({ themed: { theme: "dark" } });
    const rec = makeRecorder();
    const ports = makePorts(rec, dir, false);

    await manager.apply("themed", ports);

    expect(rec.notices[0].text).toBe('router: profile "themed" had nothing to apply');
  });

  test("writes and clears style in suite.json preserving other keys", async () => {
    writeFileSync(join(dir, ".pi", "suite.json"), JSON.stringify({ keep: 1, styles: { other: 2 } }), "utf8");
    const manager = new ProfileManager({ styled: { style: "compact" } });
    const rec = makeRecorder();
    const ports = makePorts(rec, dir);

    await manager.apply("styled", ports);
    const afterApply = JSON.parse(readFileSync(join(dir, ".pi", "suite.json"), "utf8"));
    expect(afterApply.keep).toBe(1);
    expect(afterApply.styles).toEqual({ other: 2, active: "compact" });

    await manager.revert(ports);
    const afterRevert = JSON.parse(readFileSync(join(dir, ".pi", "suite.json"), "utf8"));
    expect(afterRevert.styles).toEqual({ other: 2 });
    expect(afterRevert.keep).toBe(1);
  });
});

describe("ProfileStore", () => {
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "router-store-"));
    home = mkdtempSync(join(tmpdir(), "router-home-"));
    mkdirSync(join(dir, ".pi"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("settingsTheme prefers project over user home", () => {
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ theme: "fallback" }), "utf8");
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ theme: "  midnight  " }), "utf8");
    const store = new ProfileStore(dir, home);

    expect(store.settingsTheme()).toBe("midnight");
  });

  test("settingsTheme reads user home when project absent", () => {
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ theme: "fallback" }), "utf8");
    const store = new ProfileStore(dir, home);

    expect(store.settingsTheme()).toBe("fallback");
  });

  test("styleActive reads the styles.active string", () => {
    writeFileSync(join(dir, ".pi", "suite.json"), JSON.stringify({ styles: { active: " neon " } }), "utf8");
    const store = new ProfileStore(dir, home);

    expect(store.styleActive()).toBe("neon");
  });

  test("writeStyle targets the user home when no project file exists", () => {
    const store = new ProfileStore(dir, home);

    expect(store.writeStyle("nightly")).toBeUndefined();
    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "suite.json"), "utf8"));
    expect(written.styles.active).toBe("nightly");
  });

  test("writeStyle returns undefined on success and an error string on invalid JSON", () => {
    writeFileSync(join(dir, ".pi", "suite.json"), JSON.stringify({}), "utf8");
    const store = new ProfileStore(dir, home);

    expect(store.writeStyle("a")).toBeUndefined();
    const written = JSON.parse(readFileSync(join(dir, ".pi", "suite.json"), "utf8"));
    expect(written.styles.active).toBe("a");

    writeFileSync(join(dir, ".pi", "suite.json"), "not json", "utf8");
    const failure = store.writeStyle("b");
    expect(typeof failure).toBe("string");
  });

  test("writeStyle output ends with a trailing newline and 2-space indent", () => {
    writeFileSync(join(dir, ".pi", "suite.json"), JSON.stringify({}), "utf8");
    const store = new ProfileStore(dir, home);
    store.writeStyle("a");
    const raw = readFileSync(join(dir, ".pi", "suite.json"), "utf8");

    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "styles"');
  });
});
