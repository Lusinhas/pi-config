import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config as ShellConfigLoader, type ShellConfig } from "../shell/config.ts";
import { Config as WebConfigLoader, type WebConfig } from "../web/index.ts";
import { Config as WorktreesConfigLoader, type WorktreeConfig } from "../worktrees/render.ts";
import { Config as HooksConfigLoader, type HooksConfig } from "../hooks/index.ts";
import { Config as ArtifactsConfigLoader } from "../artifacts/render.ts";
import type { ArtifactsConfig } from "../artifacts/render.ts";
import type { Framing } from "../mcp/cache.ts";

export interface McpConfig {
  servers: Record<string, unknown>;
  lazy: boolean;
  outputLimit: number;
  inlineLimit: number;
  requestTimeoutMs: number;
  startTimeoutMs: number;
  idleMs: number;
  authTimeoutMs: number;
  stderrLines: number;
  framing: Framing;
}

export interface IdeConfig {
  connectionPollMs: number;
  selectedPreviewMaxChars: number;
}

export interface BridgesConfig {
  shell: ShellConfig;
  web: WebConfig;
  mcp: McpConfig;
  ide: IdeConfig;
  worktrees: WorktreeConfig;
  hooks: HooksConfig;
  artifacts: ArtifactsConfig;
}

const MCP_DEFAULTS: McpConfig = {
  servers: {},
  lazy: true,
  outputLimit: 25600,
  inlineLimit: 8192,
  requestTimeoutMs: 60000,
  startTimeoutMs: 20000,
  idleMs: 300000,
  authTimeoutMs: 300000,
  stderrLines: 20,
  framing: "ndjson",
};

const IDE_DEFAULTS: IdeConfig = {
  connectionPollMs: 7000,
  selectedPreviewMaxChars: 200,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }

  return out;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export class ConfigLoader {
  private readonly shipped: Record<string, unknown>;
  private readonly globalSuite: Record<string, unknown> | null;
  private readonly projectSuite: Record<string, unknown> | null;

  constructor(cwd: string) {
    this.shipped = ConfigLoader.readJson(new URL("../../config.json", import.meta.url));
    this.globalSuite = ConfigLoader.readSuite(join(homedir(), ".pi", "agent", "suite.json"));
    this.projectSuite = ConfigLoader.readSuite(join(cwd, ".pi", "suite.json"));
  }

  load(): BridgesConfig {
    return {
      shell: this.loadShell(),
      web: this.loadWeb(),
      mcp: this.loadMcp(),
      ide: this.loadIde(),
      worktrees: this.loadWorktrees(),
      hooks: this.loadHooks(),
      artifacts: this.loadArtifacts(),
    };
  }

  private loadShell(): ShellConfig {
    const overrides = [this.section("shell", this.globalSuite), this.section("shell", this.projectSuite)].filter(
      (layer): layer is Record<string, unknown> => layer !== null,
    );

    return new ShellConfigLoader(this.section("shell", this.shipped) ?? {}, overrides).value;
  }

  private loadWeb(): WebConfig {
    return new WebConfigLoader().resolve(this.section("web", this.shipped), this.globalSuite, this.projectSuite);
  }

  private loadMcp(): McpConfig {
    let merged: Record<string, unknown> = { ...MCP_DEFAULTS };
    const shipped = this.section("mcp", this.shipped);

    if (shipped !== null) {
      merged = deepMerge(merged, shipped);
    }

    for (const layer of [this.section("mcp", this.globalSuite), this.section("mcp", this.projectSuite)]) {
      if (layer !== null) {
        merged = deepMerge(merged, layer);
      }
    }

    return {
      servers: isRecord(merged.servers) ? merged.servers : {},
      lazy: merged.lazy !== false,
      outputLimit: positiveInt(merged.outputLimit, MCP_DEFAULTS.outputLimit),
      inlineLimit: positiveInt(merged.inlineLimit, MCP_DEFAULTS.inlineLimit),
      requestTimeoutMs: positiveInt(merged.requestTimeoutMs, MCP_DEFAULTS.requestTimeoutMs),
      startTimeoutMs: positiveInt(merged.startTimeoutMs, MCP_DEFAULTS.startTimeoutMs),
      idleMs: nonNegativeInt(merged.idleMs, MCP_DEFAULTS.idleMs),
      authTimeoutMs: positiveInt(merged.authTimeoutMs, MCP_DEFAULTS.authTimeoutMs),
      stderrLines: positiveInt(merged.stderrLines, MCP_DEFAULTS.stderrLines),
      framing: merged.framing === "lsp" ? "lsp" : "ndjson",
    };
  }

  private loadIde(): IdeConfig {
    let merged: Record<string, unknown> = { ...IDE_DEFAULTS };
    const shipped = this.section("ide", this.shipped);

    if (shipped !== null) {
      merged = deepMerge(merged, shipped);
    }

    for (const layer of [this.section("ide", this.globalSuite), this.section("ide", this.projectSuite)]) {
      if (layer !== null) {
        merged = deepMerge(merged, layer);
      }
    }

    return {
      connectionPollMs: positiveInt(merged.connectionPollMs, IDE_DEFAULTS.connectionPollMs),
      selectedPreviewMaxChars: positiveInt(merged.selectedPreviewMaxChars, IDE_DEFAULTS.selectedPreviewMaxChars),
    };
  }

  private loadWorktrees(): WorktreeConfig {
    return new WorktreesConfigLoader([
      this.section("worktrees", this.shipped),
      this.section("worktrees", this.globalSuite),
      this.section("worktrees", this.projectSuite),
    ]).value;
  }

  private loadHooks(): HooksConfig {
    const overrides = [this.section("hooks", this.globalSuite), this.section("hooks", this.projectSuite)].filter(
      (layer): layer is Record<string, unknown> => layer !== null,
    );

    return new HooksConfigLoader().resolve(this.section("hooks", this.shipped) ?? {}, overrides);
  }

  private loadArtifacts(): ArtifactsConfig {
    return ArtifactsConfigLoader.fromLayers([
      this.section("artifacts", this.shipped),
      this.section("artifacts", this.globalSuite),
      this.section("artifacts", this.projectSuite),
    ]);
  }

  private section(sub: string, file: Record<string, unknown> | null): Record<string, unknown> | null {
    if (file !== null && isRecord(file[sub])) {
      return file[sub];
    }

    return null;
  }

  private static readJson(url: URL): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));

      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private static readSuite(path: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
