import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Git } from "./index.ts";
import type { RepoInfo } from "./index.ts";
import type { WorktreeConfig } from "./render.ts";

export interface CompiledPattern {
  regex: RegExp;
  dirOnly: boolean;
  negated: boolean;
  anchored: boolean;
  literalHead: string;
}

export interface CopyOutcome {
  copied: number;
  failed: number;
  truncated: boolean;
}

const MAX_WALK_DEPTH = 64;

export class Patterns {
  toPosix(path: string): string {
    return path.split(sep).join("/");
  }

  isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);

    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  globToSource(pattern: string): string {
    let src = "";
    let i = 0;

    while (i < pattern.length) {
      if (pattern.startsWith("**/", i)) {
        src += "(?:[^/]+/)*";
        i += 3;
        continue;
      }

      if (pattern.startsWith("**", i)) {
        src += ".*";
        i += 2;
        continue;
      }

      const ch = pattern[i];

      if (ch === "*") {
        src += "[^/]*";
      } else if (ch === "?") {
        src += "[^/]";
      } else if ("\\^$.|+()[]{}".includes(ch)) {
        src += `\\${ch}`;
      } else {
        src += ch;
      }

      i++;
    }

    return src;
  }

  compilePatterns(raw: string): CompiledPattern[] {
    const patterns: CompiledPattern[] = [];

    for (const line of raw.split(/\r?\n/)) {
      let text = line.trim();

      if (!text || text.startsWith("#")) {
        continue;
      }

      let negated = false;

      if (text.startsWith("!")) {
        negated = true;
        text = text.slice(1).trim();
      }

      let dirOnly = false;

      if (text.endsWith("/")) {
        dirOnly = true;
        text = text.slice(0, -1);
      }

      let anchored = false;

      if (text.startsWith("/")) {
        anchored = true;
        text = text.slice(1);
      }

      if (!text) {
        continue;
      }

      if (text.includes("/")) {
        anchored = true;
      }

      const literalHead = anchored ? text.split(/[*?]/, 1)[0] : "";
      const prefix = anchored ? "^" : "^(?:.*/)?";

      patterns.push({
        regex: new RegExp(`${prefix}${this.globToSource(text)}$`),
        dirOnly,
        negated,
        anchored,
        literalHead
      });
    }

    return patterns;
  }

  matchesOne(pattern: CompiledPattern, rel: string, isDir: boolean): boolean {
    if (pattern.regex.test(rel)) {
      return isDir || !pattern.dirOnly;
    }

    const segments = rel.split("/");
    let prefix = "";

    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];

      if (pattern.regex.test(prefix)) {
        return true;
      }
    }

    return false;
  }

  decide(patterns: CompiledPattern[], rel: string, isDir: boolean): boolean {
    let included = false;

    for (const pattern of patterns) {
      if (this.matchesOne(pattern, rel, isDir)) {
        included = !pattern.negated;
      }
    }

    return included;
  }

  shouldDescend(patterns: CompiledPattern[], dirRel: string): boolean {
    for (const pattern of patterns) {
      if (pattern.negated || !pattern.anchored) {
        continue;
      }

      if (pattern.literalHead.startsWith(`${dirRel}/`)) {
        return true;
      }
    }

    return false;
  }
}

export class Walker {
  walkFiles(absDir: string, relDir: string, out: string[], cap: number, depth: number): void {
    if (out.length >= cap || depth > MAX_WALK_DEPTH) {
      return;
    }

    let items;

    try {
      items = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const sorted = [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const item of sorted) {
      if (out.length >= cap) {
        return;
      }

      if (item.name === ".git") {
        continue;
      }

      const abs = join(absDir, item.name);
      const rel = relDir ? `${relDir}/${item.name}` : item.name;

      if (item.isDirectory()) {
        this.walkFiles(abs, rel, out, cap, depth + 1);
      } else {
        out.push(rel);
      }
    }
  }
}

export class Include {
  private readonly git: Git;
  private readonly patterns: Patterns;
  private readonly walker: Walker;

  constructor(git: Git, patterns: Patterns = new Patterns(), walker: Walker = new Walker()) {
    this.git = git;
    this.patterns = patterns;
    this.walker = walker;
  }

