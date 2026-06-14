import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { asThinking, errorText, isRecord, Models, type AgentModel, type ThinkingLevel } from "./models.ts";
import type { ProfileSpec } from "./index.ts";

export interface Snapshot {
  model: AgentModel | null;
  thinking: ThinkingLevel | undefined;
  tools: string[];
  theme: string | undefined;
  style: string | undefined;
  modelChanged: boolean;
  thinkingChanged: boolean;
  toolsChanged: boolean;
  themeChanged: boolean;
  styleChanged: boolean;
}

export interface ProfilePorts {
  registry: unknown;
  currentModel: AgentModel | null | undefined;
  hasUI: boolean;
  cwd: string;
  home: string;
  setModel: (model: AgentModel) => Promise<boolean>;
  setThinkingLevel: (level: ThinkingLevel) => void;
  getThinkingLevel: () => unknown;
  getActiveTools: () => unknown;
  setActiveTools: (tools: string[]) => Promise<void>;
  getAllTools: () => unknown;
  setTheme: (theme: string) => unknown;
  notify: (text: string, kind: "info" | "warning" | "error") => void;
}

export class ProfileStore {
  #cwd: string;
  #home: string;

  constructor(cwd: string, home: string = homedir()) {
    this.#cwd = cwd;
    this.#home = home;
  }

