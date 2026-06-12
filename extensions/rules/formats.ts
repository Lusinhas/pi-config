import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

export interface FormatFlags {
  pi: boolean;
  claude: boolean;
  cursor: boolean;
  copilot: boolean;
  windsurf: boolean;
  cline: boolean;
}

export interface DiscoveryResult {
  rules: ParsedRule[];
  errors: RuleError[];
}

interface RuleSemantics {
  scopes: string[];
  always: boolean;
}

interface FrontmatterResult {
  data: Record<string, unknown>;
  body: string;
  error: string | null;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function splitItems(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text) {
    if (quote !== "") {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
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

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return splitItems(inner).map((part) => unquote(part.trim())).filter((part) => part !== "");
  }
  const bare = unquote(trimmed);
  if (bare !== trimmed) return bare;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

function parseFrontmatterBlock(raw: string): Record<string, unknown> {
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
      data[key] = parseScalar(rest);
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
      if (itemMatch === null) break;
      const item = unquote(itemMatch[1].trim());
      if (item !== "") items.push(item);
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

export function extractFrontmatter(text: string): FrontmatterResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split("\n");
  const first = (lines[0] ?? "").replace(/\r$/, "").trim();
  if (first !== "---") return { data: {}, body: src, error: null };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].replace(/\r$/, "").trim();
    if (trimmed === "---" || trimmed === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: "", error: "unterminated frontmatter" };
  const raw = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  return { data: parseFrontmatterBlock(raw), body, error: null };
}

function toGlobList(value: unknown): string[] {
  const out: string[] = [];
  const push = (text: string): void => {
    for (const part of splitItems(text)) {
      const cleaned = unquote(part.trim());
      if (cleaned !== "") out.push(cleaned);
    }
  };
  if (typeof value === "string") push(value);
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") push(item);
    }
  }
  return [...new Set(out)];
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "yes") return true;
    if (lowered === "false" || lowered === "no") return false;
  }
  return undefined;
}

function nativeSemantics(data: Record<string, unknown>): RuleSemantics {
  const scopes = [...new Set([...toGlobList(data.paths), ...toGlobList(data.globs)])];
  const always = asBool(data.alwaysApply);
  return { scopes, always: always === true || (always === undefined && scopes.length === 0) };
}

function cursorSemantics(data: Record<string, unknown>): RuleSemantics {
  return { scopes: toGlobList(data.globs), always: asBool(data.alwaysApply) === true };
}

function copilotSemantics(data: Record<string, unknown>): RuleSemantics {
  const scopes = toGlobList(data.applyTo);
  if (scopes.length === 0 || scopes.includes("**") || scopes.includes("**/*")) {
    return { scopes: [], always: true };
  }
  return { scopes, always: false };
}

function windsurfSemantics(data: Record<string, unknown>): RuleSemantics {
  const trigger = typeof data.trigger === "string" ? data.trigger.trim().toLowerCase() : "";
  const scopes = [...new Set([...toGlobList(data.globs), ...toGlobList(data.paths)])];
  if (trigger === "always_on") return { scopes: [], always: true };
  if (trigger === "glob") return { scopes, always: false };
  if (trigger === "manual" || trigger === "model_decision") return { scopes: [], always: false };
  if (asBool(data.alwaysApply) === true) return { scopes: [], always: true };
  if (scopes.length > 0) return { scopes, always: false };
  return { scopes: [], always: true };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listRuleFiles(dir: string, suffix: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.name.endsWith(suffix)) continue;
    const full = join(dir, entry.name);
    if (entry.isFile()) {
      out.push(full);
      continue;
    }
    if (entry.isSymbolicLink() && isFile(full)) out.push(full);
  }
  return out.sort();
}

export function discoverRules(cwd: string, formats: FormatFlags): DiscoveryResult {
  const rules: ParsedRule[] = [];
  const errors: RuleError[] = [];

  const toRel = (path: string): string => relative(cwd, path).split(sep).join("/");

  const ingest = (
    source: RuleSource,
    path: string,
    semantics: (data: Record<string, unknown>) => RuleSemantics,
  ): void => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      errors.push({ source, path, relPath: toRel(path), message: "unable to read file" });
      return;
    }
    const fm = extractFrontmatter(text);
    if (fm.error !== null) {
      errors.push({ source, path, relPath: toRel(path), message: fm.error });
      return;
    }
    const body = fm.body.trim();
    if (body === "") {
      errors.push({ source, path, relPath: toRel(path), message: "empty rule body" });
      return;
    }
    const { scopes, always } = semantics(fm.data);
    rules.push({ source, path, relPath: toRel(path), scopes, always, body });
  };

  if (formats.pi) {
    for (const file of listRuleFiles(join(cwd, ".pi", "rules"), ".md")) ingest("pi", file, nativeSemantics);
  }
  if (formats.claude) {
    for (const file of listRuleFiles(join(cwd, ".claude", "rules"), ".md")) ingest("claude", file, nativeSemantics);
  }
  if (formats.cursor) {
    for (const file of listRuleFiles(join(cwd, ".cursor", "rules"), ".mdc")) ingest("cursor", file, cursorSemantics);
  }
  if (formats.copilot) {
    const main = join(cwd, ".github", "copilot-instructions.md");
    if (isFile(main)) ingest("copilot", main, copilotSemantics);
    for (const file of listRuleFiles(join(cwd, ".github", "instructions"), ".instructions.md")) {
      ingest("copilot", file, copilotSemantics);
    }
  }
  if (formats.windsurf) {
    for (const file of listRuleFiles(join(cwd, ".windsurf", "rules"), ".md")) ingest("windsurf", file, windsurfSemantics);
  }
  if (formats.cline) {
    const base = join(cwd, ".clinerules");
    let kind: "file" | "dir" | "none" = "none";
    try {
      const st = statSync(base);
      kind = st.isFile() ? "file" : st.isDirectory() ? "dir" : "none";
    } catch {
      kind = "none";
    }
    if (kind === "file") ingest("cline", base, nativeSemantics);
    else if (kind === "dir") {
      for (const file of listRuleFiles(base, ".md")) ingest("cline", file, nativeSemantics);
    }
  }
  return { rules, errors };
}
