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
  head: string;
}

export interface ThinkingScan {
  text: string;
  level: ThinkingLevel | undefined;
  matched: string[];
}

export interface StripResult {
  text: string;
  count: number;
}

export function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export class Scanner {
  static readonly maxPasses = 64;

  private static escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  static wordRegex(words: readonly string[]): RegExp | undefined {
    const patterns = words
      .map(normalizeKeyword)
      .filter(word => word.length > 0)
      .map(word => word.split(" ").map(part => Scanner.escapeRegex(part)).join("\\s+"));

    if (patterns.length === 0) {

      return undefined;
    }

    return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${patterns.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  }

  static buildMatchers(map: Record<string, unknown>): Matcher[] {
    const matchers: Matcher[] = [];
    const seen = new Set<string>();

    for (const [rawKeyword, rawLevel] of Object.entries(map)) {
      const keyword = normalizeKeyword(rawKeyword);

      if (!keyword || seen.has(keyword) || !isLevel(rawLevel)) {

        continue;
      }

      const regex = Scanner.wordRegex([keyword]);

      if (!regex) {

        continue;
      }

      seen.add(keyword);
      matchers.push({ keyword, level: rawLevel, regex, head: keyword.split(" ")[0] });
    }

    matchers.sort((a, b) => (b.keyword.length - a.keyword.length) || a.keyword.localeCompare(b.keyword));

    return matchers;
  }

  static matchHeads(matchers: readonly Matcher[]): readonly string[] {
    const heads = new Set<string>();

    for (const matcher of matchers) {
      heads.add(matcher.head);
    }

    return [...heads];
  }

  static containsAnyHead(lowerText: string, heads: readonly string[]): boolean {
    for (const head of heads) {

      if (lowerText.includes(head)) {

        return true;
      }
    }

    return false;
  }

  private static removeRange(text: string, start: number, end: number): string {
    let from = start;
    let to = end;

    if (to < text.length && (text[to] === " " || text[to] === "\t")) {
      to += 1;
    } else if (from > 0 && (text[from - 1] === " " || text[from - 1] === "\t")) {
      from -= 1;
    }

    return text.slice(0, from) + text.slice(to);
  }

  static stripMatches(text: string, regex: RegExp): StripResult {
    let current = text;
    let count = 0;

    for (let pass = 0; pass < Scanner.maxPasses; pass += 1) {
      regex.lastIndex = 0;
      const match = regex.exec(current);

      if (!match || match[0].length === 0) {

        break;
      }

      current = Scanner.removeRange(current, match.index, match.index + match[0].length);
      count += 1;
    }

    return { text: current, count };
  }

  static scanThinking(text: string, matchers: readonly Matcher[]): ThinkingScan {
    const empty: ThinkingScan = { text, level: undefined, matched: [] };

    if (matchers.length === 0) {

      return empty;
    }

    const lower = text.toLowerCase();
    const heads = Scanner.matchHeads(matchers);

    if (!Scanner.containsAnyHead(lower, heads)) {

      return empty;
    }

    let current = text;
    let level: ThinkingLevel | undefined;
    const matched: string[] = [];

    for (const matcher of matchers) {
      const result = Scanner.stripMatches(current, matcher.regex);

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
}
