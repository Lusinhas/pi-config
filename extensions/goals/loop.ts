export interface LoopSpec {
  intervalMs: number;
  intervalLabel: string;
  prompt: string;
  startedAt: number;
}

export interface ParsedInterval {
  ms: number;
  label: string;
}

export interface LoopHooks {
  send(prompt: string): void;
  isIdle(): boolean;
  persist(active: boolean, spec?: LoopSpec): void;
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
};

export function parseInterval(token: string): ParsedInterval | undefined {
  const trimmed = token.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return undefined;
    }
    return { ms: seconds * 1000, label: `${seconds}s` };
  }
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = 0;
  let match = pattern.exec(trimmed);
  while (match) {
    if (match.index !== consumed) {
      return undefined;
    }
    total += Number(match[1]) * UNIT_MS[match[2]];
    consumed = match.index + match[0].length;
    match = pattern.exec(trimmed);
  }
  if (consumed !== trimmed.length || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return { ms: Math.round(total), label: trimmed };
}

export function formatInterval(ms: number): string {
  if (ms >= 3600000 && ms % 3600000 === 0) {
    return `${ms / 3600000}h`;
  }
  if (ms >= 60000 && ms % 60000 === 0) {
    return `${ms / 60000}m`;
  }
  if (ms >= 1000 && ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  return `${ms}ms`;
}

export class LoopRunner {
  #hooks: LoopHooks;
  #spec: LoopSpec | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ticks = 0;
  #skipped = 0;

  constructor(hooks: LoopHooks) {
    this.#hooks = hooks;
  }

  get spec(): LoopSpec | undefined {
    return this.#spec;
  }

  get active(): boolean {
    return this.#spec !== undefined;
  }

  get ticks(): number {
    return this.#ticks;
  }

  get skipped(): number {
    return this.#skipped;
  }

  start(spec: LoopSpec, persist: boolean): void {
    this.#clearTimer();
    this.#spec = spec;
    this.#ticks = 0;
    this.#skipped = 0;
    if (persist) {
      this.#hooks.persist(true, spec);
    }
    this.#schedule();
  }

  stop(persist: boolean): void {
    this.#clearTimer();
    const wasActive = this.#spec !== undefined;
    this.#spec = undefined;
    if (persist && wasActive) {
      this.#hooks.persist(false);
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #schedule(): void {
    const spec = this.#spec;
    if (!spec) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#tick();
    }, spec.intervalMs);
  }

  #tick(): void {
    const spec = this.#spec;
    if (!spec) {
      return;
    }
    let idle = false;
    try {
      idle = this.#hooks.isIdle();
    } catch {
      idle = false;
    }
    if (idle) {
      this.#ticks += 1;
      try {
        this.#hooks.send(spec.prompt);
      } catch {
        this.#skipped += 1;
      }
    } else {
      this.#skipped += 1;
    }
    this.#schedule();
  }
}
