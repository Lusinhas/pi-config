import { Modes, type Mode } from "./modes.ts";
import { Judge, type JudgeVerdict } from "./judge.ts";
import { RuleEngine, type Evaluation } from "./index.ts";
import { isRecord, RuleSanitizer, RuleText, type SessionRule } from "./text.ts";
import type { JudgeConfig, PermissionsConfig } from "./loader.ts";
import {
  AskPlanBuilder,
  type AskPlan,
  type Approval,
  type ChoiceOutcome,
  type DecisionResult,
} from "./plan.ts";

export type {
  AllowEntry,
  Approval,
  AskPlan,
  BlockResult,
  ChoiceOutcome,
  ClearEntry,
  DecisionResult,
  ModeEntry,
  PermissionsEntry,
} from "./plan.ts";
export { ALLOW_ALWAYS, ALLOW_AUTO, ALLOW_ONCE, DENY_CHOICE } from "./plan.ts";

export const ENTRY_TYPE = "piconfig:permissions";

export interface JudgeOutcome {
  result?: DecisionResult;
  approvals: Approval[];
  judgeNote: string;
  notify?: string;
}

export class PermissionsService {
  private mode: Mode;
  private sessionRules: SessionRule[] = [];
  private readonly approvals = new Map<string, Approval>();
  private readonly engine: RuleEngine;
  private readonly planner: AskPlanBuilder;

  constructor(private readonly config: PermissionsConfig) {
    this.mode = config.mode;
    this.engine = new RuleEngine(this.engineConfig(), this.sessionRules);
    this.planner = new AskPlanBuilder(config.previewLength);
  }

  private engineConfig() {
    return {
      mode: this.mode,
      allow: this.config.allow,
      deny: this.config.deny,
      ask: this.config.ask,
      readTools: this.config.readTools,
      writeTools: this.config.writeTools,
      bashTools: this.config.bashTools,
      pathTools: this.config.pathTools,
    };
  }

  private syncEngine(): RuleEngine {
    return this.engine.withMode(this.mode).withSessionRules(this.sessionRules);
  }

  currentMode(): Mode {
    return this.mode;
  }

  setMode(mode: Mode): boolean {
    const changed = mode !== this.mode;

    this.mode = mode;

    if (changed) {
      this.sessionRules = [];
      this.approvals.clear();
    }

    return changed;
  }

  defaultMode(): Mode {
    return this.config.mode;
  }

  reset(): void {
    this.sessionRules = [];
    this.approvals.clear();
  }

  replay(entries: Iterable<unknown>): Mode {
    let mode: Mode = this.config.mode;

    for (const entry of entries) {
      const candidate = entry as { type?: string; customType?: string; data?: unknown };

      if (candidate.type !== "custom" || candidate.customType !== ENTRY_TYPE || !isRecord(candidate.data)) {
        continue;
      }

      const data = candidate.data;

      if (data.kind === "clear") {
        this.sessionRules = [];
      } else if (data.kind === "mode" && Modes.is(data.mode)) {
        mode = data.mode;
      } else if (data.kind === "allow") {
        const rule = RuleSanitizer.sessionRule(data.rule);

        if (rule) {
          this.sessionRules.push(rule);
        }
      }
    }

    this.mode = mode;

    if (this.mode === "ask") {
      this.sessionRules = [];
    }

    return mode;
  }

  statusText(): string {
    const judgeTag = this.config.judge.enabled ? " +judge" : "";

    return `permissions: ${this.mode}${judgeTag}`;
  }

  modeAnnouncement(mode: Mode): string {
    return `permissions mode: ${mode} (${Modes.describe(mode)})`;
  }

  unknownModeMessage(requested: string): string {
    return `permissions: unknown mode "${requested}" (valid modes: ${Modes.ALL.join(", ")})`;
  }

  modeCompletions(prefix: string): Array<{ value: string; label: string }> | null {
    const needle = prefix.trim().toLowerCase();
    const items = Modes.ALL.filter((mode) => mode.startsWith(needle)).map((mode) => ({
      value: mode,
      label: `${mode} — ${Modes.describe(mode)}`,
    }));

    return items.length > 0 ? items : null;
  }

  evaluate(toolName: string, input: unknown, cwd: string): Evaluation {
    return this.syncEngine().evaluate(toolName, input, cwd);
  }

  normalizeArgument(toolName: string, input: unknown): string {
    return this.syncEngine().normalizeArgument(toolName, input);
  }

  approvalRules(toolName: string, units: readonly string[], cwd: string): SessionRule[] {
    return this.syncEngine().approvalRules(toolName, units, cwd);
  }

  private static approvalKey(approval: Approval): string {
    return `${approval.tool} ${approval.argument}`;
  }

  skipApprovalCache(): boolean {
    return this.mode === "ask";
  }

  approvalActiveForMode(approval: Approval): boolean {
    return !this.skipApprovalCache() && this.hasApproval(approval);
  }

