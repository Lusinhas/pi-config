import { basename } from "node:path";
import type { IdeInfo } from "./index.ts";

export class Format {
  static #trimmed(value: number): string {
    const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);

    return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
  }

  static tokens(count: number): string {
    const n = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;

    if (n < 1000) {
      return String(n);
    }

    if (n < 1000000) {
      return `${Format.#trimmed(n / 1000)}k`;
    }

    if (n < 1000000000) {
      return `${Format.#trimmed(n / 1000000)}M`;
    }

    return `${Format.#trimmed(n / 1000000000)}B`;
  }

  static cost(cost: number): string {
    if (!Number.isFinite(cost) || cost < 0) {
      return "0.00";
    }

    if (cost >= 100) {
      return cost.toFixed(0);
    }

    if (cost >= 10) {
      return cost.toFixed(1);
    }

    return cost.toFixed(2);
  }

  static ide(ide: IdeInfo): string {
    const indicator = ide.connected === true ? "●" : ide.connected === false ? "○" : "◌";
    const subject = ide.activeFile
      ? ide.selectedLines > 0
        ? `✂ ${ide.selectedLines}L`
        : basename(ide.activeFile)
      : ide.connected === false
        ? "disconnected"
        : "";

    return subject ? `IDE ${indicator} ${subject}` : `IDE ${indicator}`;
  }
}

export function formatTokens(count: number): string {
  return Format.tokens(count);
}

export function formatCost(cost: number): string {
  return Format.cost(cost);
}
