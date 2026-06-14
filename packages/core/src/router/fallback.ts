import { errorText, isRecord, Models, type AgentModel } from "./models.ts";
import type { FallbackConfig } from "./index.ts";

export interface FailureRecord {
  count: number;
  last: number;
}

export interface ActiveFallback {
  original: AgentModel;
  fallbackId: string;
  streakStart: number;
  offered: boolean;
}

export interface ProviderResponseEvent {
  status?: unknown;
  headers?: unknown;
}

export interface FallbackPorts {
  registry: unknown;
  currentModel: AgentModel | null | undefined;
  hasUI: boolean;
  setModel: (model: AgentModel) => Promise<boolean>;
  confirm: (title: string, message: string) => Promise<boolean>;
  notify: (text: string, kind: "info" | "warning" | "error") => void;
}

export class FallbackStatus {
  static parse(event: ProviderResponseEvent | undefined): number | undefined {
    const value = event?.status;

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  static isFailure(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
  }

  static isSuccess(status: number): boolean {
    return status >= 200 && status < 300;
  }
}

export class FallbackEngine {
  #config: FallbackConfig;
  #failures: Map<string, FailureRecord>;
  #active: ActiveFallback | null;
  #busy: boolean;

  constructor(config: FallbackConfig) {
    this.#config = config;
    this.#failures = new Map();
    this.#active = null;
    this.#busy = false;
  }

  get enabled(): boolean {
    return this.#config.enabled;
  }

  get active(): ActiveFallback | null {
    return this.#active;
  }

  static statusOf(event: ProviderResponseEvent | undefined): number | undefined {
    return FallbackStatus.parse(event);
  }

  static isFailure(status: number): boolean {
    return FallbackStatus.isFailure(status);
  }

  static isSuccess(status: number): boolean {
    return FallbackStatus.isSuccess(status);
  }

  chainFor(modelId: string): string[] | undefined {
    const lower = modelId.toLowerCase();

    for (const [pattern, chain] of Object.entries(this.#config.chains)) {
      if (lower.includes(pattern.toLowerCase())) {
        return chain;
      }
    }

    return undefined;
  }

  onSessionStart(): void {
    this.#failures.clear();
    this.#active = null;
  }

  onModelSelect(model: unknown): void {
    if (this.#busy) {
      return;
    }

    this.#failures.clear();

    if (!this.#active) {
      return;
    }

    if (!isRecord(model)) {
      return;
    }

    if (Models.describe(model as AgentModel) === this.#active.fallbackId) {
      return;
    }

    this.#active = null;
  }

  async recordResponse(event: ProviderResponseEvent, ports: FallbackPorts, now: number): Promise<void> {
    const status = FallbackEngine.statusOf(event);

    if (status === undefined) {
      return;
    }

    const modelId = Models.describe(ports.currentModel);

    if (modelId === "unknown") {
      return;
    }

    if (FallbackEngine.isFailure(status)) {
      const previous = this.#failures.get(modelId);
      const count =
        previous && now - previous.last <= this.#config.failWindowSec * 1000 ? previous.count + 1 : 1;
      this.#failures.set(modelId, { count, last: now });

      if (this.#active && this.#active.fallbackId === modelId) {
        this.#active.streakStart = 0;
        this.#active.offered = false;
      }

      if (count >= this.#config.threshold && !this.#busy) {
        this.#busy = true;
        this.#failures.delete(modelId);

        try {
          await this.attemptFallback(ports, modelId, status, now);
        } finally {
          this.#busy = false;
        }
      }

      return;
    }

    if (FallbackEngine.isSuccess(status)) {
      this.#failures.delete(modelId);

      if (this.#active && this.#active.fallbackId === modelId && this.#active.streakStart === 0) {
        this.#active.streakStart = now;
      }
    }
  }

  async attemptFallback(ports: FallbackPorts, failedId: string, status: number, now: number): Promise<void> {
    const current = ports.currentModel;

    if (!current) {
      return;
    }

    const chain = this.chainFor(failedId);

    if (!chain) {
      ports.notify(
        `router: ${failedId} failed ${this.#config.threshold}x (HTTP ${status}) but no fallback chain matches it`,
        "warning"
      );

      return;
    }

    const models = await Models.list(ports.registry);
    const original = this.#active ? this.#active.original : current;
    let start = 0;

    for (let index = 0; index < chain.length; index += 1) {
      const resolution = Models.resolveIn(models, chain[index]);

      if (resolution.model && Models.same(resolution.model, current)) {
        start = index + 1;
        break;
      }
    }

    for (let index = start; index < chain.length; index += 1) {
      const resolution = Models.resolveIn(models, chain[index]);
      const candidate = resolution.model;

      if (!candidate || Models.same(candidate, current)) {
        continue;
      }

      const candidateId = Models.describe(candidate);
      const record = this.#failures.get(candidateId);

      if (record && record.count >= this.#config.threshold && now - record.last <= this.#config.failWindowSec * 1000) {
        continue;
      }

      let ok = false;

      try {
        ok = await ports.setModel(candidate);
      } catch {
        ok = false;
      }

      if (!ok) {
        continue;
      }

      this.#active = { original, fallbackId: candidateId, streakStart: 0, offered: false };
      ports.notify(
        `router: ${failedId} failed ${this.#config.threshold}x (last HTTP ${status}) — fell back to ${candidateId}; ${Models.describe(original)} will be offered back after ${this.#config.restoreAfterMin} min of stable turns`,
        "warning"
      );

      return;
    }

    ports.notify(
      `router: ${failedId} keeps failing (HTTP ${status}) and no model in its fallback chain could be activated`,
      "error"
    );
  }

  async onTurnEnd(ports: FallbackPorts, now: number): Promise<void> {
    if (!this.#active || this.#active.offered || this.#active.streakStart === 0 || this.#busy) {
      return;
    }

    if (now - this.#active.streakStart < this.#config.restoreAfterMin * 60 * 1000) {
      return;
    }

    this.#busy = true;
    const pending = this.#active;
    pending.offered = true;

    try {
      const models = await Models.list(ports.registry);
      const live = models.find(model => Models.same(model, pending.original)) ?? pending.original;
      const originalId = Models.describe(live);
      let approved = true;

      if (ports.hasUI) {
        approved = await ports.confirm(
          "Restore model",
          `${pending.fallbackId} has been stable for ${this.#config.restoreAfterMin} min since the provider fallback. Restore ${originalId}?`
        );
      }

      if (!approved) {
        this.#active = null;

        return;
      }

      let ok = false;
      let failure = "";

      try {
        ok = await ports.setModel(live);
      } catch (error) {
        ok = false;
        failure = errorText(error);
      }

      if (ok) {
        this.#active = null;
        this.#failures.delete(originalId);
        ports.notify(`router: restored ${originalId} after the provider recovered`, "info");
      } else {
        const detail = failure !== "" ? ` (${failure})` : "";
        ports.notify(`router: could not restore ${originalId}; staying on ${pending.fallbackId}${detail}`, "warning");
      }
    } finally {
      this.#busy = false;
    }
  }
}
