import { createHash } from "node:crypto";
import { type ParsedRule, type RuleError, RuleDiscovery } from "./formats.ts";
import { BudgetFiller, GlobMatcher } from "./matcher.ts";
import type { FormatFlags, RulesSettings } from "./settings.ts";
import type { InjectionMessage } from "./constants.ts";

export { PATH_KEYS, PATH_LIST_KEYS, SEARCH_LOCATIONS } from "./constants.ts";
export type { InjectionMessage } from "./constants.ts";

export class RulesEngine {
  private readonly settings: RulesSettings;
  private readonly discovery: RuleDiscovery;
  private readonly matcher: GlobMatcher;
  private readonly filler: BudgetFiller;
  private trusted = false;
  private rules: ParsedRule[] = [];
  private errors: RuleError[] = [];
  private hashes = new Map<string, string>();
  private lastInjected = new Map<string, string>();
  private lastActive = new Set<string>();
  private rounds = 0;

  constructor(settings: RulesSettings, discovery: RuleDiscovery, matcher: GlobMatcher, filler?: BudgetFiller) {
    this.settings = settings;
    this.discovery = discovery;
    this.matcher = matcher;
    this.filler = filler ?? new BudgetFiller();
  }

  isTrusted(): boolean {
    return this.trusted;
  }

  refresh(cwd: string, trusted: boolean): void {
    this.trusted = trusted;
    this.hashes = new Map<string, string>();

    if (!trusted) {
      this.rules = [];
      this.errors = [];
      return;
    }

    const result = this.discovery.discover(cwd);
    this.rules = result.rules;
    this.errors = result.errors;

    for (const rule of this.rules) {
      this.hashes.set(rule.path, createHash("sha256").update(rule.body, "utf8").digest("hex"));
    }
  }

  resetTurns(): void {
    this.lastInjected = new Map<string, string>();
    this.lastActive = new Set<string>();
    this.rounds = 0;
  }

  buildInjection(touched: string[]): InjectionMessage | undefined {
    const nextInjected = new Map<string, string>();
    const nextActive = new Set<string>();
    const alwaysBlocks: string[] = [];
    const scopedBlocks: string[] = [];

    const alwaysRules = this.rules.filter((rule) => rule.always);
    const scopedRules = this.rules.filter(
      (rule) =>
        !rule.always &&
        rule.scopes.length > 0 &&
        touched.some((path) => rule.scopes.some((glob) => this.matcher.match(glob, path))),
    );

    const context = { hashes: this.hashes, lastInjected: this.lastInjected, nextInjected, nextActive };

    this.filler.fill(alwaysRules, this.settings.alwaysBudget, alwaysBlocks, context);
    this.filler.fill(scopedRules, this.settings.scopedBudget, scopedBlocks, context);

    this.lastInjected = nextInjected;
    this.lastActive = nextActive;
    this.rounds += 1;

    const blocks = [...alwaysBlocks, ...scopedBlocks];

    if (blocks.length === 0) {
      return undefined;
    }

    const content = `Project rules in effect. Each block names its source file; scoped rules apply when working on their listed paths.\n\n${blocks.join("\n\n")}`;

    return { customType: "rulesinjection", content, display: false };
  }

  report(): string[] {
    const lines: string[] = [];
    const errorSuffix =
      this.errors.length > 0 ? `, ${this.errors.length} parse error${this.errors.length === 1 ? "" : "s"}` : "";
    const activity = this.rounds > 0 ? `${this.lastActive.size} active last turn` : "no turns yet";

    lines.push(`Rules: ${this.rules.length} discovered, ${activity}${errorSuffix}`);

    for (const rule of this.rules) {
      const status = this.rounds === 0 ? "pending" : this.lastActive.has(rule.path) ? "active" : "inactive";
      const scope = rule.always ? "always" : rule.scopes.length > 0 ? rule.scopes.join(", ") : "manual (no scope)";
      lines.push(`  [${status}] ${rule.source} ${rule.relPath} - ${scope}`);
    }

    if (this.errors.length > 0) {
      lines.push("Parse errors:");

      for (const error of this.errors) {
        lines.push(`  ${error.source} ${error.relPath}: ${error.message}`);
      }
    }

    const disabled = (Object.keys(this.settings.formats) as Array<keyof FormatFlags>).filter(
      (key) => !this.settings.formats[key],
    );

    if (disabled.length > 0) {
      lines.push(`Disabled formats: ${disabled.join(", ")}`);
    }

    return lines;
  }

  hasRulesOrErrors(): boolean {
    return this.rules.length > 0 || this.errors.length > 0;
  }
}
