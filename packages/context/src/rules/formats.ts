import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FormatFlags } from "./settings.ts";

export type RuleSource = "pi" | "claude" | "cursor" | "copilot" | "windsurf" | "cline";

export interface ParsedRule {
  source: RuleSource;
  path: string;
  relPath: string;
  scopes: string[];
  always: boolean;
  body: string;
}

export interface RuleError {
  source: RuleSource;
  path: string;
  relPath: string;
  message: string;
}

export interface DiscoveryResult {
  rules: ParsedRule[];
  errors: RuleError[];
}

export interface RuleSemantics {
  scopes: string[];
  always: boolean;
}

export interface FrontmatterResult {
  data: Record<string, unknown>;
  body: string;
  error: string | null;
}

export type SemanticsResolver = (data: Record<string, unknown>) => RuleSemantics;

export class Frontmatter {
  extract(text: string): FrontmatterResult {
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const lines = src.split("\n");
    const first = (lines[0] ?? "").replace(/\r$/, "").trim();

    if (first !== "---") {
      return { data: {}, body: src, error: null };
    }

    let end = -1;

    for (let i = 1; i < lines.length; i += 1) {
      const trimmed = lines[i].replace(/\r$/, "").trim();

      if (trimmed === "---" || trimmed === "...") {
        end = i;
        break;
      }
    }

    if (end === -1) {
      return { data: {}, body: "", error: "unterminated frontmatter" };
    }

    const raw = lines.slice(1, end).join("\n");
    const body = lines.slice(end + 1).join("\n");

    return { data: this.parseBlock(raw), body, error: null };
  }

  parseBlock(raw: string): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    const lines = raw.split("\n").map((line) => line.replace(/\r$/, ""));
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed === "" || trimmed.startsWith("#") || /^\s/.test(line)) {
        i += 1;
        continue;
      }

      const match = /^([^\s:][^:]*):\s?(.*)$/.exec(line);

      if (match === null) {
        i += 1;
        continue;
      }

      const key = match[1].trim();
      const rest = match[2];

      if (rest.trim() !== "") {
        data[key] = this.parseScalar(rest);
        i += 1;
        continue;
      }

      const items: string[] = [];
      let j = i + 1;

      while (j < lines.length) {
        const candidate = lines[j];

        if (candidate.trim() === "") {
          j += 1;
          continue;
        }

        const itemMatch = /^\s*-\s*(.*)$/.exec(candidate);

        if (itemMatch === null) {
          break;
        }

        const item = this.unquote(itemMatch[1].trim());

        if (item !== "") {
          items.push(item);
        }

        j += 1;
      }

      if (items.length > 0) {
        data[key] = items;
        i = j;
        continue;
      }

      data[key] = "";
      i += 1;
    }

    return data;
  }

  parseScalar(raw: string): unknown {
    const trimmed = raw.trim();

    if (trimmed === "") {
      return "";
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const inner = trimmed.slice(1, -1).trim();

      if (inner === "") {
        return [];
      }

      return this.splitItems(inner)
        .map((part) => this.unquote(part.trim()))
        .filter((part) => part !== "");
    }

    const bare = this.unquote(trimmed);

    if (bare !== trimmed) {
      return bare;
    }

    if (trimmed === "true") {
      return true;
    }

    if (trimmed === "false") {
      return false;
    }

    return trimmed;
  }

  splitItems(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = "";
    let current = "";

    for (const ch of text) {
      if (quote !== "") {
        current += ch;

        if (ch === quote) {
          quote = "";
        }

        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }

      if (ch === "{" || ch === "[") {
        depth += 1;
      } else if (ch === "}" || ch === "]") {
        depth = Math.max(0, depth - 1);
      }

      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }

      current += ch;
    }

    parts.push(current);

    return parts;
  }

  unquote(value: string): string {
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];

      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return value.slice(1, -1);
      }
    }

    return value;
  }
}

export class Semantics {
  private readonly frontmatter: Frontmatter;
  private readonly resolvers: Record<RuleSource, SemanticsResolver>;

  constructor(frontmatter: Frontmatter) {
    this.frontmatter = frontmatter;
    this.resolvers = {
      pi: (data) => this.native(data),
      claude: (data) => this.native(data),
      cursor: (data) => this.cursor(data),
      copilot: (data) => this.copilot(data),
      windsurf: (data) => this.windsurf(data),
      cline: (data) => this.native(data),
    };
  }

  resolver(source: RuleSource): SemanticsResolver {
    return this.resolvers[source];
  }

  native(data: Record<string, unknown>): RuleSemantics {
    const scopes = [...new Set([...this.toGlobList(data.paths), ...this.toGlobList(data.globs)])];
    const always = this.asBool(data.alwaysApply);

    return { scopes, always: always === true || (always === undefined && scopes.length === 0) };
  }

  cursor(data: Record<string, unknown>): RuleSemantics {
    return { scopes: this.toGlobList(data.globs), always: this.asBool(data.alwaysApply) === true };
  }

