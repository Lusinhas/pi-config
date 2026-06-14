import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config as TodosConfigNormalizer, type TodosConfig } from "../todos/config.ts";
import { Config as PlanConfigNormalizer, type PlanConfig } from "../plan/settings.ts";
import { Config as KeywordsConfigNormalizer } from "../keywords/config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(source: string | URL): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(source, "utf8"));

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function section(layer: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (layer === null) {
    return null;
  }

  const value = layer[key];

  return isRecord(value) ? value : null;
}

export class Loader {
  private readonly shipped: Record<string, unknown>;
  private readonly global: Record<string, unknown> | null;
  private readonly project: Record<string, unknown> | null;

  constructor(shippedUrl: URL, cwd: string) {
    this.shipped = readJson(shippedUrl) ?? {};
    this.global = readJson(join(homedir(), ".pi", "agent", "suite.json"));
    this.project = readJson(join(cwd, ".pi", "suite.json"));
  }

  private overrides(key: string): Record<string, unknown>[] {
    const layers: Record<string, unknown>[] = [];
    const global = section(this.global, key);
    const project = section(this.project, key);

    if (global !== null) {
      layers.push(global);
    }

    if (project !== null) {
      layers.push(project);
    }

    return layers;
  }

  todos(): TodosConfig {
    const shipped = section(this.shipped, "todos") ?? {};

    return new TodosConfigNormalizer(shipped).resolve(this.overrides("todos"));
  }

  plan(): PlanConfig {
    return PlanConfigNormalizer.fromRaw(
      section(this.shipped, "plan"),
      this.global,
      this.project,
    );
  }

  keywords(): KeywordsConfigNormalizer {
    const layers: unknown[] = [section(this.shipped, "keywords") ?? {}, ...this.overrides("keywords")];

    return new KeywordsConfigNormalizer(layers);
  }
}
