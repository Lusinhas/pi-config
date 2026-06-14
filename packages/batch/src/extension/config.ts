import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BATCHABLE_TOOL_NAMES } from "../dispatch/dispatch.ts";

export interface BatchConfig {
  maxCalls: number;
  tools: string[];
}

export class Loader {
  static readonly FALLBACK: BatchConfig = {
    maxCalls: 32,
    tools: [...BATCHABLE_TOOL_NAMES],
  };

  static load(shippedUrl: URL, cwd: string): BatchConfig {
    const layers = [
      Loader.section(Loader.readJson(shippedUrl), "batch"),
      Loader.section(Loader.readJson(join(homedir(), ".pi", "agent", "suite.json")), "batch"),
      Loader.section(Loader.readJson(join(cwd, ".pi", "suite.json")), "batch"),
    ];

    return Loader.resolve(layers);
  }

  static resolve(layers: (Record<string, unknown> | null)[]): BatchConfig {
    let config: BatchConfig = { ...Loader.FALLBACK };

    for (const layer of layers) {
      if (layer === null) {
        continue;
      }

      config = {
        maxCalls: Loader.maxCalls(layer.maxCalls, config.maxCalls),
        tools: Loader.tools(layer.tools, config.tools),
      };
    }

    return config;
  }

  private static maxCalls(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }

    return fallback;
  }

  private static tools(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
      return fallback;
    }

    const filtered = value.filter((name): name is string => typeof name === "string" && BATCHABLE_TOOL_NAMES.has(name));

    return filtered.length > 0 ? [...new Set(filtered)] : fallback;
  }

  private static readJson(source: string | URL): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(source, "utf8"));

      return Loader.isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private static section(layer: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
    if (layer === null) {
      return null;
    }

    const value = layer[key];

    return Loader.isRecord(value) ? value : null;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
