import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface SkillServerEntry {
  name: string;
  raw: unknown;
  skillPath: string;
}

interface YamlLine {
  indent: number;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function findColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble && (i === text.length - 1 || text[i + 1] === " ")) return i;
  }
  return -1;
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "string" ? parsed : text.slice(1, -1);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function splitInline(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && (ch === "[" || ch === "{")) depth += 1;
    else if (!inSingle && !inDouble && (ch === "]" || ch === "}")) depth -= 1;
    if (ch === "," && depth === 0 && !inSingle && !inDouble) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out.filter((entry) => entry !== "");
}

function parseScalar(text: string): unknown {
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      void 0;
    }
    if (text.startsWith("[") && text.endsWith("]")) {
      return splitInline(text.slice(1, -1)).map((item) => parseScalar(item));
    }
    return text;
  }
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function isListItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function parseListBlock(lines: YamlLine[], start: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== indent || !isListItem(line.text)) break;
    const rest = line.text === "-" ? "" : line.text.slice(2).trim();
    if (rest === "") {
      const next = i + 1 < lines.length ? lines[i + 1] : null;
      if (next !== null && next.indent > indent) {
        if (isListItem(next.text)) {
          const [value, nextIndex] = parseListBlock(lines, i + 1, next.indent);
          out.push(value);
          i = nextIndex;
        } else {
          const [value, nextIndex] = parseMapBlock(lines, i + 1, next.indent);
          out.push(value);
          i = nextIndex;
        }
      } else {
        out.push(null);
        i += 1;
      }
    } else {
      out.push(parseScalar(rest));
      i += 1;
    }
  }
  return [out, i];
}

function parseMapBlock(lines: YamlLine[], start: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent || isListItem(line.text)) {
      i += 1;
      continue;
    }
    const colon = findColon(line.text);
    if (colon === -1) {
      i += 1;
      continue;
    }
    const key = unquote(line.text.slice(0, colon).trim());
    const rest = line.text.slice(colon + 1).trim();
    if (rest === "") {
      const next = i + 1 < lines.length ? lines[i + 1] : null;
      if (next !== null && next.indent > indent) {
        if (isListItem(next.text)) {
          const [value, nextIndex] = parseListBlock(lines, i + 1, next.indent);
          out[key] = value;
          i = nextIndex;
        } else {
          const [value, nextIndex] = parseMapBlock(lines, i + 1, next.indent);
          out[key] = value;
          i = nextIndex;
        }
      } else {
        out[key] = null;
        i += 1;
      }
    } else {
      out[key] = parseScalar(rest);
      i += 1;
    }
  }
  return [out, i];
}

function parseYamlBlock(block: string): Record<string, unknown> {
  const lines: YamlLine[] = [];
  for (const raw of block.split("\n")) {
    const cleaned = stripComment(raw.replace(/\r$/, ""));
    if (cleaned.trim() === "") continue;
    const indent = cleaned.length - cleaned.trimStart().length;
    lines.push({ indent, text: cleaned.trim() });
  }
  const [value] = parseMapBlock(lines, 0, lines.length > 0 ? lines[0].indent : 0);
  return value;
}

function parseFrontmatter(source: string): Record<string, unknown> | null {
  const normalized = source.replace(/^\uFEFF/, "");
  const firstLineEnd = normalized.indexOf("\n");
  if (firstLineEnd === -1) return null;
  if (normalized.slice(0, firstLineEnd).replace(/\r$/, "").trim() !== "---") return null;
  const rest = normalized.slice(firstLineEnd + 1);
  const endMatch = /^---\s*$/m.exec(rest);
  if (endMatch === null) return null;
  return parseYamlBlock(rest.slice(0, endMatch.index));
}

function resolveDir(dir: string, baseDir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  if (isAbsolute(dir)) return dir;
  return resolve(baseDir, dir);
}

function walk(dir: string, depth: number, maxDepth: number, onSkill: (path: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (entry.name !== "SKILL.md") continue;
      try {
        if (statSync(full).isFile()) onSkill(full);
      } catch {
        continue;
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (depth < maxDepth) walk(full, depth + 1, maxDepth, onSkill);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      onSkill(full);
    }
  }
}

export function discoverSkillServers(skillDirs: string[], baseDir: string, maxDepth: number): SkillServerEntry[] {
  const out: SkillServerEntry[] = [];
  const seen = new Set<string>();
  for (const dir of skillDirs) {
    const resolved = resolveDir(dir, baseDir);
    walk(resolved, 0, maxDepth, (skillPath) => {
      let source: string;
      try {
        source = readFileSync(skillPath, "utf8");
      } catch {
        return;
      }
      const frontmatter = parseFrontmatter(source);
      if (frontmatter === null || !isRecord(frontmatter.mcp)) return;
      for (const [name, raw] of Object.entries(frontmatter.mcp)) {
        if (seen.has(name) || !isRecord(raw)) continue;
        seen.add(name);
        out.push({ name, raw, skillPath });
      }
    });
  }
  return out;
}
