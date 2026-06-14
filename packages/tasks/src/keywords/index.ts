import { isLevel } from "./scan.ts";
import type { Matcher, ThinkingLevel } from "./scan.ts";
import { Scanner } from "./scan.ts";
import { Adaptive } from "./adaptive.ts";
import { Config } from "./config.ts";
import type { KeywordsConfig, SummaryState } from "./config.ts";

export interface ThinkingPort {
  current(): ThinkingLevel | undefined;
  apply(target: ThinkingLevel): boolean;
  taskAvailable(): boolean;
}

export interface ContinueResult {
  action: "continue";
}

export interface TransformResult {
  action: "transform";
  text: string;
}

export type InputResult = ContinueResult | TransformResult;

const CONTINUE: ContinueResult = { action: "continue" };

const ORCHESTRATE_WORDS = ["orchestrate"];

const ULTRAWORK_WORDS = ["ulw", "ultrawork"];

export class KeywordsEngine {
  static readonly selfQueueCap = 4;

  private readonly matchers: Matcher[];

  private readonly orchestrateRegex: RegExp | undefined;

  private readonly ultraworkRegex: RegExp | undefined;

  private readonly orchestrateHeads: readonly string[];

  private readonly ultraworkHeads: readonly string[];

  private readonly selfQueue: ThinkingLevel[] = [];

  private adaptiveEnabled: boolean;

  private baseline: ThinkingLevel | undefined;

  private pendingRestore: ThinkingLevel | undefined;

  private userSelected = false;

  constructor(
    private readonly config: Config,
    private readonly port: ThinkingPort,
  ) {
    this.matchers = Scanner.buildMatchers(config.values.keywords);
    this.orchestrateRegex = Scanner.wordRegex(ORCHESTRATE_WORDS);
    this.ultraworkRegex = Scanner.wordRegex(ULTRAWORK_WORDS);
    this.orchestrateHeads = ORCHESTRATE_WORDS;
    this.ultraworkHeads = ULTRAWORK_WORDS;
    this.adaptiveEnabled = config.values.adaptive;
  }

  private get settings(): KeywordsConfig {
    return this.config.values;
  }

  private applyLevel(target: ThinkingLevel): boolean {
    if (this.selfQueue.length >= KeywordsEngine.selfQueueCap) {
      this.selfQueue.shift();
    }

    this.selfQueue.push(target);
    const applied = this.port.apply(target);

    if (!applied) {
      const index = this.selfQueue.lastIndexOf(target);

      if (index >= 0) {
        this.selfQueue.splice(index, 1);
      }
    }

    return applied;
  }

  private recordRestore(before: ThinkingLevel | undefined, applied: boolean): void {
    if (applied && this.settings.restore && before !== undefined && this.pendingRestore === undefined) {
      this.pendingRestore = before;
    }
  }

  private moveToLevel(target: ThinkingLevel): void {
    const before = this.port.current();

    if (this.baseline === undefined) {
      this.baseline = before;
    }

    if (before !== target) {
      const applied = this.applyLevel(target);
      this.recordRestore(before, applied);
    }
  }

  onSessionStart(): void {
    this.baseline = this.port.current();
    this.pendingRestore = undefined;
    this.userSelected = false;
    this.selfQueue.length = 0;
  }

  onThinkingLevelSelect(level: unknown): void {
    const selected = isLevel(level) ? level : undefined;

    if (selected && this.selfQueue.length > 0 && this.selfQueue[0] === selected) {
      this.selfQueue.shift();

      return;
    }

    this.selfQueue.length = 0;

    if (selected) {
      this.baseline = selected;
      this.userSelected = true;
      this.pendingRestore = undefined;
    }
  }

  private isInteractivePrompt(text: string, source: unknown): boolean {
    if (source !== "interactive") {

      return false;
    }

    if (!text.trim() || /^\s*\/\S/.test(text)) {

      return false;
    }

    return true;
  }