  copilot(data: Record<string, unknown>): RuleSemantics {
    const scopes = this.toGlobList(data.applyTo);

    if (scopes.length === 0 || scopes.includes("**") || scopes.includes("**/*")) {
      return { scopes: [], always: true };
    }

    return { scopes, always: false };
  }

  windsurf(data: Record<string, unknown>): RuleSemantics {
    const trigger = typeof data.trigger === "string" ? data.trigger.trim().toLowerCase() : "";
    const scopes = [...new Set([...this.toGlobList(data.globs), ...this.toGlobList(data.paths)])];

    if (trigger === "always_on") {
      return { scopes: [], always: true };
    }

    if (trigger === "glob") {
      return { scopes, always: false };
    }

    if (trigger === "manual" || trigger === "model_decision") {
      return { scopes: [], always: false };
    }

    if (this.asBool(data.alwaysApply) === true) {
      return { scopes: [], always: true };
    }

    if (scopes.length > 0) {
      return { scopes, always: false };
    }

    return { scopes: [], always: true };
  }

  toGlobList(value: unknown): string[] {
    const out: string[] = [];

    const push = (text: string): void => {
      for (const part of this.frontmatter.splitItems(text)) {
        const cleaned = this.frontmatter.unquote(part.trim());

        if (cleaned !== "") {
          out.push(cleaned);
        }
      }
    };

    if (typeof value === "string") {
      push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          push(item);
        }
      }
    }

    return [...new Set(out)];
  }

  asBool(value: unknown): boolean | undefined {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();

      if (lowered === "true" || lowered === "yes") {
        return true;
      }

      if (lowered === "false" || lowered === "no") {
        return false;
      }
    }

    return undefined;
  }
}

export class RuleDiscovery {
  private readonly formats: FormatFlags;
  private readonly frontmatter: Frontmatter;
  private readonly semantics: Semantics;

  constructor(formats: FormatFlags) {
    this.formats = formats;
    this.frontmatter = new Frontmatter();
    this.semantics = new Semantics(this.frontmatter);
  }

  discover(cwd: string): DiscoveryResult {
    const rules: ParsedRule[] = [];
    const errors: RuleError[] = [];

    const toRel = (path: string): string => relative(cwd, path).split(sep).join("/");

    const ingest = (source: RuleSource, path: string): void => {
      let text: string;

      try {
        text = readFileSync(path, "utf8");
      } catch {
        errors.push({ source, path, relPath: toRel(path), message: "unable to read file" });
        return;
      }

      const fm = this.frontmatter.extract(text);

      if (fm.error !== null) {
        errors.push({ source, path, relPath: toRel(path), message: fm.error });
        return;
      }

      const body = fm.body.trim();

      if (body === "") {
        errors.push({ source, path, relPath: toRel(path), message: "empty rule body" });
        return;
      }

      const { scopes, always } = this.semantics.resolver(source)(fm.data);

      rules.push({ source, path, relPath: toRel(path), scopes, always, body });
    };

    if (this.formats.pi) {
      for (const file of this.listRuleFiles(join(cwd, ".pi", "rules"), ".md")) {
        ingest("pi", file);
      }
    }

    if (this.formats.claude) {
      for (const file of this.listRuleFiles(join(cwd, ".claude", "rules"), ".md")) {
        ingest("claude", file);
      }
    }

    if (this.formats.cursor) {
      for (const file of this.listRuleFiles(join(cwd, ".cursor", "rules"), ".mdc")) {
        ingest("cursor", file);
      }
    }

    if (this.formats.copilot) {
      const main = join(cwd, ".github", "copilot-instructions.md");

      if (this.isFile(main)) {
        ingest("copilot", main);
      }

      for (const file of this.listRuleFiles(join(cwd, ".github", "instructions"), ".instructions.md")) {
        ingest("copilot", file);
      }
    }

    if (this.formats.windsurf) {
      for (const file of this.listRuleFiles(join(cwd, ".windsurf", "rules"), ".md")) {
        ingest("windsurf", file);
      }
    }

    if (this.formats.cline) {
      const base = join(cwd, ".clinerules");
      const kind = this.clineKind(base);

      if (kind === "file") {
        ingest("cline", base);
      } else if (kind === "dir") {
        for (const file of this.listRuleFiles(base, ".md")) {
          ingest("cline", file);
        }
      }
    }

    return { rules, errors };
  }

  private clineKind(base: string): "file" | "dir" | "none" {
    try {
      const st = statSync(base);

      return st.isFile() ? "file" : st.isDirectory() ? "dir" : "none";
    } catch {
      return "none";
    }
  }

  private listRuleFiles(dir: string, suffix: string): string[] {
    let entries;

    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") || !entry.name.endsWith(suffix)) {
        continue;
      }

      const full = join(dir, entry.name);

      if (entry.isFile()) {
        out.push(full);
        continue;
      }

      if (entry.isSymbolicLink() && this.isFile(full)) {
        out.push(full);
      }
    }

    return out.sort();
  }

  private isFile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }
}
