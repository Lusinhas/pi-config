import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ResourceKind = "prompt" | "skill" | "theme" | "agent";

export interface ResourceRecord {
  kind: ResourceKind;
  path: string;
  contentPath: string;
  relativePath: string;
}

export interface CatalogIssue {
  path: string;
  message: string;
}

export interface ResourceCatalogResult {
  root: string;
  prompts: ResourceRecord[];
  skills: ResourceRecord[];
  themes: ResourceRecord[];
  agents: ResourceRecord[];
  errors: CatalogIssue[];
  warnings: CatalogIssue[];
}

interface CatalogDirConfig {
  dir: string;
  kind: ResourceKind;
  extension: string;
  fileName?: string;
}

const MAX_DEPTH = 8;

class ErrorText {
  describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

class CatalogIssues {
  readonly errors: CatalogIssue[] = [];
  readonly warnings: CatalogIssue[] = [];

  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  warning(path: string, message: string): void {
    this.warnings.push({ path, message });
  }
}

class CatalogFileSystem {
  private readonly errorText = new ErrorText();

  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  entries(path: string, issues: CatalogIssues, label: string): Dirent[] {
    try {
      return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      issues.error(label, `unreadable directory (${this.errorText.describe(error)})`);
      return [];
    }
  }
}

class CatalogWalker {
  private readonly files: CatalogFileSystem;
  private readonly issues: CatalogIssues;
  private readonly root: string;

  constructor(files: CatalogFileSystem, issues: CatalogIssues, root: string) {
    this.files = files;
    this.issues = issues;
    this.root = root;
  }

  collect(config: CatalogDirConfig): ResourceRecord[] {
    const base = join(this.root, config.dir);

    if (!this.files.isDirectory(base)) {
      this.issues.warning(config.dir, `${config.dir} directory is missing`);
      return [];
    }

    const found: ResourceRecord[] = [];
    const seen = new Set<string>();

    this.walk(base, config, 0, found, seen);

    return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private walk(dir: string, config: CatalogDirConfig, depth: number, found: ResourceRecord[], seen: Set<string>): void {
    if (depth > MAX_DEPTH) {
      this.issues.warning(this.rel(dir), `directory nesting exceeds ${MAX_DEPTH} levels; skipped`);
      return;
    }

    for (const entry of this.files.entries(dir, this.issues, this.rel(dir))) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        this.walk(full, config, depth + 1, found, seen);
        continue;
      }

      if (!entry.isFile() || !this.matches(entry.name, config)) {
        continue;
      }

      if (seen.has(full)) {
        continue;
      }

      seen.add(full);
      found.push({
        kind: config.kind,
        path: full,
        contentPath: full,
        relativePath: this.rel(full),
      });
    }
  }

  private matches(name: string, config: CatalogDirConfig): boolean {
    if (config.fileName !== undefined) {
      return name === config.fileName;
    }

    return name.endsWith(config.extension);
  }

  private rel(path: string): string {
    return relative(this.root, path) || ".";
  }
}

export class ResourceCatalog {
  private readonly files = new CatalogFileSystem();
  private readonly configs: CatalogDirConfig[] = [
    { dir: "prompts", kind: "prompt", extension: ".md" },
    { dir: "skills", kind: "skill", extension: ".md", fileName: "skill.md" },
    { dir: "themes", kind: "theme", extension: ".json" },
    { dir: "agents", kind: "agent", extension: ".md" },
  ];

  load(rootPath?: string): ResourceCatalogResult {
    const root = rootPath ?? this.defaultRoot();
    const issues = new CatalogIssues();

    if (!this.files.isDirectory(root)) {
      issues.error(root, "resource root directory is missing");

      return this.empty(root, issues);
    }

    const walker = new CatalogWalker(this.files, issues, root);

    return {
      root,
      prompts: walker.collect(this.configs[0]),
      skills: walker.collect(this.configs[1]),
      themes: walker.collect(this.configs[2]),
      agents: walker.collect(this.configs[3]),
      errors: issues.errors,
      warnings: issues.warnings,
    };
  }

  private empty(root: string, issues: CatalogIssues): ResourceCatalogResult {
    return {
      root,
      prompts: [],
      skills: [],
      themes: [],
      agents: [],
      errors: issues.errors,
      warnings: issues.warnings,
    };
  }

  private defaultRoot(): string {
    return resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
  }
}
