import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config as HashlineConfigLoader } from "../lines/config.ts";
import type { HashlineConfig } from "../lines/config.ts";
import { Config as AstConfigLoader } from "../syntax/settings.ts";
import type { AstConfig } from "../syntax/settings.ts";
import { Config as CommentsConfigLoader } from "../comments/config.ts";
import type { CommentsConfig } from "../comments/config.ts";

export interface EditingConfig {
  hashline: HashlineConfig;
  astgrep: AstConfig;
  comments: CommentsConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  load(): EditingConfig {
    return {
      hashline: this.loadHashline(),
      astgrep: this.loadAstgrep(),
      comments: this.loadComments(),
    };
  }

  private loadHashline(): HashlineConfig {
    return HashlineConfigLoader.load(
      this.section("hashline", this.shipped),
      this.section("hashline", this.globalSuite),
      this.section("hashline", this.projectSuite),
    );
  }

  private loadAstgrep(): AstConfig {
    const layers = [
      this.section("astgrep", this.shipped),
      this.section("astgrep", this.globalSuite),
      this.section("astgrep", this.projectSuite),
    ].filter((layer): layer is Record<string, unknown> => layer !== null);

    return new AstConfigLoader(layers).resolve();
  }

  private loadComments(): CommentsConfig {
    const shipped = this.section("comments", this.shipped) ?? {};
    const overrides = [this.section("comments", this.globalSuite), this.section("comments", this.projectSuite)].filter(
      (layer): layer is Record<string, unknown> => layer !== null,
    );

    return new CommentsConfigLoader(shipped).resolve(overrides);
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
