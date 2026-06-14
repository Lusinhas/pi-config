import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ParsedRule } from "./formats.ts";

const MAX_BASH_PATHS = 24;
const MAX_BASH_TOKENS = 200;

export class GlobMatcher {
  private readonly regexCache = new Map<string, RegExp | null>();

  match(glob: string, relPath: string): boolean {
    const trimmed = glob.trim();

    if (trimmed === "") {
      return false;
    }

    const path = this.normalizeRelPath(relPath);

    if (path === "") {
      return false;
    }

    const effective = trimmed.includes("/") ? trimmed : `**/${trimmed}`;
    const regex = this.toRegExp(effective);

    return regex !== null && regex.test(path);
  }

  toRegExp(glob: string): RegExp | null {
    const cached = this.regexCache.get(glob);

    if (cached !== undefined) {
      return cached;
    }

    let compiled: RegExp | null = null;

    try {
      let g = glob.trim().replace(/\\/g, "/");

      if (g.startsWith("./")) {
        g = g.slice(2);
      }

      while (g.startsWith("/")) {
        g = g.slice(1);
      }

      if (g.endsWith("/")) {
        g += "**";
      }

      const segments = this.splitTopLevel(g, "/").filter((seg) => seg !== "" && seg !== ".");

      if (segments.length === 0) {
        this.regexCache.set(glob, null);
        return null;
      }

      let pattern = "";
      let needSlash = false;

      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        const last = i === segments.length - 1;

        if (segment === "**") {
          if (last) {
            pattern += needSlash ? "(?:/.*)?" : ".*";
          } else if (needSlash) {
            pattern += "(?:/[^/]+)*";
          } else {
            pattern += "(?:[^/]+/)*";
          }

          continue;
        }

        pattern += (needSlash ? "/" : "") + this.segmentToRegex(segment);
        needSlash = true;
      }

      compiled = new RegExp(`^${pattern}$`);
    } catch {
      compiled = null;
    }

    this.regexCache.set(glob, compiled);

    return compiled;
  }

  normalizeRelPath(path: string): string {
    let p = path.trim().replace(/\\/g, "/");

    while (p.startsWith("./")) {
      p = p.slice(2);
    }

    while (p.startsWith("/")) {
      p = p.slice(1);
    }

    p = p.replace(/\/{2,}/g, "/");

    while (p.endsWith("/") && p.length > 1) {
      p = p.slice(0, -1);
    }

    return p === "/" ? "" : p;
  }

  private segmentToRegex(segment: string): string {
    let out = "";
    let i = 0;

    while (i < segment.length) {
      const ch = segment[i];

      if (ch === "*") {
        out += "[^/]*";
        i += 1;
        continue;
      }

      if (ch === "?") {
        out += "[^/]";
        i += 1;
        continue;
      }

      if (ch === "{") {
        let depth = 1;
        let j = i + 1;

        while (j < segment.length && depth > 0) {
          if (segment[j] === "{") {
            depth += 1;
          } else if (segment[j] === "}") {
            depth -= 1;
          }

          if (depth > 0) {
            j += 1;
          }
        }

        if (depth === 0) {
          const inner = segment.slice(i + 1, j);
          const alternatives = this.splitTopLevel(inner, ",").map((alt) => this.segmentToRegex(alt));
          out += `(?:${alternatives.join("|")})`;
          i = j + 1;
          continue;
        }

        out += "\\{";
        i += 1;
        continue;
      }

      out += this.escapeRegexChar(ch);
      i += 1;
    }

    return out;
  }

  private splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";

    for (const ch of text) {
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
      }

      if (ch === separator && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }

      current += ch;
    }

    parts.push(current);

    return parts;
  }

  private escapeRegexChar(ch: string): string {
    return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
}

export class PathResolver {
  toProjectRelative(raw: string, projectRoot: string, baseCwd: string): string | null {
    let candidate = this.stripPairedQuotes(raw.trim());

    if (candidate === "" || candidate.includes("://")) {
      return null;
    }

    if (candidate === "~") {
      candidate = homedir();
    } else if (candidate.startsWith("~/")) {
      candidate = resolve(homedir(), candidate.slice(2));
    }

    const absolute = isAbsolute(candidate) ? normalize(candidate) : resolve(baseCwd, candidate);
    const rel = relative(projectRoot, absolute);

    if (rel === "" || rel === ".") {
      return null;
    }

    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }

