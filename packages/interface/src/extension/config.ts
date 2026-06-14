import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config as StatuslineConfigBuilder, type StatuslineConfig } from "../status/config.ts";
import { Config as ToolviewConfigBuilder, type ToolViewConfig } from "../view/config.ts";
import { Config as StylesConfigBuilder, type StylesConfig } from "../styles/config.ts";
import type { ConfigSource, SuiteFile, SuiteRead } from "../styles/index.ts";
import { loadConfig as loadUsageConfig, type UsageConfig } from "../usage/config.ts";
import { Config as AskConfigBuilder } from "../ask/config.ts";
import type { AskConfig } from "../ask/config.ts";

const SUBAGENT_MARKER_KEY = Symbol.for("piconfig.subagents.marker");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string | URL): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function section(raw: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (raw === null) {
    return null;
  }

  const value = raw[key];

  return isRecord(value) ? value : null;
}

export interface InterfaceConfig {
  statusline: StatuslineConfig;
  toolview: ToolViewConfig;
  styles: StylesConfig;
  usage: UsageConfig;
  ask: AskConfig;
}

export class Layers {
  readonly shipped: Record<string, unknown> | null;
  readonly global: Record<string, unknown> | null;
  readonly project: Record<string, unknown> | null;

  constructor() {
    this.shipped = readJson(new URL("../../config.json", import.meta.url));
    this.global = readJson(join(homedir(), ".pi", "agent", "suite.json"));
    this.project = readJson(join(process.cwd(), ".pi", "suite.json"));
  }

  load(): InterfaceConfig {
    return {
      statusline: StatuslineConfigBuilder.fromRaw(
        section(this.shipped, "statusline"),
        this.global,
        this.project,
      ),
      toolview: ToolviewConfigBuilder.fromLayers(section(this.shipped, "toolview"), [
        ToolviewConfigBuilder.section(this.global),
        ToolviewConfigBuilder.section(this.project),
      ]),
      styles: StylesConfigBuilder.fromLayers(
        section(this.shipped, "styles"),
        StylesConfigBuilder.section(this.global),
        StylesConfigBuilder.section(this.project),
      ),
      usage: loadUsageConfig(),
      ask: AskConfigBuilder.fromRaw(section(this.shipped, "ask"), this.global, this.project),
    };
  }
}

export class SuiteFileIo implements SuiteFile {
  readonly #dir = join(homedir(), ".pi", "agent");
  readonly #file = join(this.#dir, "suite.json");

  read(): SuiteRead {
    try {
      return { ok: true, content: readFileSync(this.#file, "utf8") };
    } catch (cause) {
      if (isRecord(cause) && cause.code === "ENOENT") {
        return { ok: true, content: null };
      }

      return { ok: false, content: null };
    }
  }

  write(content: string): boolean {
    try {
      mkdirSync(this.#dir, { recursive: true });
      writeFileSync(this.#file, content, "utf8");

      return true;
    } catch {
      return false;
    }
  }
}

export class SuiteConfigSource implements ConfigSource {
  load(): StylesConfig {
    const shipped = readJson(new URL("../../config.json", import.meta.url));

    return StylesConfigBuilder.fromLayers(
      section(shipped, "styles"),
      StylesConfigBuilder.section(readJson(join(homedir(), ".pi", "agent", "suite.json"))),
      StylesConfigBuilder.section(readJson(join(process.cwd(), ".pi", "suite.json"))),
    );
  }
}

export function subagentDepth(): number {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const state = host[SUBAGENT_MARKER_KEY];

  if (isRecord(state) && typeof state.depth === "number" && Number.isFinite(state.depth)) {
    return state.depth;
  }

  return 0;
}