  static readJson(path: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  settingsTheme(): string | undefined {
    const files = [
      join(this.#cwd, ".pi", "settings.json"),
      join(this.#home, ".pi", "agent", "settings.json")
    ];

    for (const file of files) {
      const parsed = ProfileStore.readJson(file);

      if (parsed && typeof parsed.theme === "string" && parsed.theme.trim() !== "") {
        return parsed.theme.trim();
      }
    }

    return undefined;
  }

  styleActive(): string | undefined {
    const files = [
      join(this.#cwd, ".pi", "suite.json"),
      join(this.#home, ".pi", "agent", "suite.json")
    ];

    for (const file of files) {
      const parsed = ProfileStore.readJson(file);

      if (!parsed || !isRecord(parsed.styles)) {
        continue;
      }

      const value = parsed.styles.active;

      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
    }

    return undefined;
  }

  writeStyle(style: string | undefined): string | undefined {
    const project = join(this.#cwd, ".pi", "suite.json");
    const target = existsSync(project) ? project : join(this.#home, ".pi", "agent", "suite.json");
    let parsed: Record<string, unknown> = {};

    if (existsSync(target)) {
      const loaded = ProfileStore.readJson(target);

      if (!loaded) {
        return `${target} is not a JSON object`;
      }

      parsed = loaded;
    }

    const styles = isRecord(parsed.styles) ? { ...parsed.styles } : {};

    if (style === undefined) {
      delete styles.active;
    } else {
      styles.active = style;
    }

    parsed.styles = styles;

    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

      return undefined;
    } catch (error) {
      return errorText(error);
    }
  }
}

export class ProfileManager {
  #profiles: Record<string, ProfileSpec>;
  #snapshot: Snapshot | null;
  #activeProfile: string | undefined;

  constructor(profiles: Record<string, ProfileSpec>) {
    this.#profiles = profiles;
    this.#snapshot = null;
    this.#activeProfile = undefined;
  }

  get activeProfile(): string | undefined {
    return this.#activeProfile;
  }

  reset(): void {
    this.#snapshot = null;
    this.#activeProfile = undefined;
  }

  #store(ports: ProfilePorts): ProfileStore {
    return new ProfileStore(ports.cwd, ports.home);
  }

  #knownTools(ports: ProfilePorts): string[] {
    let tools: unknown;

    try {
      tools = ports.getAllTools();
    } catch {
      return [];
    }

    if (!Array.isArray(tools)) {
      return [];
    }

    const names: string[] = [];

    for (const tool of tools) {
      if (typeof tool === "string" && tool.trim() !== "") {
        names.push(tool.trim());
      } else if (isRecord(tool) && typeof tool.name === "string" && tool.name.trim() !== "") {
        names.push(tool.name.trim());
      }
    }

    return names;
  }

  #applyTheme(ports: ProfilePorts, theme: string): string | undefined {
    try {
      const outcome: unknown = ports.setTheme(theme);

      if (!isRecord(outcome)) {
        return undefined;
      }

      if (outcome.success === true) {
        return undefined;
      }

      return typeof outcome.error === "string" && outcome.error.trim() !== "" ? outcome.error : "the theme was rejected";
    } catch (error) {
      return errorText(error);
    }
  }

  #capture(ports: ProfilePorts): Snapshot {
    if (this.#snapshot) {
      return this.#snapshot;
    }

    let thinking: ThinkingLevel | undefined;

    try {
      thinking = asThinking(ports.getThinkingLevel());
    } catch {}

    let tools: string[] = [];

    try {
      const current = ports.getActiveTools();

      if (Array.isArray(current)) {
        tools = current.filter((tool): tool is string => typeof tool === "string");
      }
    } catch {}

    const store = this.#store(ports);

    this.#snapshot = {
      model: ports.currentModel ?? null,
      thinking,
      tools,
      theme: store.settingsTheme(),
      style: store.styleActive(),
      modelChanged: false,
      thinkingChanged: false,
      toolsChanged: false,
      themeChanged: false,
      styleChanged: false
    };

    return this.#snapshot;
  }

  unknownProfile(name: string): string {
    const names = Object.keys(this.#profiles);
    const lower = name.toLowerCase();
    const close = names.filter(
      candidate => candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase())
    );
    const hint =
      close.length > 0
        ? ` Close matches: ${close.join(", ")}.`
        : names.length > 0
          ? ` Available: ${names.join(", ")}.`
          : " No profiles are configured (add them under router.profiles in suite.json).";

    return `router: unknown profile "${name}".${hint}`;
  }

  async apply(name: string, ports: ProfilePorts): Promise<void> {
    const spec = this.#profiles[name];

    if (!spec) {
      ports.notify(this.unknownProfile(name), "error");

      return;
    }

    const state = this.#capture(ports);
    const applied: string[] = [];
    const problems: string[] = [];

    if (spec.model) {
      const resolution = Models.resolveIn(await Models.list(ports.registry), spec.model);

      if (!resolution.model) {
        const hint =
          resolution.suggestions.length > 0 ? ` (close matches: ${resolution.suggestions.join(", ")})` : "";
        problems.push(`model "${spec.model}" not found in the registry${hint}`);
      } else {
        let ok = false;
        let failure = "";

        try {
          ok = await ports.setModel(resolution.model);
        } catch (error) {
          ok = false;
          failure = errorText(error);
        }

        if (ok) {
          state.modelChanged = true;
          applied.push(`model ${Models.describe(resolution.model)}`);
        } else {
          const detail = failure !== "" ? `: ${failure}` : "";
          problems.push(`model ${Models.describe(resolution.model)} was rejected${detail}`);
        }
      }
    }

    if (spec.thinking) {
      try {
        ports.setThinkingLevel(spec.thinking);
        state.thinkingChanged = true;
        applied.push(`thinking ${spec.thinking}`);
      } catch (error) {
        problems.push(`thinking level ${spec.thinking} could not be set: ${errorText(error)}`);
      }
    }

    if (spec.theme && ports.hasUI) {
      const failure = this.#applyTheme(ports, spec.theme);

      if (failure === undefined) {
        state.themeChanged = true;
        applied.push(`theme ${spec.theme}`);
      } else {
        problems.push(`theme "${spec.theme}" could not be applied: ${failure}`);
      }
    }

    if (spec.tools) {
      const all = this.#knownTools(ports);
      const valid = spec.tools.filter(tool => all.includes(tool));
      const missing = spec.tools.filter(tool => !all.includes(tool));

      if (valid.length > 0) {
        try {
          await ports.setActiveTools(valid);
          state.toolsChanged = true;
          applied.push(`tools [${valid.join(", ")}]`);

          if (missing.length > 0) {
            problems.push(`unknown tools skipped: ${missing.join(", ")}`);
          }
        } catch (error) {
          problems.push(`active tool set could not be changed: ${errorText(error)}`);
        }
      } else {
        problems.push(`none of the listed tools exist: ${spec.tools.join(", ")}`);
      }
    }

    if (spec.style) {
      const failure = this.#store(ports).writeStyle(spec.style);

      if (failure === undefined) {
        state.styleChanged = true;
        applied.push(`style ${spec.style}`);
      } else {
        problems.push(`style "${spec.style}" could not be written to suite.json: ${failure}`);
      }
    }

    this.#activeProfile = name;
    const summary =
      applied.length > 0
        ? `router: profile "${name}" applied — ${applied.join(", ")}`
        : `router: profile "${name}" had nothing to apply`;
    ports.notify(
      problems.length > 0 ? `${summary}. Issues: ${problems.join("; ")}` : summary,
      problems.length > 0 ? "warning" : "info"
    );
  }

  async revert(ports: ProfilePorts): Promise<void> {
    if (!this.#activeProfile || !this.#snapshot) {
      ports.notify("router: no profile is active", "info");

      return;
    }

    const state = this.#snapshot;
    const name = this.#activeProfile;
    const restored: string[] = [];
    const problems: string[] = [];

    if (state.modelChanged) {
      if (state.model) {
        const models = await Models.list(ports.registry);
        const live = models.find(model => Models.same(model, state.model as AgentModel)) ?? state.model;
        let ok = false;
        let failure = "";

        try {
          ok = await ports.setModel(live);
        } catch (error) {
          ok = false;
          failure = errorText(error);
        }

        if (ok) {
          restored.push(`model ${Models.describe(live)}`);
        } else {
          const detail = failure !== "" ? `: ${failure}` : "";
          problems.push(`model ${Models.describe(live)} could not be restored${detail}`);
        }
      } else {
        problems.push("the session had no model to restore");
      }

      state.modelChanged = false;
    }

    if (state.thinkingChanged) {
      if (state.thinking) {
        try {
          ports.setThinkingLevel(state.thinking);
          restored.push(`thinking ${state.thinking}`);
        } catch (error) {
          problems.push(`thinking ${state.thinking} could not be restored: ${errorText(error)}`);
        }
      }

      state.thinkingChanged = false;
    }

    if (state.toolsChanged) {
      const all = this.#knownTools(ports);
      const valid = state.tools.filter(tool => all.includes(tool));

      try {
        await ports.setActiveTools(valid);
        restored.push(`tools (${valid.length})`);
      } catch (error) {
        problems.push(`active tool set could not be restored: ${errorText(error)}`);
      }

      state.toolsChanged = false;
    }

    if (state.themeChanged) {
      if (ports.hasUI && state.theme) {
        const failure = this.#applyTheme(ports, state.theme);

        if (failure === undefined) {
          restored.push(`theme ${state.theme}`);
        } else {
          problems.push(`theme ${state.theme} could not be restored: ${failure}`);
        }
      } else if (ports.hasUI) {
        problems.push("the previous theme is unknown (none recorded in settings.json), so the theme was left as-is");
      }

      state.themeChanged = false;
    }

    if (state.styleChanged) {
      const failure = this.#store(ports).writeStyle(state.style);

      if (failure === undefined) {
        restored.push(state.style ? `style ${state.style}` : "style cleared");
      } else {
        problems.push(`the previous style could not be restored in suite.json: ${failure}`);
      }

      state.styleChanged = false;
    }

    this.#activeProfile = undefined;
    const summary = `router: profile "${name}" off — restored ${restored.length > 0 ? restored.join(", ") : "nothing"}`;
    ports.notify(
      problems.length > 0 ? `${summary}. Issues: ${problems.join("; ")}` : summary,
      problems.length > 0 ? "warning" : "info"
    );
  }

  render(): string {
    const names = Object.keys(this.#profiles);

    if (names.length === 0) {
      return "router: no profiles configured (add them under router.profiles in suite.json)";
    }

    const width = names.reduce((max, name) => Math.max(max, name.length), 0);
    const lines = names.map(name => {
      const spec = this.#profiles[name];
      const parts: string[] = [];

      if (spec.model) {
        parts.push(`model=${spec.model}`);
      }

      if (spec.thinking) {
        parts.push(`thinking=${spec.thinking}`);
      }

      if (spec.theme) {
        parts.push(`theme=${spec.theme}`);
      }

      if (spec.tools) {
        parts.push(`tools=[${spec.tools.join(", ")}]`);
      }

      if (spec.style) {
        parts.push(`style=${spec.style}`);
      }

      const marker = name === this.#activeProfile ? "*" : " ";

      return `${marker} ${name.padEnd(width)}  ${parts.join("  ")}`;
    });

    return `Profiles (* = active, /profile <name> applies, /profile off reverts):\n${lines.join("\n")}`;
  }
}
