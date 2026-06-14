export type BaseStatus = "open" | "active" | "done";
export type TodoStatus = BaseStatus | "blocked";
export type TodoPriority = "high" | "medium" | "low";

export interface StoredItem {
  id: string;
  text: string;
  status: BaseStatus;
  deps: string[];
  priority: TodoPriority;
  created: number;
  updated: number;
}

export const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 };
export const BASE_STATUSES: readonly BaseStatus[] = ["open", "active", "done"];
export const PRIORITIES: readonly TodoPriority[] = ["high", "medium", "low"];

export function idRank(id: string): number {
  const match = /^t(\d+)$/.exec(id);

  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function compareItems(a: StoredItem, b: StoredItem): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];

  if (byPriority !== 0) {
    return byPriority;
  }

  const byId = idRank(a.id) - idRank(b.id);

  if (byId !== 0) {
    return byId;
  }

  return a.id.localeCompare(b.id);
}

export class StoredItemParser {
  parse(raw: unknown): StoredItem | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }

    const rec = raw as Record<string, unknown>;

    if (typeof rec.id !== "string" || rec.id.trim() === "") {
      return null;
    }

    if (typeof rec.text !== "string" || rec.text.trim() === "") {
      return null;
    }

    const status = BASE_STATUSES.find((value) => value === rec.status) ?? "open";
    const priority = PRIORITIES.find((value) => value === rec.priority) ?? "medium";
    const deps = this.normalizeRawDeps(rec.deps);
    const now = Date.now();
    const created = typeof rec.created === "number" && Number.isFinite(rec.created) ? rec.created : now;
    const updated = typeof rec.updated === "number" && Number.isFinite(rec.updated) ? rec.updated : created;

    return { id: rec.id.trim(), text: rec.text.trim(), status, deps, priority, created, updated };
  }

  private normalizeRawDeps(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const trimmed = raw
      .filter((dep): dep is string => typeof dep === "string" && dep.trim() !== "")
      .map((dep) => dep.trim());

    return [...new Set(trimmed)];
  }
}
