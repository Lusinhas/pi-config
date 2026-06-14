import type { Mode } from "./modes.ts";
import type { Evaluation, RuleEngine } from "./index.ts";
import type { SessionRule } from "./text.ts";

export interface Approval {
  tool: string;
  argument: string;
}

export interface BlockResult {
  block: true;
  reason: string;
}

export type DecisionResult = BlockResult | undefined;

export const ALLOW_ONCE = "allow once";
export const ALLOW_ALWAYS = "always allow this session";
export const ALLOW_AUTO = "allow + switch to auto mode";
export const DENY_CHOICE = "deny";

export interface AllowEntry {
  kind: "allow";
  rule: SessionRule;
}

export interface ModeEntry {
  kind: "mode";
  mode: Mode;
}

export interface ClearEntry {
  kind: "clear";
}

export type PermissionsEntry = AllowEntry | ModeEntry | ClearEntry;

export interface AskPlan {
  approvalKey: Approval;
  header: string;
  footer: string[];
  choices: string[];
  preview: string;
}

export interface ChoiceOutcome {
  result: DecisionResult;
  approvals: Approval[];
  entries: PermissionsEntry[];
  rules: SessionRule[];
  switchToAuto: boolean;
}

export class AskPlanBuilder {
  constructor(private readonly previewLength: number) {}

  static truncatePreview(text: string, maxLength: number): string {
    const flattened = text.replace(/\s+/g, " ").trim();

    if (flattened.length <= maxLength) {
      return flattened;
    }

    return `${flattened.slice(0, Math.max(1, maxLength - 1))}…`;
  }

  buildAskPlan(
    toolName: string,
    argument: string,
    evaluation: Evaluation,
    judgeNote: string,
    origin: string,
    mode: Mode,
  ): AskPlan {
    const header =
      origin === ""
        ? `permissions: allow ${toolName}?`
        : `permissions: allow ${toolName} from subagent "${origin}"?`;
    const footer = [`matched: ${evaluation.reason}`, judgeNote].filter((line) => line.length > 0);
    const choices = mode === "ask" ? [ALLOW_ONCE, DENY_CHOICE] : [ALLOW_ONCE, ALLOW_ALWAYS, DENY_CHOICE];

    if (origin !== "" && mode !== "auto") {
      choices.splice(Math.max(1, choices.length - 1), 0, ALLOW_AUTO);
    }

    return {
      approvalKey: { tool: toolName, argument },
      header,
      footer,
      choices,
      preview: AskPlanBuilder.truncatePreview(argument, this.previewLength),
    };
  }

  resolveChoice(
    toolName: string,
    plan: AskPlan,
    evaluation: Evaluation,
    cwd: string,
    choice: string | undefined,
    engine: RuleEngine,
  ): ChoiceOutcome {
    if (choice === ALLOW_ONCE) {
      return { result: undefined, approvals: [plan.approvalKey], entries: [], rules: [], switchToAuto: false };
    }

    if (choice === ALLOW_ALWAYS) {
      const entries: PermissionsEntry[] = [];
      const rules: SessionRule[] = [];

      for (const rule of engine.approvalRules(toolName, evaluation.units, cwd)) {
        rules.push(rule);
        entries.push({ kind: "allow", rule });
      }

      return { result: undefined, approvals: [plan.approvalKey], entries, rules, switchToAuto: false };
    }

    if (choice === ALLOW_AUTO) {
      return { result: undefined, approvals: [plan.approvalKey], entries: [], rules: [], switchToAuto: true };
    }

    if (choice === DENY_CHOICE) {
      return {
        result: { block: true, reason: `permissions: ${toolName} denied by user` },
        approvals: [],
        entries: [],
        rules: [],
        switchToAuto: false,
      };
    }

    return {
      result: { block: true, reason: `permissions: approval request for ${toolName} was dismissed` },
      approvals: [],
      entries: [],
      rules: [],
      switchToAuto: false,
    };
  }
}
