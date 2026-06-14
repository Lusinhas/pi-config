import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { FrontmatterParser } from "./frontmatter.ts";
import type { CatalogIssue, ResourceCatalogResult, ResourceRecord } from "./index.ts";

export interface NameRecord {
  name: string;
  path: string;
}

export interface ResourceValidationResult {
  skills: NameRecord[];
  prompts: NameRecord[];
  themes: NameRecord[];
  agents: NameRecord[];
}

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

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

export class DuplicateNameValidator {
  find(records: NameRecord[], category: string, errors: string[]): void {
    const byName = new Map<string, string[]>();

    for (const record of records) {
      const list = byName.get(record.name) ?? [];
      list.push(record.path);
      byName.set(record.name, list);
    }

    for (const [name, paths] of byName) {
      if (paths.length > 1) {
        errors.push(`duplicate ${category} name "${name}": ${paths.join(", ")}`);
      }
    }
  }
}

export class ResourceIssueFormatter {
  format(issue: CatalogIssue): string {
    return `${issue.path}: ${issue.message}`;
  }
}

export class ResourceContentValidator {
  private readonly parser = new FrontmatterParser();
  private readonly valueShape = new ValueShape();
  private readonly errorText = new ErrorText();
  private readonly root: string;
  private readonly errors: string[];
  private readonly warnings: string[];

  constructor(root: string, errors: string[], warnings: string[]) {
    this.root = root;
    this.errors = errors;
    this.warnings = warnings;
  }

  validate(catalog: ResourceCatalogResult): ResourceValidationResult {
    return {
      skills: this.validateSkills(catalog.skills),
      prompts: this.validatePrompts(catalog.prompts),
      themes: this.validateThemes(catalog.themes),
      agents: this.validateAgents(catalog.agents),
    };
  }

  private rel(path: string): string {
    return relative(this.root, path) || ".";
  }

