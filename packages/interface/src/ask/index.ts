import type { AskConfig } from "./config.ts";
import { Args } from "./args.ts";
import { Displays, Text } from "./display.ts";
import { Results } from "./results.ts";
import {
  MULTI_ATTEMPTS,
  SINGLE_ATTEMPTS,
  type AskArgs,
  type AskOption,
  type AskResult,
  type Reply,
  type Step,
  type ValidatedArgs,
} from "./types.ts";

export { Args, AskValidationError } from "./args.ts";
export { Displays, Text } from "./display.ts";
export { Results } from "./results.ts";
export { Config, DEFAULTS } from "./config.ts";
export type { AskConfig } from "./config.ts";
export {
  MULTI_ATTEMPTS,
  SINGLE_ATTEMPTS,
  MAX_TIMEOUT_SEC,
  TIMEOUT_EPSILON_MS,
} from "./types.ts";
export type {
  AskArgs,
  AskDetails,
  AskOption,
  AskResult,
  DisplayTarget,
  InputPrompt,
  Prompt,
  Reply,
  SelectPrompt,
  Step,
  ToolText,
  ValidatedArgs,
} from "./types.ts";

export class Engine {
  private readonly question: string;
  private readonly options: AskOption[];
  private readonly multi: boolean;
  private readonly allowOther: boolean;
  private readonly descriptions = new Map<string, string>();
  private readonly chosen = new Set<number>();
  private otherText: string | undefined;
  private attempt = 0;
  private current: Displays | undefined;
  private awaitingOther = false;

  static create(args: AskArgs, config: AskConfig): Engine {
    const validated = Args.validate(args);

    return new Engine(validated, args, config);
  }

  private constructor(
    validated: ValidatedArgs,
    private readonly args: AskArgs,
    private readonly config: AskConfig,
  ) {
    this.question = validated.question;
    this.options = validated.options;
    this.multi = args.multi === true;
    this.allowOther = args.allowOther !== false;

    for (const option of this.options) {
      if (option.description !== undefined && !this.descriptions.has(option.label)) {
        this.descriptions.set(option.label, option.description);
      }
    }
  }

  get hasTimeout(): boolean {
    return Args.resolveTimeoutMs(this.args.timeoutSec, this.config) > 0;
  }

  timeoutMs(): number {
    return Args.resolveTimeoutMs(this.args.timeoutSec, this.config);
  }

  noUiResult(): AskResult {
    return Results.noUi(this.question, this.options);
  }

  start(): Step {
    if (this.multi) {
      return this.multiSelect();
    }

    return this.singleSelect();
  }

  advance(reply: Reply): Step {
    if (this.awaitingOther) {
      return this.afterInput(reply);
    }

    return this.afterSelect(reply);
  }

  private chosenLabels(): string[] {
    return [...this.chosen].sort((a, b) => a - b).map((index) => this.options[index].label);
  }

  private singleSelect(): Step {
    const displays = new Displays();

    this.options.forEach((option, index) => {
      displays.add(Text.optionDisplay(option), { kind: "option", index });
    });

    if (this.allowOther) {
      displays.add(this.config.otherLabel, { kind: "other" });
    }

    this.current = displays;
    this.awaitingOther = false;

    return { kind: "prompt", prompt: { kind: "select", title: this.question, displays: displays.entries } };
  }

  private multiSelect(): Step {
    const displays = new Displays();

    this.options.forEach((option, index) => {
      const marker = this.chosen.has(index) ? "[x]" : "[ ]";

      displays.add(`${marker} ${Text.optionDisplay(option)}`, { kind: "option", index });
    });

    if (this.allowOther) {
      const base =
        this.otherText !== undefined
          ? `[x] ${this.config.otherLabel}: ${Text.clip(this.otherText, Text.lineWidth())}`
          : `[ ] ${this.config.otherLabel}`;

      displays.add(base, { kind: "other" });
    }

    const count = this.chosen.size + (this.otherText !== undefined ? 1 : 0);
    const doneBase =
      count > 0
        ? `${this.config.doneLabel} — submit ${count} selected`
        : `${this.config.doneLabel} — submit (none selected)`;

    displays.add(doneBase, { kind: "done" });

    this.current = displays;
    this.awaitingOther = false;

    return {
      kind: "prompt",
      prompt: { kind: "select", title: `${this.question} (multi-select)`, displays: displays.entries },
    };
  }