  private stripWord(text: string, regex: RegExp | undefined, heads: readonly string[], lower: string): { text: string; matched: boolean } {
    if (!regex || !Scanner.containsAnyHead(lower, heads)) {

      return { text, matched: false };
    }

    const result = Scanner.stripMatches(text, regex);

    return result.count > 0 ? { text: result.text, matched: true } : { text, matched: false };
  }

  processInput(rawText: unknown, source: unknown): InputResult {
    const original = typeof rawText === "string" ? rawText : "";

    if (!this.isInteractivePrompt(original, source)) {

      return CONTINUE;
    }

    const explicit = this.userSelected;
    this.userSelected = false;

    const lower = original.toLowerCase();
    const scan = Scanner.scanThinking(original, this.matchers);
    let text = scan.text;
    const notes: string[] = [];

    if (scan.level !== undefined) {
      this.moveToLevel(scan.level);
      notes.push(this.config.thinkingNote(scan.level, scan.matched));
    }

    if (this.settings.orchestrate) {
      const result = this.stripWord(text, this.orchestrateRegex, this.orchestrateHeads, lower);

      if (result.matched) {
        text = result.text;
        notes.push(this.config.orchestrateNote(this.port.taskAvailable()));
      }
    }

    if (this.settings.ultrawork) {
      const result = this.stripWord(text, this.ultraworkRegex, this.ultraworkHeads, lower);

      if (result.matched) {
        text = result.text;
        notes.push(this.config.ultraworkNote(this.settings.metMarker));
      }
    }

    if (notes.length === 0) {
      this.applyAdaptive(original, explicit);

      return CONTINUE;
    }

    const body = text.trim();

    return { action: "transform", text: body ? `${body}\n\n${notes.join("\n")}` : notes.join("\n") };
  }

  private applyAdaptive(original: string, explicit: boolean): void {
    if (!this.adaptiveEnabled || explicit) {

      return;
    }

    const from = this.baseline ?? this.port.current();
    const direction = Adaptive.classify(original);

    if (from === undefined || direction === "none") {

      return;
    }

    const target = Adaptive.nudgeLevel(from, direction, this.settings.adaptiveMin, this.settings.adaptiveMax);
    const before = this.port.current();

    if (target !== undefined && target !== before) {
      const applied = this.applyLevel(target);
      this.recordRestore(before, applied);
    }
  }

  onAgentEnd(): void {
    if (this.pendingRestore === undefined) {

      return;
    }

    const target = this.pendingRestore;
    this.pendingRestore = undefined;

    if (!this.settings.restore || this.port.current() === target) {

      return;
    }

    this.applyLevel(target);
  }

  toggleAdaptive(input: string): { adaptive: boolean; message: string } {
    this.adaptiveEnabled = input === "adaptive" ? !this.adaptiveEnabled : input.endsWith(" on");
    const message = `Adaptive thinking ${this.adaptiveEnabled ? "enabled" : "disabled"} (bounds ${this.settings.adaptiveMin}-${this.settings.adaptiveMax}). Persist via the keywords.adaptive key in suite.json.`;

    return { adaptive: this.adaptiveEnabled, message };
  }

  command(args: string): { kind: "info" | "error"; message: string } {
    const input = (args ?? "").trim().toLowerCase().replace(/\s+/g, " ");

    if (input === "adaptive" || input === "adaptive on" || input === "adaptive off") {

      return { kind: "info", message: this.toggleAdaptive(input).message };
    }

    if (input) {

      return {
        kind: "error",
        message: "Usage: /keywords to list state, /keywords adaptive [on|off] to toggle adaptive thinking.",
      };
    }

    return { kind: "info", message: this.summary() };
  }

  summary(): string {
    const state: SummaryState = {
      matchers: this.matchers,
      adaptive: this.adaptiveEnabled,
      current: this.port.current(),
      baseline: this.baseline,
    };

    return this.config.summary(state);
  }

  completions(prefix: string): { value: string; label: string }[] | null {
    const options = ["adaptive", "adaptive on", "adaptive off"];
    const filtered = options.filter(option => option.startsWith(prefix.toLowerCase()));

    return filtered.length > 0 ? filtered.map(option => ({ value: option, label: option })) : null;
  }
}