  hasApproval(approval: Approval): boolean {
    return this.approvals.has(PermissionsService.approvalKey(approval));
  }

  recordApproval(approval: Approval): void {
    this.approvals.set(PermissionsService.approvalKey(approval), approval);
  }

  pushSessionRule(rule: SessionRule): void {
    this.sessionRules.push(rule);
  }

  listApprovals(): Approval[] {
    return [...this.approvals.values()];
  }

  mapEvaluation(evaluation: Evaluation): DecisionResult | "ask" {
    if (evaluation.action === "allow") {
      return undefined;
    }

    if (evaluation.action === "deny") {
      return { block: true, reason: `permissions: blocked by ${evaluation.reason}` };
    }

    return "ask";
  }

  judgeGateActive(): boolean {
    return this.config.judge.enabled || this.mode === "auto";
  }

  judgeConfig(): JudgeConfig {
    return this.config.judge;
  }

  applyJudgeVerdict(approval: Approval, verdict: JudgeVerdict | undefined): JudgeOutcome {
    if (verdict) {
      if (Judge.riskRank(verdict.risk) <= Judge.riskRank(this.config.judge.maxRisk)) {
        return {
          result: undefined,
          approvals: [approval],
          judgeNote: "",
          notify: `permissions: judge approved ${approval.tool} (${verdict.risk}: ${verdict.reason})`,
        };
      }

      return { approvals: [], judgeNote: `judge: ${verdict.risk} (${verdict.reason})` };
    }

    return { approvals: [], judgeNote: "judge: unavailable, falling back to manual approval" };
  }

  headlessAsk(toolName: string, evaluation: Evaluation): DecisionResult {
    if (this.config.headless === "allow") {
      return undefined;
    }

    return {
      block: true,
      reason: `permissions: ${toolName} needs approval (${evaluation.reason}) and no UI is available; headless policy is deny`,
    };
  }

  headlessBroker(toolName: string, origin: string): DecisionResult {
    if (this.config.headless === "allow") {
      return undefined;
    }

    return {
      block: true,
      reason: `permissions: ${toolName} from subagent "${origin}" needs approval and no session is available; headless policy is deny`,
    };
  }

  failure(toolName: string, detail: string): DecisionResult {
    if (this.mode === "yolo") {
      return undefined;
    }

    return {
      block: true,
      reason: `permissions: evaluation failed for ${toolName} (${detail}); blocked under ${this.mode} mode`,
    };
  }

  buildAskPlan(toolName: string, argument: string, evaluation: Evaluation, judgeNote: string, origin: string): AskPlan {
    return this.planner.buildAskPlan(toolName, argument, evaluation, judgeNote, origin, this.mode);
  }

  resolveChoice(
    toolName: string,
    plan: AskPlan,
    evaluation: Evaluation,
    cwd: string,
    choice: string | undefined,
  ): ChoiceOutcome {
    const outcome = this.planner.resolveChoice(toolName, plan, evaluation, cwd, choice, this.syncEngine());

    for (const rule of outcome.rules) {
      this.pushSessionRule(rule);
    }

    return outcome;
  }

  private appendRuleSection(lines: string[], label: string, rules: readonly SessionRule[]): void {
    if (rules.length === 0) {
      lines.push(`${label}: (none)`);

      return;
    }

    lines.push(`${label}:`);

    for (const rule of rules) {
      lines.push(`  - ${RuleText.format(rule)}`);
    }
  }

  buildReport(): string {
    const lines: string[] = [];

    lines.push(`mode: ${this.mode} (${Modes.describe(this.mode)})`);
    lines.push(
      this.config.judge.enabled || this.mode === "auto"
        ? `judge: active (${this.config.judge.model}, auto-approves up to ${this.config.judge.maxRisk}${this.config.judge.enabled ? "" : ", via auto mode"})`
        : "judge: disabled",
    );
    lines.push(`headless policy: ${this.config.headless}`);
    lines.push(`free read tools: ${this.config.readTools.join(", ") || "(none)"}`);
    lines.push(`gated write tools: ${this.config.writeTools.join(", ") || "(none)"}`);

    this.appendRuleSection(lines, "deny rules", this.config.deny);
    this.appendRuleSection(lines, "allow rules", this.config.allow);
    this.appendRuleSection(lines, "ask rules", this.config.ask);
    this.appendRuleSection(lines, "session allow rules", this.sessionRules);

    const approvals = this.listApprovals();

    lines.push(`session approvals: ${approvals.length}`);

    for (const approval of approvals.slice(0, 15)) {
      lines.push(`  - ${approval.tool}: ${PermissionsService.truncatePreview(approval.argument, 80) || "(no arguments)"}`);
    }

    if (approvals.length > 15) {
      lines.push(`  … ${approvals.length - 15} more`);
    }

    return lines.join("\n");
  }

  static truncatePreview(text: string, maxLength: number): string {
    return AskPlanBuilder.truncatePreview(text, maxLength);
  }
}
