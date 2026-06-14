import { isMode, isRecord, type Mode } from "./config.ts";
import type { CheckResult } from "./index.ts";

export const ENTRY_TYPE = "piconfig:comments";

export const HISTORY_LIMIT = 5;

export interface SessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

export interface ModeResolution {
  mode: Mode;
  error?: Error;
}

export interface PersistResult {
  changed: boolean;
  mode: Mode;
}

export class EntryReader {
  resolveMode(entries: Iterable<SessionEntry>, defaultMode: Mode): Mode {
    let mode: Mode = defaultMode;

    for (const entry of entries) {
      if (
        entry.type === "custom" &&
        entry.customType === ENTRY_TYPE &&
        isRecord(entry.data) &&
        isMode(entry.data.mode)
      ) {
        mode = entry.data.mode;
      }
    }

    return mode;
  }
}

export class History {
  private items: CheckResult[] = [];

  get entries(): CheckResult[] {
    return this.items;
  }

  set entries(value: CheckResult[]) {
    this.items = value;
  }

  reset(): void {
    this.items = [];
  }

  record(result: CheckResult): void {
    this.items.unshift(result);

    if (this.items.length > HISTORY_LIMIT) {
      this.items = this.items.slice(0, HISTORY_LIMIT);
    }
  }
}

export class SessionState {
  private readonly defaultMode: Mode;
  private readonly entries = new EntryReader();
  private readonly bounded = new History();
  mode: Mode;
  lastWarnKey = "";

  constructor(defaultMode: Mode) {
    this.defaultMode = defaultMode;
    this.mode = defaultMode;
  }

  get history(): CheckResult[] {
    return this.bounded.entries;
  }

  reset(): void {
    this.bounded.reset();
    this.lastWarnKey = "";
  }

  resolveMode(entries: Iterable<SessionEntry>): Mode {
    return this.entries.resolveMode(entries, this.defaultMode);
  }

  restore(read: () => Iterable<SessionEntry>): ModeResolution {
    this.reset();

    let entries: Iterable<SessionEntry>;

    try {
      entries = read();
    } catch (cause) {
      this.mode = this.defaultMode;
      return { mode: this.defaultMode, error: cause instanceof Error ? cause : new Error(String(cause)) };
    }

    const mode = this.resolveMode(entries);
    this.mode = mode;

    return { mode };
  }

  applyMode(mode: Mode): PersistResult {
    const changed = mode !== this.mode;
    this.mode = mode;

    return { changed, mode };
  }

  recordResult(result: CheckResult): void {
    this.bounded.record(result);
  }

  shouldWarn(key: string): boolean {
    if (key === this.lastWarnKey) {
      return false;
    }

    this.lastWarnKey = key;

    return true;
  }
}
