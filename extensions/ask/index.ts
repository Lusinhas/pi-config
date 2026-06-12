import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AskConfig {
  defaultTimeoutSec: number;
  otherLabel: string;
  doneLabel: string;
}

interface AskOption {
  label: string;
  description?: string;
}

interface AskArgs {
  question: string;
  options: AskOption[];
  multi?: boolean;
  allowOther?: boolean;
  timeoutSec?: number;
}

interface AskDetails {
  answered: boolean;
  selected: string[];
  other?: string;
  reason?: "timeout" | "dismissed" | "noui";
}

interface ToolText {
  type: "text";
  text: string;
}

interface AskResult {
  content: ToolText[];
  details: AskDetails;
}

type DisplayTarget = { kind: "option"; index: number } | { kind: "other" } | { kind: "done" };

const DEFAULTS: AskConfig = {
  defaultTimeoutSec: 0,
  otherLabel: "Other (type a custom answer)",
  doneLabel: "Done",
};

const TIMEOUT_EPSILON_MS = 250;
const MAX_TIMEOUT_SEC = 86400;
const SINGLE_ATTEMPTS = 20;
const MULTI_ATTEMPTS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadConfig(): AskConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "piconfig.json"));
  if (globalConfig && isRecord(globalConfig.ask)) merged = deepMerge(merged, globalConfig.ask);
  const projectConfig = readJson(join(process.cwd(), ".pi", "piconfig.json"));
  if (projectConfig && isRecord(projectConfig.ask)) merged = deepMerge(merged, projectConfig.ask);
  return {
    defaultTimeoutSec:
      typeof merged.defaultTimeoutSec === "number" && Number.isFinite(merged.defaultTimeoutSec) && merged.defaultTimeoutSec >= 0
        ? merged.defaultTimeoutSec
        : DEFAULTS.defaultTimeoutSec,
    otherLabel:
      typeof merged.otherLabel === "string" && merged.otherLabel.trim() !== "" ? merged.otherLabel.trim() : DEFAULTS.otherLabel,
    doneLabel:
      typeof merged.doneLabel === "string" && merged.doneLabel.trim() !== "" ? merged.doneLabel.trim() : DEFAULTS.doneLabel,
  };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