  compilePatterns(raw: string): CompiledPattern[] {
    return this.patterns.compilePatterns(raw);
  }

  decide(patterns: CompiledPattern[], rel: string, isDir: boolean): boolean {
    return this.patterns.decide(patterns, rel, isDir);
  }

  async copyIncludes(config: WorktreeConfig, mainRoot: string, base: string, target: string): Promise<CopyOutcome> {
    const outcome: CopyOutcome = { copied: 0, failed: 0, truncated: false };
    const includePath = join(mainRoot, config.includeFile);
    let raw = "";

    try {
      if (!existsSync(includePath) || !lstatSync(includePath).isFile()) {
        return outcome;
      }

      raw = readFileSync(includePath, "utf8");
    } catch {
      return outcome;
    }

    const compiled = this.patterns.compilePatterns(raw);

    if (compiled.length === 0) {
      return outcome;
    }

    const files = await this.gather(config, compiled, mainRoot, base);

    if (files.length > config.maxIncludeFiles) {
      outcome.truncated = true;
      files.length = config.maxIncludeFiles;
    }

    for (const rel of files) {
      const parts = rel.split("/");
      const src = join(mainRoot, ...parts);
      const dest = join(target, ...parts);

      try {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest, { force: true, verbatimSymlinks: true });
        outcome.copied++;
      } catch {
        outcome.failed++;
      }
    }

    return outcome;
  }

  ensureExcluded(repo: RepoInfo, base: string): string | undefined {
    const rel = relative(repo.mainRoot, base);

    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return undefined;
    }

    const line = `/${this.patterns.toPosix(rel)}/`;

    try {
      const infoDir = join(repo.commonDir, "info");
      const excludePath = join(infoDir, "exclude");
      mkdirSync(infoDir, { recursive: true });
      const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";

      if (current.split(/\r?\n/).includes(line)) {
        return undefined;
      }

      const separator = current && !current.endsWith("\n") ? "\n" : "";
      appendFileSync(excludePath, `${separator}${line}\n`);

      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return `Could not register ${line} in git/info/exclude (${message}); the worktree directory may show as untracked.`;
    }
  }

  private async gather(
    config: WorktreeConfig,
    compiled: CompiledPattern[],
    mainRoot: string,
    base: string
  ): Promise<string[]> {
    const cap = config.maxIncludeFiles;
    const overflow = cap + 1;
    const baseRel = this.patterns.isInside(base, mainRoot) ? this.patterns.toPosix(relative(mainRoot, base)) : "";

    const untracked = await this.git.git(
      mainRoot,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      config.gitTimeoutMs
    );

    const ignored = await this.git.git(
      mainRoot,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      config.gitTimeoutMs
    );

    const candidates = new Set<string>();

    for (const chunk of `${untracked.stdout}\0${ignored.stdout}`.split("\0")) {
      if (chunk) {
        candidates.add(chunk);
      }
    }

    const selected = new Set<string>();

    for (const candidate of candidates) {
      if (selected.size >= overflow) {
        break;
      }

      const isDir = candidate.endsWith("/");
      const rel = isDir ? candidate.slice(0, -1) : candidate;

      if (!rel || rel === config.includeFile) {
        continue;
      }

      if (baseRel && (rel === baseRel || rel.startsWith(`${baseRel}/`))) {
        continue;
      }

      if (this.patterns.decide(compiled, rel, isDir)) {
        if (isDir) {
          this.absorbDir(selected, mainRoot, rel, overflow, compiled, false);
        } else {
          selected.add(rel);
        }
      } else if (isDir && this.patterns.shouldDescend(compiled, rel)) {
        this.absorbDir(selected, mainRoot, rel, overflow, compiled, true);
      }
    }

    return [...selected];
  }

  private absorbDir(
    selected: Set<string>,
    mainRoot: string,
    rel: string,
    overflow: number,
    compiled: CompiledPattern[],
    filterByDecision: boolean
  ): void {
    const files: string[] = [];
    this.walker.walkFiles(join(mainRoot, ...rel.split("/")), rel, files, overflow, 0);

    for (const file of files) {
      if (filterByDecision && !this.patterns.decide(compiled, file, false)) {
        continue;
      }

      selected.add(file);
    }
  }
}
