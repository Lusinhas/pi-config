export type Language = "ts" | "js" | "py" | "go" | "rs" | "sh" | "c" | "cpp" | "java" | "rb" | "json" | "md";

export type Rule = "narration" | "fillerdoc" | "changemarker" | "todo" | "separator";

export interface Finding {
  rule: Rule;
  line: number;
  text: string;
  message: string;
}

export interface DetectorToggles {
  narration: boolean;
  fillerdoc: boolean;
  changemarker: boolean;
  todo: boolean;
  separator: boolean;
}

export interface ScanOptions {
  allowMarker: string;
  detectors: DetectorToggles;
}

interface CommentSyntax {
  lineMarker: string;
  blockStart: string | null;
  blockEnd: string | null;
}

interface LineEntry {
  line: number;
  raw: string;
  body: string;
  trailing: string;
  added: boolean;
}

interface BlockLine {
  line: number;
  raw: string;
  body: string;
  added: boolean;
}

interface BlockEntry {
  startLine: number;
  endLine: number;
  raw: string;
  doc: boolean;
  added: boolean;
  bodies: BlockLine[];
}

interface Extraction {
  lineComments: LineEntry[];
  blocks: BlockEntry[];
  kinds: Array<"code" | "comment" | "blank">;
}

interface LineScan {
  marker: "line" | "block" | null;
  index: number;
  stringOpen: string | null;
}

interface CodeWords {
  all: Set<string>;
  full: Set<string>;
}

const C_STYLE: CommentSyntax = { lineMarker: "//", blockStart: "/*", blockEnd: "*/" };
const HASH_STYLE: CommentSyntax = { lineMarker: "#", blockStart: null, blockEnd: null };

const SYNTAX: Partial<Record<Language, CommentSyntax>> = {
  ts: C_STYLE,
  js: C_STYLE,
  go: C_STYLE,
  rs: C_STYLE,
  c: C_STYLE,
  cpp: C_STYLE,
  java: C_STYLE,
  py: HASH_STYLE,
  sh: HASH_STYLE,
  rb: HASH_STYLE,
};

const EXTENSIONS: Record<string, Language> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  pyi: "py",
  pyw: "py",
  go: "go",
  rs: "rs",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  ksh: "sh",
  fish: "sh",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  ino: "cpp",
  java: "java",
  rb: "rb",
  rake: "rb",
  gemspec: "rb",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "md",
  markdown: "md",
  mdx: "md",
};

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "for",
  "and",
  "or",
  "is",
  "are",
  "was",
  "be",
  "been",
  "this",
  "that",
  "these",
  "those",
  "with",
  "from",
  "into",
  "onto",
  "our",
  "all",
  "each",
  "every",
  "then",
  "now",
  "it",
  "its",
  "in",
  "on",
  "at",
  "by",
  "as",
  "we",
  "you",
  "via",
  "using",
  "use",
  "note",
  "also",
  "just",
  "will",
  "does",
  "do",
  "done",
  "here",
  "there",
  "if",
  "when",
]);

const GENERIC_DOC = new Set([
  "value",
  "values",
  "given",
  "specified",
  "provided",
  "input",
  "inputs",
  "output",
  "outputs",
  "result",
  "results",
  "return",
  "returns",
  "returned",
  "object",
  "objects",
  "instance",
  "optional",
  "string",
  "number",
  "boolean",
  "array",
  "list",
  "function",
  "method",
  "callback",
  "item",
  "items",
  "element",
  "elements",
  "new",
  "data",
  "class",
  "constructor",
  "getter",
  "setter",
  "helper",
  "config",
  "configuration",
  "options",
  "option",
  "parameter",
  "parameters",
  "param",
  "params",
  "argument",
  "arguments",
  "arg",
  "args",
  "name",
  "type",
  "types",
  "flag",
  "indicates",
  "whether",
]);