function uniqueDisplay(used: Set<string>, base: string): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let counter = 2;
  let candidate = `${base} (${counter})`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${base} (${counter})`;
  }
  used.add(candidate);
  return candidate;
}

function optionDisplay(option: AskOption): string {
  const label = clip(option.label, 60);
  const description = option.description !== undefined ? clip(option.description, 80) : "";
  return description !== "" ? `${label} — ${description}` : label;
}

function validateArgs(params: AskArgs): { question: string; options: AskOption[] } {
  if (typeof params.question !== "string" || params.question.trim() === "") {
    throw new Error("ask requires a non-empty question");
  }
  if (!Array.isArray(params.options) || params.options.length < 1 || params.options.length > 8) {
    throw new Error("ask requires between 1 and 8 options");
  }
  const options: AskOption[] = params.options.map((option, index) => {
    if (!isRecord(option) || typeof option.label !== "string" || option.label.trim() === "") {
      throw new Error(`ask option ${index + 1} requires a non-empty label`);
    }
    const description =
      typeof option.description === "string" && option.description.trim() !== "" ? option.description.trim() : undefined;
    return description !== undefined ? { label: option.label.trim(), description } : { label: option.label.trim() };
  });
  return { question: params.question.trim(), options };
}

function resolveTimeoutMs(timeoutSec: number | undefined, config: AskConfig): number {
  const fromArgs =
    typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec >= 0 ? timeoutSec : undefined;
  const seconds = fromArgs ?? config.defaultTimeoutSec;
  return seconds > 0 ? Math.round(Math.min(seconds, MAX_TIMEOUT_SEC) * 1000) : 0;
}

function noUiResult(question: string, options: AskOption[]): AskResult {
  const listing = options
    .map((option, index) => `${index + 1}. ${option.label}${option.description !== undefined ? ` — ${option.description}` : ""}`)
    .join("\n");
  const text = [
    "No interactive UI is available in this mode, so the user could not be asked.",
    "Proceed with your best judgment: choose the most reasonable option yourself and clearly state that assumption in your reply.",
    `Question: ${question}`,
    "Options:",
    listing,
  ].join("\n");
  return { content: [{ type: "text", text }], details: { answered: false, selected: [], reason: "noui" } };
}

function noAnswerResult(reason: "timeout" | "dismissed", selected: string[], other: string | undefined): AskResult {
  const cause =
    reason === "timeout"
      ? "No answer (timeout): the user did not respond before the dialog expired."
      : "No answer (dismissed): the user closed the dialog without confirming a choice.";
  const lines = [cause];
  if (selected.length > 0) {
    lines.push(`Options toggled before the dialog closed, but never submitted: ${selected.join("; ")}.`);
  }
  if (other !== undefined) {
    lines.push(`Unsubmitted custom answer: "${other}".`);
  }
  lines.push("Proceed with your best judgment and clearly state the assumption you make.");
  const details: AskDetails = { answered: false, selected, reason };
  if (other !== undefined) details.other = other;
  return { content: [{ type: "text", text: lines.join("\n") }], details };
}

function answeredResult(labels: string[], other: string | undefined, descriptions: Map<string, string>): AskResult {
  const parts: string[] = [];
  if (labels.length > 0) {
    const rendered = labels.map((label) => {
      const description = descriptions.get(label);
      return description !== undefined ? `${label} (${description})` : label;
    });
    parts.push(`User selected: ${rendered.join("; ")}`);
  }
  if (other !== undefined) {
    parts.push(`Custom answer: "${other}"`);
  }
  if (parts.length === 0) {
    parts.push("User submitted without selecting any option.");
  }
  const details: AskDetails = { answered: true, selected: labels };
  if (other !== undefined) details.other = other;
  return { content: [{ type: "text", text: parts.join("\n") }], details };
}

const askParameters = Type.Object({
  question: Type.String({ description: "the question to ask the user" }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: "short answer label shown to the user" }),
      description: Type.Optional(Type.String({ description: "optional clarification shown next to the label" })),
    }),
    { minItems: 1, maxItems: 8, description: "1 to 8 answer choices" },
  ),
  multi: Type.Optional(Type.Boolean({ description: "allow selecting multiple options; defaults to false" })),
  allowOther: Type.Optional(
    Type.Boolean({ description: "offer a free-form Other answer in addition to the options; defaults to true" }),
  ),
  timeoutSec: Type.Optional(
    Type.Number({ description: "seconds to wait for an answer before giving up; 0 means wait indefinitely; omitted uses the configured default" }),
  ),
});

export default function ask(pi: ExtensionAPI): void {
  const config = loadConfig();

  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Ask the user a structured question with 1-8 answer options. Use multi: true to let the user pick several options, allowOther (default true) to also offer a free-form answer, and timeoutSec to bound the wait. Returns the chosen label(s) plus any free text. If no UI is available or the user does not answer, the result says so: proceed with your best judgment and explicitly state the assumptions you made.",
    parameters: askParameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AskResult> {
      const args = params as AskArgs;
      const { question, options } = validateArgs(args);
      const multi = args.multi === true;
      const allowOther = args.allowOther !== false;
      const timeoutMs = resolveTimeoutMs(args.timeoutSec, config);

      if (!ctx.hasUI) {
        return noUiResult(question, options);
      }

      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
      const dialogOpts = (): { signal?: AbortSignal; timeout?: number } => {
        const opts: { signal?: AbortSignal; timeout?: number } = {};
        if (signal !== undefined) opts.signal = signal;
        if (deadline !== undefined) opts.timeout = Math.max(deadline - Date.now(), 1);
        return opts;
      };
      const assertNotAborted = (): void => {
        if (signal?.aborted === true) {
          throw new Error("ask was cancelled before the user answered");
        }
      };
      const timedOut = (): boolean => deadline !== undefined && Date.now() >= deadline - TIMEOUT_EPSILON_MS;
      const descriptions = new Map<string, string>();
      for (const option of options) {
        if (option.description !== undefined && !descriptions.has(option.label)) {
          descriptions.set(option.label, option.description);
        }
      }

      if (!multi) {
        const title = clip(question, 120);
        for (let attempt = 0; attempt < SINGLE_ATTEMPTS; attempt += 1) {
          const used = new Set<string>();
          const map = new Map<string, DisplayTarget>();
          const displays: string[] = [];
          options.forEach((option, index) => {
            const display = uniqueDisplay(used, optionDisplay(option));
            displays.push(display);
            map.set(display, { kind: "option", index });
          });
          if (allowOther) {
            const display = uniqueDisplay(used, config.otherLabel);
            displays.push(display);
            map.set(display, { kind: "other" });
          }
          const picked = await ctx.ui.select(title, displays, dialogOpts());
          if (picked === undefined) {
            assertNotAborted();
            return noAnswerResult(timedOut() ? "timeout" : "dismissed", [], undefined);
          }
          const target = map.get(picked);
          if (target === undefined) {
            return noAnswerResult("dismissed", [], undefined);
          }
          if (target.kind === "option") {
            return answeredResult([options[target.index].label], undefined, descriptions);
          }
          const typed = await ctx.ui.input(title, "Type your answer", dialogOpts());
          if (typed === undefined) {
            assertNotAborted();
            if (timedOut()) {
              return noAnswerResult("timeout", [], undefined);
            }
            continue;
          }
          if (typed.trim() !== "") {
            return answeredResult([], typed.trim(), descriptions);
          }
        }
        return noAnswerResult("dismissed", [], undefined);
      }

      const title = `${clip(question, 100)} (multi-select)`;
      const chosen = new Set<number>();
      let otherText: string | undefined;
      const chosenLabels = (): string[] =>
        [...chosen].sort((a, b) => a - b).map((index) => options[index].label);
      for (let attempt = 0; attempt < MULTI_ATTEMPTS; attempt += 1) {
        const used = new Set<string>();
        const map = new Map<string, DisplayTarget>();
        const displays: string[] = [];
        options.forEach((option, index) => {
          const marker = chosen.has(index) ? "[x]" : "[ ]";
          const display = uniqueDisplay(used, `${marker} ${optionDisplay(option)}`);
          displays.push(display);
          map.set(display, { kind: "option", index });
        });
        if (allowOther) {
          const base =
            otherText !== undefined ? `[x] ${config.otherLabel}: ${clip(otherText, 50)}` : `[ ] ${config.otherLabel}`;
          const display = uniqueDisplay(used, base);
          displays.push(display);
          map.set(display, { kind: "other" });
        }
        const count = chosen.size + (otherText !== undefined ? 1 : 0);
        const doneBase =
          count > 0 ? `${config.doneLabel} — submit ${count} selected` : `${config.doneLabel} — submit (none selected)`;
        const doneDisplay = uniqueDisplay(used, doneBase);
        displays.push(doneDisplay);
        map.set(doneDisplay, { kind: "done" });

        const picked = await ctx.ui.select(title, displays, dialogOpts());
        if (picked === undefined) {
          assertNotAborted();
          return noAnswerResult(timedOut() ? "timeout" : "dismissed", chosenLabels(), otherText);
        }
        const target = map.get(picked);
        if (target === undefined) {
          return noAnswerResult("dismissed", chosenLabels(), otherText);
        }
        if (target.kind === "done") {
          break;
        }
        if (target.kind === "option") {
          if (chosen.has(target.index)) {
            chosen.delete(target.index);
          } else {
            chosen.add(target.index);
          }
          continue;
        }
        if (otherText !== undefined) {
          otherText = undefined;
          continue;
        }
        const typed = await ctx.ui.input(title, "Type your answer", dialogOpts());
        if (typed === undefined) {
          assertNotAborted();
          if (timedOut()) {
            return noAnswerResult("timeout", chosenLabels(), undefined);
          }
          continue;
        }
        if (typed.trim() !== "") {
          otherText = typed.trim();
        }
      }
      return answeredResult(chosenLabels(), otherText, descriptions);
    },
    renderCall(args: unknown, theme: Theme): Component {
      const call = args as Partial<AskArgs>;
      const count = Array.isArray(call.options) ? call.options.length : 0;
      const flags: string[] = [`${count} option${count === 1 ? "" : "s"}`];
      if (call.multi === true) flags.push("multi");
      if (call.allowOther === false) flags.push("no other");
      if (typeof call.timeoutSec === "number" && Number.isFinite(call.timeoutSec) && call.timeoutSec > 0) {
        flags.push(`${Math.round(call.timeoutSec)}s`);
      }
      const questionText = typeof call.question === "string" ? clip(call.question, 80) : "";
      const segments = [theme.fg("toolTitle", theme.bold("ask"))];
      if (questionText !== "") segments.push(theme.fg("text", questionText));
      segments.push(theme.fg("muted", `(${flags.join(", ")})`));
      return new Text(segments.join(" "), 0, 0);
    },
  });
}
