import { LEVELS, levelIndex } from "./scan.ts";
import type { ThinkingLevel } from "./scan.ts";

export type Nudge = "up" | "down" | "none";

const HEAVY =
  /\b(?:refactor\w*|audit\w*|migrat\w*|architect\w*|redesign\w*|re-?write\w*|overhaul\w*|implement\w*|investigat\w*|diagnos\w*|optimi[sz]\w*|benchmark\w*|debug\w*|security|vulnerab\w*|concurren\w*|deadlock\w*|race\s+condition\w*|distributed|end[-\s]to[-\s]end|comprehensive\w*|thorough\w*|entire|throughout|tradeoffs?|algorithm\w*)\b/giu;

const LIGHT =
  /\b(?:typo\w*|renam\w*|bump\w*|tweak\w*|reword\w*|trivial|quick\w*|small|minor|simple|one[-\s]liners?|whitespace|lint\w*|formatting|reformat\w*|changelog|indent\w*)\b/giu;

const FENCE = /```/g;

const BULLET = /^\s*(?:[-*]|\d+[.)])\s+\S/gm;

const WORD = /\s+/;

function countMatches(text: string, regex: RegExp): number {
  regex.lastIndex = 0;
  let count = 0;

  while (regex.exec(text) !== null) {
    count += 1;
  }

  return count;
}

export class Adaptive {
  static classify(text: string): Nudge {
    const trimmed = text.trim();

    if (!trimmed) {

      return "none";
    }

    const chars = trimmed.length;
    const words = trimmed.split(WORD).length;
    let score = 0;

    if (words >= 150 || chars >= 1200) {
      score += 2;
    } else if (words >= 60 || chars >= 500) {
      score += 1;
    } else if (words <= 15 && chars <= 100) {
      score -= 1;
    }

    if (countMatches(trimmed, FENCE) >= 2) {
      score += 1;
    }

    score += Math.min(2, countMatches(trimmed, HEAVY));
    score -= Math.min(2, countMatches(trimmed, LIGHT));

    if (countMatches(trimmed, BULLET) >= 3) {
      score += 1;
    }

    if (score >= 2) {

      return "up";
    }

    if (score <= -2) {

      return "down";
    }

    return "none";
  }

  static nudgeLevel(
    current: ThinkingLevel,
    direction: Nudge,
    min: ThinkingLevel,
    max: ThinkingLevel,
  ): ThinkingLevel | undefined {
    if (direction === "none") {

      return undefined;
    }

    const index = levelIndex(current) + (direction === "up" ? 1 : -1);

    if (index < 0 || index >= LEVELS.length) {

      return undefined;
    }

    const candidate = LEVELS[index];

    if (levelIndex(candidate) < levelIndex(min) || levelIndex(candidate) > levelIndex(max)) {

      return undefined;
    }

    return candidate;
  }
}