const DIRECTIVES: RegExp[] = [
  /^!/,
  /^<reference\b/i,
  /^eslint[- ]/i,
  /^prettier-ignore/i,
  /^biome-ignore/i,
  /^deno-lint-ignore/i,
  /^dprint-ignore/i,
  /^@ts-(?:ignore|expect-error|nocheck|check)\b/,
  /^ts-(?:ignore|expect-error)\b/i,
  /^istanbul ignore/i,
  /^c8 ignore/i,
  /^v8 ignore/i,
  /^noqa\b/i,
  /^type:\s*ignore\b/i,
  /^mypy:/i,
  /^pylint:/i,
  /^ruff:/i,
  /^flake8:/i,
  /^isort:/i,
  /^yapf:/i,
  /^bandit:/i,
  /^nosec\b/i,
  /^fmt:\s*(?:off|on|skip)\b/i,
  /^rustfmt::/i,
  /^clippy::/i,
  /^go:(?:build|generate|embed|linkname|noinline|nosplit|nocheckptr)\b/,
  /^\+build\b/,
  /^nolint\b/i,
  /^shellcheck\b/i,
  /^nosonar\b/i,
  /^#?(?:region|endregion)\b/i,
  /^pragma\b/i,
  /^cspell:/i,
  /^spell-checker:/i,
  /^codespell:/i,
  /^webpack[A-Za-z]+:/,
  /^@?vite-ignore\b/,
  /^@__PURE__/,
  /^jscpd:/i,
  /^sourcery:/i,
  /^coverage:/i,
  /^jshint\b/i,
  /^jslint\b/i,
  /^swiftlint:/i,
  /^keep-sorted\b/i,
  /^frozen_string_literal:/i,
  /^encoding:/i,
  /^rubocop:/i,
  /^typed:/i,
  /^warn_indent:/i,
];

const REASONING =
  /\b(?:because|since|so that|avoids?|ensures?|prevents?|otherwise|workaround|instead|deliberate(?:ly)?|intentional(?:ly)?|important|must|caution|warning|tradeoffs?|trade-offs?|security|performance|backwards?|compat(?:ibility)?|invariant|gotcha|caveat)\b/i;

const NARRATION: RegExp[] = [
  /^call(?:s|ing)?\s+(?:the|a|an|this)\s+[\w.]+(?:\s+(?:function|method|here))?\s*\.?$/i,
  /^loop(?:s|ing)?\s+(?:over|through)\b/i,
  /^iterat(?:e|es|ing)\s+(?:over|through)\b/i,
  /^(?:now|here)\s+we\b/i,
  /^(?:first|next|then|finally),?\s+(?:we|let'?s)\b/i,
  /^let'?s\s+(?:call|create|define|loop|iterate|check|start|begin)\b/i,
  /^we\s+(?:now\s+)?(?:call|loop|iterate|create|define|return|check|set|get|use)\b/i,
  /^(?:increment|decrement)s?\s+(?:the\s+)?[\w.]+\s*\.?$/i,
  /^(?:declare|define|initialize|instantiate|create)s?\s+(?:a|an|the)\s+[\w.\s]{1,30}$/i,
];

const CHANGE_MARKERS: RegExp[] = [
  /^\(?(?:added|new|updated|changed|modified|edited|fixed|removed|moved|renamed|refactored|tweaked|adjusted)\)?\s*[:!.]*$/i,
  /^(?:added|updated|changed|modified|edited)\s+(?:to|this|the|so|now|per|as requested|in response)\b/i,
  /^now\s+(?:uses?|returns?|handles?|supports?|takes?|accepts?|using|with)\b/i,
  /^newly\s+added\b/i,
];

const TAG = /^@(param|arg|argument|returns?|prop|property)\b\s*(.*)$/i;

export function detectLanguage(path: string, content?: string): Language | null {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const found = EXTENSIONS[base.slice(dot + 1).toLowerCase()];
    if (found !== undefined) {
      return found;
    }
  }
  if (content !== undefined) {
    const first = content.split("\n", 1)[0] ?? "";
    if (first.startsWith("#!")) {
      if (/\b(?:bash|zsh|ksh|fish)\b|\bsh\b/.test(first)) {
        return "sh";
      }
      if (/\bpython[\d.]*\b/.test(first)) {
        return "py";
      }
      if (/\bruby\b/.test(first)) {
        return "rb";
      }
      if (/\b(?:node|deno|bun)\b/.test(first)) {
        return "js";
      }
    }
  }
  return null;
}

