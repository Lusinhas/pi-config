export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function isLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export function levelIndex(level: ThinkingLevel): number {
  return LEVELS.indexOf(level);
}

export interface Matcher {
  keyword: string;
  level: ThinkingLevel;
  regex: RegExp;
}

export interface ThinkingScan {
  text: string;
  level: ThinkingLevel | undefined;
  matched: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function wordRegex(words: readonly string[]): RegExp | undefined {
  const patterns = words
    .map(word => word.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(word => word.length > 0)
    .map(word => word.split(" ").map(escapeRegex).join("\\s+"));
  if (patterns.length === 0) {
    return undefined;
  }
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${patterns.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

export function buildMatchers(map: Record<string, unknown>): Matcher[] {
  const matchers: Matcher[] = [];
  const seen = new Set<string>();
  for (const [rawKeyword, rawLevel] of Object.entries(map)) {
    const keyword = rawKeyword.trim().toLowerCase().replace(/\s+/g, " ");
    if (!keyword || seen.has(keyword) || !isLevel(rawLevel)) {
      continue;
    }
    const regex = wordRegex([keyword]);
    if (!regex) {
      continue;
    }
    seen.add(keyword);
    matchers.push({ keyword, level: rawLevel, regex });
  }
  matchers.sort((a, b) => b.keyword.length - a.keyword.length);
  return matchers;
}

function removeRange(text: string, start: number, end: number): string {
  let from = start;
  let to = end;
  if (to < text.length && (text[to] === " " || text[to] === "\t")) {
    to += 1;
  } else if (from > 0 && (text[from - 1] === " " || text[from - 1] === "\t")) {
    from -= 1;
  }
  return text.slice(0, from) + text.slice(to);
}

export function stripMatches(text: string, regex: RegExp): { text: string; count: number } {
  let current = text;
  let count = 0;
  for (let pass = 0; pass < 64; pass += 1) {
    regex.lastIndex = 0;
    const match = regex.exec(current);
    if (!match || match[0].length === 0) {
      break;
    }
    current = removeRange(current, match.index, match.index + match[0].length);
    count += 1;
  }
  return { text: current, count };
}

export function scanThinking(text: string, matchers: readonly Matcher[]): ThinkingScan {
  let current = text;
  let level: ThinkingLevel | undefined;
  const matched: string[] = [];
  for (const matcher of matchers) {
    const result = stripMatches(current, matcher.regex);
    if (result.count === 0) {
      continue;
    }
    current = result.text;
    matched.push(matcher.keyword);
    if (level === undefined || levelIndex(matcher.level) > levelIndex(level)) {
      level = matcher.level;
    }
  }
  return { text: current, level, matched };
}
