import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config as CompactionConfigBuilder } from "../compaction/index.ts";
import type { CompactionConfig } from "../compaction/index.ts";
import { Config as MemoryConfigBuilder } from "../memory/index.ts";
import type { MemoryConfig } from "../memory/index.ts";
import { Config as SessionsConfigBuilder } from "../sessions/text.ts";
import type { SessionsConfig } from "../sessions/text.ts";
import { RulesConfig } from "../rules/settings.ts";
import type { RulesSettings } from "../rules/settings.ts";

type Section = "memory" | "compaction" | "sessions" | "rules";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ConfigLoader {
  private readonly shipped: Record<string, unknown>;
  private readonly global: Record<string, unknown>;
  private readonly project: Record<string, unknown>;

  constructor() {
    this.shipped = ConfigLoader.readRecord(new URL("../../config.json", import.meta.url));
    this.global = ConfigLoader.readRecord(join(homedir(), ".pi", "agent", "suite.json"));
    this.project = ConfigLoader.readRecord(join(process.cwd(), ".pi", "suite.json"));
  }

  private static readRecord(source: string | URL): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(source, "utf8"));

      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private layers(section: Section): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];

    for (const source of [this.shipped, this.global, this.project]) {
      const part = source[section];

      if (isRecord(part)) {
        out.push(part);
      }
    }

    return out;
  }

  memory(): MemoryConfig {
    return new MemoryConfigBuilder(this.layers("memory")).values;
  }

  compaction(): CompactionConfig {
    const layers = this.layers("compaction");
    const shipped = layers[0] ?? {};

    return new CompactionConfigBuilder(shipped).resolve(layers.slice(1));
  }

  sessions(): SessionsConfig {
    const shipped = isRecord(this.shipped.sessions) ? this.shipped.sessions : null;

    return SessionsConfigBuilder.fromRaw(shipped, this.global, this.project);
  }

  rules(): RulesSettings {
    const layers = this.layers("rules");
    const shipped = layers[0] ?? {};

    return new RulesConfig(shipped).resolve(layers.slice(1));
  }
}