function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) {
    return `${w.slice(0, -3)}y`;
  }
  if (w.length > 4 && w.endsWith("ing")) {
    return w.slice(0, -3);
  }
  if (w.length > 3 && w.endsWith("ed")) {
    return w.slice(0, -2);
  }
  if (w.length > 3 && w.endsWith("es")) {
    return w.slice(0, -2);
  }
  if (w.length > 2 && w.endsWith("s") && !w.endsWith("ss")) {
    return w.slice(0, -1);
  }
  return w;
}

function commentWords(body: string): string[] {
  const matches = body.toLowerCase().match(/[a-z][a-z0-9']*/g) ?? [];
  return matches.map((word) => word.replace(/'/g, "")).filter((word) => word.length > 0);
}

function codeWords(code: string): CodeWords {
  const all = new Set<string>();
  const full = new Set<string>();
  const ids = code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const id of ids) {
    const lower = id.toLowerCase();
    full.add(lower);
    all.add(lower);
    all.add(stem(lower));
    const spaced = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    for (const part of spaced.split(/[_$\s]+/)) {
      if (part.length === 0) {
        continue;
      }
      const p = part.toLowerCase();
      all.add(p);
      all.add(stem(p));
    }
  }
  return { all, full };
}

function isExempt(body: string, raw: string, allowMarker: string): boolean {
  if (allowMarker.length > 0 && raw.includes(allowMarker)) {
    return true;
  }
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (/\bwhy\b/i.test(trimmed)) {
    return true;
  }
  if (/\b(?:copyright|licen[cs]ed?|spdx|all rights reserved|public domain)\b/i.test(trimmed)) {
    return true;
  }
  return DIRECTIVES.some((directive) => directive.test(trimmed));
}

function isSeparator(body: string): boolean {
  const stripped = body.replace(/\s+/g, "");
  if (stripped.length < 4) {
    return false;
  }
  if (!/^[-=*_~#+.<>|\\/]+$/.test(stripped)) {
    return false;
  }
  return new Set(stripped.split("")).size <= 2;
}

function isChangeMarker(body: string): boolean {
  return CHANGE_MARKERS.some((pattern) => pattern.test(body));
}

function isLooseTodo(body: string): boolean {
  if (!/\b(?:TODO|FIXME|XXX|HACK)\b/.test(body)) {
    return false;
  }
  if (/\b(?:TODO|FIXME|XXX|HACK)\s*\([^)]*\S[^)]*\)/.test(body)) {
    return false;
  }
  if (/#\d+/.test(body)) {
    return false;
  }
  if (/\b[A-Z][A-Z0-9]+-\d+\b/.test(body)) {
    return false;
  }
  if (/https?:\/\//i.test(body)) {
    return false;
  }
  return true;
}

function isGenericNarration(body: string): boolean {
  if (REASONING.test(body)) {
    return false;
  }
  const words = body.split(/\s+/).filter((word) => word.length > 0);
  if (words.length > 8) {
    return false;
  }
  return NARRATION.some((pattern) => pattern.test(body));
}

function restatesCode(body: string, code: string): boolean {
  if (code.trim().length === 0) {
    return false;
  }
  if (REASONING.test(body) || body.includes("?")) {
    return false;
  }
  const rawWords = commentWords(body);
  if (rawWords.length === 0 || rawWords.length > 10) {
    return false;
  }
  const significant = rawWords.filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  if (significant.length === 0) {
    return false;
  }
  const ids = codeWords(code);
  if (significant.length === 1) {
    return rawWords.length <= 3 && ids.full.has(significant[0]);
  }
  return significant.every((word) => ids.all.has(word) || ids.all.has(stem(word)));
}

function fillerTag(tag: string, rest: string): boolean {
  let working = rest.trim();
  let typeText = "";
  if (working.startsWith("{")) {
    const close = working.indexOf("}");
    if (close > 0) {
      typeText = working.slice(1, close);
      working = working.slice(close + 1).trim();
    }
  }
  let name = "";
  if (!/^returns?$/i.test(tag)) {
    const match = /^(\[[^\]]*\]|[\w$.]+)/.exec(working);
    if (match) {
      name = match[1];
      working = working.slice(match[1].length).trim();
    }
  }
  const desc = working.replace(/^[-–—:]+\s*/, "").trim();
  if (desc.length === 0) {
    return true;
  }
  if (REASONING.test(desc) || /\bwhy\b/i.test(desc)) {
    return false;
  }
  const allowed = codeWords(`${name} ${typeText}`).all;
  const words = commentWords(desc).filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  if (words.length === 0) {
    return true;
  }
  return words.every(
    (word) => allowed.has(word) || allowed.has(stem(word)) || GENERIC_DOC.has(word) || GENERIC_DOC.has(stem(word)),
  );
}

function fillerSummary(body: string, code: string): boolean {
  if (REASONING.test(body) || /\bwhy\b/i.test(body)) {
    return false;
  }
  const rawWords = commentWords(body);
  if (rawWords.length === 0) {
    return true;
  }
  if (rawWords.length > 12) {
    return false;
  }
  const significant = rawWords.filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  if (significant.length === 0) {
    return true;
  }
  const ids = codeWords(code);
  return significant.every(
    (word) => ids.all.has(word) || ids.all.has(stem(word)) || GENERIC_DOC.has(word) || GENERIC_DOC.has(stem(word)),
  );
}

function persistentDelims(language: Language): string[] {
  switch (language) {
    case "ts":
    case "js":
    case "go":
      return ["`"];
    case "py":
      return ['"""', "'''"];
    case "sh":
      return ["'", '"'];
    case "rs":
      return ['"'];
    default:
      return [];
  }
}

function markerAllowed(language: Language, raw: string, index: number): boolean {
  if (language !== "sh") {
    return true;
  }
  if (index === 0) {
    return true;
  }
  const prev = raw[index - 1];
  return prev === " " || prev === "\t" || prev === ";";
}

function scanCode(raw: string, syntax: CommentSyntax, language: Language, openAtStart: string | null): LineScan {
  const triples = language === "py" ? ['"""', "'''"] : [];
  const backtickString = language === "ts" || language === "js" || language === "go";
  let open = openAtStart;
  let marker: "line" | "block" | null = null;
  let index = -1;
  let i = 0;
  while (i < raw.length) {
    if (open !== null) {
      if (open.length > 1) {
        if (raw.startsWith(open, i)) {
          open = null;
          i += 3;
        } else {
          i += 1;
        }
        continue;
      }
      const ch = raw[i];
      if (ch === "\\" && !(language === "sh" && open === "'")) {
        i += 2;
        continue;
      }
      if (ch === open) {
        open = null;
      }
      i += 1;
      continue;
    }
    if (raw.startsWith(syntax.lineMarker, i) && markerAllowed(language, raw, i)) {
      marker = "line";
      index = i;
      break;
    }
    if (syntax.blockStart !== null && raw.startsWith(syntax.blockStart, i)) {
      marker = "block";
      index = i;
      break;
    }
    let openedTriple = false;
    for (const delim of triples) {
      if (raw.startsWith(delim, i)) {
        open = delim;
        i += delim.length;
        openedTriple = true;
        break;
      }
    }
    if (openedTriple) {
      continue;
    }
    const ch = raw[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === "`" && backtickString)) {
      open = ch;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (open !== null && !persistentDelims(language).includes(open)) {
    open = null;
  }
  return { marker, index, stringOpen: open };
}

function lineBody(raw: string, index: number, marker: string): string {
  let rest = raw.slice(index + marker.length);
  if (marker === "//") {
    rest = rest.replace(/^\/+/, "");
  }
  if (marker === "#") {
    rest = rest.replace(/^#+/, "");
  }
  return rest.trim();
}

function blockBody(text: string): string {
  return text.replace(/^\s*\*+/, "").trim();
}

function extract(lines: string[], added: boolean[], syntax: CommentSyntax, language: Language): Extraction {
  const lineComments: LineEntry[] = [];
  const blocks: BlockEntry[] = [];
  const kinds: Array<"code" | "comment" | "blank"> = lines.map(() => "code");
  let stringOpen: string | null = null;
  let openBlock: BlockEntry | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const isAdded = added[i] === true;
    if (openBlock !== null) {
      const end = raw.indexOf(syntax.blockEnd as string);
      const inner = end >= 0 ? raw.slice(0, end) : raw;
      openBlock.bodies.push({ line: i, raw, body: blockBody(inner), added: isAdded });
      if (isAdded) {
        openBlock.added = true;
      }
      if (end >= 0) {
        openBlock.endLine = i;
        blocks.push(openBlock);
        openBlock = null;
        const rest = raw.slice(end + (syntax.blockEnd as string).length);
        kinds[i] = rest.trim().length > 0 ? "code" : "comment";
      } else {
        kinds[i] = "comment";
      }
      continue;
    }
    if (stringOpen === null && raw.trim().length === 0) {
      kinds[i] = "blank";
      continue;
    }
    const scan = scanCode(raw, syntax, language, stringOpen);
    stringOpen = scan.stringOpen;
    if (scan.marker === "line") {
      const before = raw.slice(0, scan.index);
      lineComments.push({
        line: i,
        raw,
        body: lineBody(raw, scan.index, syntax.lineMarker),
        trailing: before.trim(),
        added: isAdded,
      });
      kinds[i] = before.trim().length === 0 ? "comment" : "code";
      continue;
    }
    if (scan.marker === "block" && syntax.blockStart !== null && syntax.blockEnd !== null) {
      const startLength = syntax.blockStart.length;
      const doc = raw.slice(scan.index, scan.index + 3) === "/**" && raw.slice(scan.index, scan.index + 4) !== "/**/";
      const before = raw.slice(0, scan.index).trim();
      const end = raw.indexOf(syntax.blockEnd, scan.index + startLength);
      if (end >= 0) {
        const inner = raw.slice(scan.index + startLength, end);
        const after = raw.slice(end + syntax.blockEnd.length).trim();
        if (doc) {
          blocks.push({
            startLine: i,
            endLine: i,
            raw,
            doc: true,
            added: isAdded,
            bodies: [{ line: i, raw, body: blockBody(inner), added: isAdded }],
          });
        } else {
          lineComments.push({ line: i, raw, body: blockBody(inner), trailing: before, added: isAdded });
        }
        kinds[i] = before.length === 0 && after.length === 0 ? "comment" : "code";
      } else {
        openBlock = {
          startLine: i,
          endLine: i,
          raw,
          doc,
          added: isAdded,
          bodies: [{ line: i, raw, body: blockBody(raw.slice(scan.index + startLength)), added: isAdded }],
        };
        kinds[i] = before.length === 0 ? "comment" : "code";
      }
      continue;
    }
    kinds[i] = "code";
  }
  if (openBlock !== null) {
    blocks.push(openBlock);
  }
  return { lineComments, blocks, kinds };
}

function stripTrailingComment(raw: string, syntax: CommentSyntax, language: Language): string {
  const scan = scanCode(raw, syntax, language, null);
  if (scan.marker !== null && scan.index >= 0) {
    return raw.slice(0, scan.index);
  }
  return raw;
}

function nextCode(
  lines: string[],
  kinds: ReadonlyArray<"code" | "comment" | "blank">,
  from: number,
  syntax: CommentSyntax,
  language: Language,
): string {
  let skipped = 0;
  for (let i = from; i < lines.length && skipped < 5; i += 1) {
    if (kinds[i] === "code") {
      return stripTrailingComment(lines[i], syntax, language);
    }
    skipped += 1;
  }
  return "";
}

function checkLine(comment: LineEntry, code: string, toggles: DetectorToggles): Finding | null {
  const body = comment.body;
  const at = comment.line + 1;
  const text = comment.raw.trim();
  if (toggles.separator && isSeparator(body)) {
    return { rule: "separator", line: at, text, message: "decorative separator comment" };
  }
  if (toggles.changemarker && isChangeMarker(body)) {
    return { rule: "changemarker", line: at, text, message: "change-marker comment describes the edit, not the code" };
  }
  if (toggles.todo && isLooseTodo(body)) {
    return { rule: "todo", line: at, text, message: "TODO/FIXME without an issue reference" };
  }
  if (toggles.narration) {
    if (isGenericNarration(body)) {
      return { rule: "narration", line: at, text, message: "narrating comment adds no information" };
    }
    if (restatesCode(body, code)) {
      return { rule: "narration", line: at, text, message: "comment restates the adjacent code" };
    }
  }
  return null;
}

function docFillerFinding(block: BlockEntry, code: string, options: ScanOptions): Finding | null {
  const content = block.bodies.filter((entry) => entry.body.length > 0);
  if (content.length === 0) {
    return null;
  }
  for (const entry of content) {
    if (isExempt(entry.body, entry.raw, options.allowMarker)) {
      return null;
    }
    const tagMatch = TAG.exec(entry.body);
    if (tagMatch) {
      if (!fillerTag(tagMatch[1], tagMatch[2] ?? "")) {
        return null;
      }
      continue;
    }
    if (entry.body.startsWith("@")) {
      return null;
    }
    if (!fillerSummary(entry.body, code)) {
      return null;
    }
  }
  return {
    rule: "fillerdoc",
    line: block.startLine + 1,
    text: content.map((entry) => entry.body).join(" "),
    message: "doc block only restates names and types",
  };
}

function checkBlock(block: BlockEntry, code: string, options: ScanOptions, findings: Finding[]): void {
  if (block.doc && options.detectors.fillerdoc) {
    const filler = docFillerFinding(block, code, options);
    if (filler !== null) {
      findings.push(filler);
      return;
    }
  }
  for (const entry of block.bodies) {
    if (!entry.added || entry.body.length === 0) {
      continue;
    }
    if (isExempt(entry.body, entry.raw, options.allowMarker)) {
      continue;
    }
    if (entry.body.startsWith("@")) {
      continue;
    }
    const at = entry.line + 1;
    const text = entry.raw.trim();
    if (options.detectors.changemarker && isChangeMarker(entry.body)) {
      findings.push({
        rule: "changemarker",
        line: at,
        text,
        message: "change-marker comment describes the edit, not the code",
      });
      continue;
    }
    if (options.detectors.todo && isLooseTodo(entry.body)) {
      findings.push({ rule: "todo", line: at, text, message: "TODO/FIXME without an issue reference" });
      continue;
    }
    if (options.detectors.narration && isGenericNarration(entry.body)) {
      findings.push({ rule: "narration", line: at, text, message: "narrating comment adds no information" });
    }
  }
}

export function scanAdded(
  lines: string[],
  added: boolean[],
  language: Language | null,
  options: ScanOptions,
): Finding[] {
  if (language === null) {
    return [];
  }
  const syntax = SYNTAX[language];
  if (syntax === undefined) {
    return [];
  }
  const findings: Finding[] = [];
  const { lineComments, blocks, kinds } = extract(lines, added, syntax, language);
  for (const comment of lineComments) {
    if (!comment.added || comment.body.length === 0) {
      continue;
    }
    if (isExempt(comment.body, comment.raw, options.allowMarker)) {
      continue;
    }
    if (comment.body.startsWith("@")) {
      continue;
    }
    const code =
      comment.trailing.length > 0 ? comment.trailing : nextCode(lines, kinds, comment.line + 1, syntax, language);
    const finding = checkLine(comment, code, options.detectors);
    if (finding !== null) {
      findings.push(finding);
    }
  }
  for (const block of blocks) {
    if (!block.added) {
      continue;
    }
    if (options.allowMarker.length > 0 && block.bodies.some((entry) => entry.raw.includes(options.allowMarker))) {
      continue;
    }
    const code = nextCode(lines, kinds, block.endLine + 1, syntax, language);
    checkBlock(block, code, options, findings);
  }
  findings.sort((a, b) => a.line - b.line);
  return findings;
}