  private readText(file: string): string | undefined {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      this.errors.push(`${this.rel(file)}: unreadable (${this.errorText.describe(error)})`);
      return undefined;
    }
  }

  private validateSkills(records: ResourceRecord[]): NameRecord[] {
    const names: NameRecord[] = [];

    for (const record of records) {
      const file = record.contentPath;
      const text = this.readText(file);

      if (text === undefined) {
        continue;
      }

      const frontmatter = this.parser.parse(text);

      if (!frontmatter.ok) {
        this.errors.push(`${this.rel(file)}: ${frontmatter.error}`);
        continue;
      }

      if (!frontmatter.hasFrontmatter) {
        this.errors.push(`${this.rel(file)}: missing frontmatter`);
      } else {
        if (!(frontmatter.data.name ?? "").trim()) {
          this.errors.push(`${this.rel(file)}: frontmatter missing name`);
        }

        if (!(frontmatter.data.description ?? "").trim()) {
          this.errors.push(`${this.rel(file)}: frontmatter missing description`);
        }
      }

      const name = (frontmatter.data.name ?? "").trim();
      const fallback = basename(dirname(file));
      names.push({ name: name.length > 0 ? name : fallback, path: this.rel(file) });
    }

    return names;
  }

  private validatePrompts(records: ResourceRecord[]): NameRecord[] {
    const names: NameRecord[] = [];

    for (const record of records) {
      const file = record.contentPath;
      const text = this.readText(file);

      if (text === undefined) {
        continue;
      }

      const frontmatter = this.parser.parse(text);

      if (!frontmatter.ok) {
        this.errors.push(`${this.rel(file)}: ${frontmatter.error}`);
      }

      names.push({ name: basename(file, ".md"), path: this.rel(file) });
    }

    return names;
  }

  private validateThemes(records: ResourceRecord[]): NameRecord[] {
    const names: NameRecord[] = [];

    for (const record of records) {
      const file = record.contentPath;
      const text = this.readText(file);

      if (text === undefined) {
        continue;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(text);
      } catch (error) {
        this.errors.push(`${this.rel(file)}: invalid JSON (${this.errorText.describe(error)})`);
        continue;
      }

      if (!this.valueShape.isRecord(parsed)) {
        this.errors.push(`${this.rel(file)}: theme must be a JSON object`);
        continue;
      }

      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";

      if (name.length === 0) {
        this.errors.push(`${this.rel(file)}: theme missing name`);
      }

      const colors = parsed.colors;

      if (!this.valueShape.isRecord(colors)) {
        this.errors.push(`${this.rel(file)}: theme missing colors object`);
      } else {
        const keys = Object.keys(colors);

        if (keys.length !== 51) {
          this.errors.push(`${this.rel(file)}: colors has ${keys.length} keys, expected exactly 51`);
        }

        const nonString = keys.filter((key) => typeof colors[key] !== "string");

        if (nonString.length > 0) {
          this.warnings.push(`${this.rel(file)}: non-string color values: ${nonString.join(", ")}`);
        }
      }

      names.push({ name: name.length > 0 ? name : basename(file, ".json"), path: this.rel(file) });
    }

    return names;
  }

  private validateAgents(records: ResourceRecord[]): NameRecord[] {
    const names: NameRecord[] = [];

    for (const record of records) {
      const file = record.contentPath;
      const text = this.readText(file);

      if (text === undefined) {
        continue;
      }

      const frontmatter = this.parser.parse(text);

      if (!frontmatter.ok) {
        this.errors.push(`${this.rel(file)}: ${frontmatter.error}`);
        continue;
      }

      if (!frontmatter.hasFrontmatter) {
        this.errors.push(`${this.rel(file)}: missing frontmatter`);
        names.push({ name: basename(file, ".md"), path: this.rel(file) });
        continue;
      }

      const name = (frontmatter.data.name ?? "").trim();

      if (name.length === 0) {
        this.errors.push(`${this.rel(file)}: frontmatter missing name`);
      } else if (/\s/.test(name)) {
        this.errors.push(`${this.rel(file)}: agent name "${name}" must be a single word`);
      }

      if (!(frontmatter.data.description ?? "").trim()) {
        this.errors.push(`${this.rel(file)}: frontmatter missing description`);
      }

      if (!(frontmatter.data.model ?? "").trim()) {
        this.errors.push(`${this.rel(file)}: frontmatter missing model`);
      }

      if (!(frontmatter.data.tools ?? "").trim()) {
        this.errors.push(`${this.rel(file)}: frontmatter missing tools`);
      }

      const thinking = (frontmatter.data.thinking ?? "").trim();

      if (thinking.length === 0) {
        this.errors.push(`${this.rel(file)}: frontmatter missing thinking`);
      } else if (!thinkingLevels.has(thinking)) {
        this.errors.push(`${this.rel(file)}: invalid thinking level "${thinking}" (expected off|minimal|low|medium|high|xhigh)`);
      }

      if (frontmatter.body.trim().length === 0) {
        this.warnings.push(`${this.rel(file)}: empty system prompt body`);
      }

      names.push({ name: name.length > 0 ? name : basename(file, ".md"), path: this.rel(file) });
    }

    return names;
  }
}

export class SuiteConfigValidator {
  private readonly valueShape = new ValueShape();
  private readonly errorText = new ErrorText();

  validate(cwd: string, errors: string[]): string[] {
    const suiteConfigLines: string[] = [];
    const candidates = [
      { label: "~/.pi/agent/suite.json", path: join(homedir(), ".pi", "agent", "suite.json") },
      { label: ".pi/suite.json", path: join(cwd, ".pi", "suite.json") },
    ];

    for (const candidate of candidates) {
      let text: string;

      try {
        text = readFileSync(candidate.path, "utf8");
      } catch {
        suiteConfigLines.push(`  ${candidate.label}: not present`);
        continue;
      }

      try {
        const parsed: unknown = JSON.parse(text);

        if (this.valueShape.isRecord(parsed)) {
          suiteConfigLines.push(`  ${candidate.label}: ok (${Object.keys(parsed).length} sections)`);
        } else {
          suiteConfigLines.push(`  ${candidate.label}: INVALID`);
          errors.push(`${candidate.label}: top level must be a JSON object`);
        }
      } catch (error) {
        suiteConfigLines.push(`  ${candidate.label}: INVALID`);
        errors.push(`${candidate.label}: invalid JSON (${this.errorText.describe(error)})`);
      }
    }

    return suiteConfigLines;
  }
}