  private afterSelect(reply: Reply): Step {
    if (this.multi) {
      return this.afterMultiSelect(reply);
    }

    return this.afterSingleSelect(reply);
  }

  private afterSingleSelect(reply: Reply): Step {
    if (reply.kind === "empty") {
      if (reply.aborted) {
        throw Results.abortError();
      }

      return { kind: "result", result: Results.noAnswer(reply.timedOut ? "timeout" : "dismissed", [], undefined) };
    }

    const target = this.current?.target(reply.value);

    if (target === undefined) {
      return { kind: "result", result: Results.noAnswer("dismissed", [], undefined) };
    }

    if (target.kind === "option") {
      return { kind: "result", result: Results.answered([this.options[target.index].label], undefined, this.descriptions) };
    }

    this.awaitingOther = true;

    return { kind: "prompt", prompt: { kind: "input", title: this.question, placeholder: "Type your answer" } };
  }

  private afterMultiSelect(reply: Reply): Step {
    if (reply.kind === "empty") {
      if (reply.aborted) {
        throw Results.abortError();
      }

      return {
        kind: "result",
        result: Results.noAnswer(reply.timedOut ? "timeout" : "dismissed", this.chosenLabels(), this.otherText),
      };
    }

    const target = this.current?.target(reply.value);

    if (target === undefined) {
      return { kind: "result", result: Results.noAnswer("dismissed", this.chosenLabels(), this.otherText) };
    }

    if (target.kind === "done") {
      return { kind: "result", result: Results.answered(this.chosenLabels(), this.otherText, this.descriptions) };
    }

    if (target.kind === "option") {
      if (this.chosen.has(target.index)) {
        this.chosen.delete(target.index);
      } else {
        this.chosen.add(target.index);
      }

      return this.nextSelect();
    }

    if (this.otherText !== undefined) {
      this.otherText = undefined;

      return this.nextSelect();
    }

    this.awaitingOther = true;

    return {
      kind: "prompt",
      prompt: { kind: "input", title: `${this.question} (multi-select)`, placeholder: "Type your answer" },
    };
  }

  private afterInput(reply: Reply): Step {
    if (this.multi) {
      return this.afterMultiInput(reply);
    }

    return this.afterSingleInput(reply);
  }

  private afterSingleInput(reply: Reply): Step {
    if (reply.kind === "empty") {
      if (reply.aborted) {
        throw Results.abortError();
      }

      if (reply.timedOut) {
        return { kind: "result", result: Results.noAnswer("timeout", [], undefined) };
      }

      return this.nextSelect();
    }

    const typed = reply.value.trim();

    if (typed !== "") {
      return { kind: "result", result: Results.answered([], typed, this.descriptions) };
    }

    return this.nextSelect();
  }

  private afterMultiInput(reply: Reply): Step {
    if (reply.kind === "empty") {
      if (reply.aborted) {
        throw Results.abortError();
      }

      if (reply.timedOut) {
        return { kind: "result", result: Results.noAnswer("timeout", this.chosenLabels(), undefined) };
      }

      return this.nextSelect();
    }

    const typed = reply.value.trim();

    if (typed !== "") {
      this.otherText = typed;
    }

    return this.nextSelect();
  }

  private nextSelect(): Step {
    this.attempt += 1;

    if (!this.multi) {
      if (this.attempt >= SINGLE_ATTEMPTS) {
        return { kind: "result", result: Results.noAnswer("dismissed", [], undefined) };
      }

      return this.singleSelect();
    }

    if (this.attempt >= MULTI_ATTEMPTS) {
      return { kind: "result", result: Results.answered(this.chosenLabels(), this.otherText, this.descriptions) };
    }

    return this.multiSelect();
  }
}