    return rel.split(sep).join("/");
  }

  stripPairedQuotes(value: string): string {
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

export class BashPaths {
  private readonly resolver: PathResolver;

  constructor(resolver: PathResolver) {
    this.resolver = resolver;
  }

  extract(command: string, projectRoot: string, baseCwd: string): string[] {
    const found = new Set<string>();
    const tokens = command.split(/[\s;|&()<>`]+/u);
    let inspected = 0;

    for (const raw of tokens) {
      if (found.size >= MAX_BASH_PATHS || inspected >= MAX_BASH_TOKENS) {
        break;
      }

      inspected += 1;
      let token = raw.trim();

      if (token === "") {
        continue;
      }

      if (token.startsWith("-")) {
        const eq = token.indexOf("=");

        if (eq === -1) {
          continue;
        }

        token = token.slice(eq + 1);
      }

      token = this.resolver.stripPairedQuotes(token).replace(/[),:;'"!]+$/u, "");
      token = token.replace(/:\d+(?::\d+)?$/u, "");

      if (token === "" || token === "." || token === ".." || token.includes("://")) {
        continue;
      }

      if (token.includes("*") || token.includes("$") || token.includes("{")) {
        continue;
      }

      const pathLike = token.includes("/") || /^[\w@][\w.@+~-]*\.[A-Za-z0-9]{1,8}$/u.test(token);

      if (!pathLike) {
        continue;
      }

      const rel = this.resolver.toProjectRelative(token, projectRoot, baseCwd);

      if (rel === null) {
        continue;
      }

      const segments = rel.split("/");

      if (segments.includes(".git") || segments.includes("node_modules")) {
        continue;
      }

      if (!existsSync(join(projectRoot, rel))) {
        continue;
      }

      found.add(rel);
    }

    return [...found];
  }
}

export class TouchTracker {
  private readonly resolver: PathResolver;
  private readonly bashPaths: BashPaths;
  private current = new Set<string>();
  private last = new Set<string>();

  constructor(resolver: PathResolver, bashPaths: BashPaths) {
    this.resolver = resolver;
    this.bashPaths = bashPaths;
  }

  touch(raw: string, projectRoot: string, baseCwd: string): void {
    const rel = this.resolver.toProjectRelative(raw, projectRoot, baseCwd);

    if (rel !== null) {
      this.current.add(rel);
    }
  }

  touchBashCommand(command: string, projectRoot: string, baseCwd: string): void {
    for (const rel of this.bashPaths.extract(command, projectRoot, baseCwd)) {
      this.current.add(rel);
    }
  }

  consume(): string[] {
    this.last = this.current;
    this.current = new Set<string>();

    return [...this.last];
  }

  lastPaths(): string[] {
    return [...this.last];
  }

  pendingCount(): number {
    return this.current.size;
  }

  reset(): void {
    this.current = new Set<string>();
    this.last = new Set<string>();
  }
}

export interface FillContext {
  hashes: Map<string, string>;
  lastInjected: Map<string, string>;
  nextInjected: Map<string, string>;
  nextActive: Set<string>;
}

export class BudgetFiller {
  fill(group: ParsedRule[], budget: number, blocks: string[], context: FillContext): void {
    let used = 0;

    for (const rule of group) {
      const hash = context.hashes.get(rule.path);

      if (hash === undefined) {
        continue;
      }

      if (context.lastInjected.get(rule.path) === hash) {
        context.nextInjected.set(rule.path, hash);
        context.nextActive.add(rule.path);
        continue;
      }

      const header = this.renderHeader(rule);
      let block = `${header}\n${rule.body}`;

      if (used + block.length > budget) {
        const remaining = budget - used;
        const overhead = header.length + 64;

        if (blocks.length > 0 || remaining <= overhead) {
          continue;
        }

        block = `${header}\n${rule.body.slice(0, remaining - overhead)}\n[rule truncated to fit budget]`;
      }

      blocks.push(block);
      used += block.length;
      context.nextInjected.set(rule.path, hash);
      context.nextActive.add(rule.path);
    }
  }

  renderHeader(rule: ParsedRule): string {
    return rule.always
      ? `### Rule: ${rule.relPath} [${rule.source}, always]`
      : `### Rule: ${rule.relPath} [${rule.source}, paths: ${rule.scopes.join(" ")}]`;
  }
}
