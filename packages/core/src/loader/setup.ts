import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ResourceRecord } from "./index.ts";

export interface SetupPlan {
  next: Record<string, unknown>;
  written: string[];
  kept: string[];
}

export interface ExistingSuite {
  value: Record<string, unknown>;
  valid: boolean;
}

class ValueShape {
  isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

class ErrorText {
  describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

class ThemeChoices {
  private readonly valueShape = new ValueShape();

  list(records: ResourceRecord[]): string[] {
    const names = new Set<string>();

    for (const record of records) {
      let added = false;

      try {
        const parsed: unknown = JSON.parse(readFileSync(record.contentPath, "utf8"));

        if (this.valueShape.isRecord(parsed) && typeof parsed.name === "string" && parsed.name.trim().length > 0) {
          names.add(parsed.name.trim());
          added = true;
        }
      } catch {
        added = false;
      }

      if (!added) {
        names.add(basename(record.contentPath, ".json"));
      }
    }

    return [...names].sort();
  }
}

export class SetupPlanner {
  private readonly valueShape = new ValueShape();
  private readonly themes = new ThemeChoices();

  themeChoices(records: ResourceRecord[]): string[] {
    return this.themes.list(records);
  }

  nextSuite(existing: Record<string, unknown>, chosenMode: string | undefined): SetupPlan {
    const next: Record<string, unknown> = { ...existing };
    const written: string[] = [];
    const kept: string[] = [];

    if (this.valueShape.isRecord(next.loader) && "theme" in next.loader) {
      const section = { ...next.loader };
      delete section.theme;

      if (Object.keys(section).length === 0) {
        delete next.loader;
      } else {
        next.loader = section;
      }

      written.push("removed stale loader.theme (the theme now persists in settings.json)");
    }

    if (chosenMode !== undefined) {
      const section = this.valueShape.isRecord(next.permissions) ? { ...next.permissions } : {};

      if (section.mode === chosenMode) {
        kept.push(`permissions.mode already "${chosenMode}"`);
      } else {
        section.mode = chosenMode;
        next.permissions = section;
        written.push(`permissions.mode = "${chosenMode}"`);
      }
    }

    return { next, written, kept };
  }
}

export class SuiteFile {
  private readonly target: string;
  private readonly valueShape = new ValueShape();
  private readonly errorText = new ErrorText();

  constructor(target: string) {
    this.target = target;
  }

  path(): string {
    return this.target;
  }

  readExisting(): ExistingSuite {
    if (!existsSync(this.target)) {
      return { value: {}, valid: true };
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(this.target, "utf8"));

      if (this.valueShape.isRecord(parsed)) {
        return { value: parsed, valid: true };
      }
    } catch {
      return { value: {}, valid: false };
    }

    return { value: {}, valid: false };
  }

  write(value: Record<string, unknown>): string | undefined {
    try {
      mkdirSync(dirname(this.target), { recursive: true });
      writeFileSync(this.target, JSON.stringify(value, null, 2) + "\n", "utf8");
      return undefined;
    } catch (error) {
      return this.errorText.describe(error);
    }
  }
}
