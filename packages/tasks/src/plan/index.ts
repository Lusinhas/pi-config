import type { PlanConfig } from "./settings.ts";
import { Store, type PersistedPlan } from "./store.ts";
import { Names, Prompt } from "./names.ts";

export interface PlanState {
  active: boolean;
  snapshot: string[];
  gated: string[];
  reviewing: boolean;
}

export interface GatingHost {
  allToolNames(): string[];
  activeToolNames(): string[];
  setActiveTools(names: string[]): Promise<void> | void;
  appendStateEntry(snapshot: string[], gated: string[], active: boolean): void;
  readEntries(): unknown;
  applyUi(active: boolean, gated: string[]): void;
}

export class Gating {
  readonly state: PlanState = { active: false, snapshot: [], gated: [], reviewing: false };

  private readonly allowedTools: string[];
  private readonly blockedSet: Set<string>;

  constructor(
    private readonly host: GatingHost,
    private readonly config: PlanConfig,
  ) {
    this.allowedTools = [...config.readonlyTools, ...config.extraAllowed];
    this.blockedSet = new Set(config.blockedTools);
  }

  static normalizeNames(value: unknown): string[] {
    return Names.normalize(value);
  }

  static computeGated(allowed: string[], existing: string[]): string[] {
    return Names.computeGated(allowed, existing);
  }

  static restoreTarget(snapshot: string[], existing: string[]): string[] {
    return Names.restoreTarget(snapshot, existing);
  }

  gatedFor(existing: string[]): string[] {
    return Names.computeGated(this.allowedTools, existing);
  }

  async enter(persist: boolean): Promise<boolean> {
    if (this.state.active) {
      return false;
    }

    const all = this.host.allToolNames();
    const snapshot = this.host.activeToolNames();
    const gated = this.gatedFor(all);

    await this.host.setActiveTools(gated);
    this.state.active = true;
    this.state.snapshot = snapshot;
    this.state.gated = gated;
    this.state.reviewing = false;

    if (persist) {
      this.persist();
    }

    this.host.applyUi(this.state.active, this.state.gated);

    return true;
  }

  async exit(persist: boolean): Promise<boolean> {
    if (!this.state.active) {
      return false;
    }

    const all = this.host.allToolNames();
    const target = Names.restoreTarget(this.state.snapshot, all);

    await this.host.setActiveTools(target);
    this.state.active = false;
    this.state.snapshot = [];
    this.state.gated = [];
    this.state.reviewing = false;

    if (persist) {
      this.persist();
    }

    this.host.applyUi(this.state.active, this.state.gated);

    return true;
  }

  private restoredSnapshot(persisted: PersistedPlan, all: string[]): string[] {
    const restorable = Names.restorable(persisted.snapshot, all);

    if (restorable.length > 0) {
      return restorable;
    }

    if (this.state.active) {
      return [...this.state.snapshot];
    }

    return this.host.activeToolNames();
  }

  async syncFromSession(): Promise<void> {
    const persisted = Store.readPersisted(this.host.readEntries());

    if (persisted !== undefined && persisted.active) {
      const all = this.host.allToolNames();
      const snapshot = this.restoredSnapshot(persisted, all);
      const gated = this.gatedFor(all);

      await this.host.setActiveTools(gated);
      this.state.active = true;
      this.state.snapshot = snapshot;
      this.state.gated = gated;
      this.state.reviewing = false;
      this.host.applyUi(this.state.active, this.state.gated);

      return;
    }

    if (this.state.active) {
      await this.exit(false);

      return;
    }

    this.state.reviewing = false;
    this.host.applyUi(this.state.active, this.state.gated);
  }

  evaluateToolCall(toolName: unknown): { block: true; reason: string } | undefined {
    if (!this.state.active) {
      return undefined;
    }

    if (typeof toolName !== "string") {
      return undefined;
    }

    if (this.blockedSet.has(toolName)) {
      return { block: true, reason: this.config.blockReason };
    }

    return undefined;
  }

  systemPrompt(current: unknown): string {
    return Prompt.compose(current, this.config.systemPrompt);
  }

  private persist(): void {
    this.host.appendStateEntry(this.state.snapshot, this.state.gated, this.state.active);
  }
}
