import type { TodoItem, TodoStore } from "./index.ts";

export interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

export interface RestoreSelection {
  found: boolean;
  data: unknown;
}

export class TodoEngine {
  constructor(private readonly store: TodoStore) {}

  blockedIds(): Set<string> {
    return new Set(
      this.store
        .list()
        .filter((item) => item.status === "blocked")
        .map((item) => item.id),
    );
  }

  freedNote(before: Set<string>): string {
    const freed = this.store
      .list()
      .filter((item) => before.has(item.id) && item.status !== "blocked" && item.status !== "done")
      .map((item) => item.id);

    return freed.length > 0 ? ` (unblocked: ${freed.join(", ")})` : "";
  }

  addedSummary(item: TodoItem): string {
    if (item.status !== "blocked") {
      return `Added ${item.id}: ${item.text}`;
    }

    const blocking = item.deps.filter((dep) => {
      const target = this.store.get(dep);

      return target !== undefined && target.status !== "done";
    });

    return `Added ${item.id}: ${item.text} (blocked by ${blocking.join(", ")})`;
  }

  updatedSummary(item: TodoItem, before: Set<string>): string {
    return `Updated ${item.id}: ${item.text} [${item.status}]${this.freedNote(before)}`;
  }

  doneSummary(item: TodoItem, before: Set<string>): string {
    return `Completed ${item.id}: ${item.text}${this.freedNote(before)}`;
  }

  removedSummary(item: TodoItem, before: Set<string>): string {
    return `Removed ${item.id}: ${item.text}${this.freedNote(before)}`;
  }

  requireId(id: string | undefined, op: string): string {
    const trimmed = (id ?? "").trim();

    if (trimmed === "") {
      throw new Error(`op "${op}" requires an id`);
    }

    return trimmed;
  }

  selectRestoreData(entries: Iterable<SessionEntryLike>): RestoreSelection {
    let data: unknown;
    let found = false;

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "todos") {
        data = entry.data;
        found = true;
      }
    }

    return { found, data };
  }

  countsTail(): string {
    const counts = this.store.counts();

    return `(${counts.open} pending, ${counts.done} done)`;
  }

  delta(summary: string): string {
    return `${summary}\n${this.countsTail()}`;
  }

  reminderFingerprint(reminder: string): string {
    let hash = 5381;

    for (let index = 0; index < reminder.length; index += 1) {
      hash = (hash * 33 + reminder.charCodeAt(index)) | 0;
    }

    return `${reminder.length}:${hash >>> 0}`;
  }
}
