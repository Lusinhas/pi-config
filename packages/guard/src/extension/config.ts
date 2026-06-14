import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, type CheckpointConfig } from "../checkpoint/config.ts";
import { Loader, type PermissionsConfig } from "../permissions/loader.ts";
import { isRecord } from "../permissions/text.ts";

export interface GuardConfig {
  permissions: PermissionsConfig;
  checkpoint: CheckpointConfig;
}

export class Loaders {
  static readRaw(path: string | URL): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  static section(raw: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
    if (raw === null) {
      return null;
    }

    const value = raw[key];

    return isRecord(value) ? value : null;
  }

  static load(): GuardConfig {
    const shipped = Loaders.readRaw(new URL("../../config.json", import.meta.url));
    const global = Loaders.readRaw(join(homedir(), ".pi", "agent", "suite.json"));
    const project = Loaders.readRaw(join(process.cwd(), ".pi", "suite.json"));

    return {
      permissions: Loader.fromRaw(Loaders.section(shipped, "permissions"), global, project),
      checkpoint: new Config([
        Loaders.section(shipped, "checkpoint"),
        Loaders.section(global, "checkpoint"),
        Loaders.section(project, "checkpoint"),
      ]).value,
    };
  }
}
