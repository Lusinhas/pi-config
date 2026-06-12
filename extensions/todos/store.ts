export type BaseStatus = "open" | "active" | "done";
export type TodoStatus = BaseStatus | "blocked";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  deps: string[];
  priority: TodoPriority;
  created: number;
  updated: number;
}

export interface TodoPatch {
  text?: string;
  status?: BaseStatus;
  deps?: string[];
  priority?: TodoPriority;
}

export interface TodoSnapshot {
  counter: number;
  items: TodoItem[];
}

export interface TodoCounts {
  open: number;
  done: number;
}

interface StoredItem {
  id: string;
  text: string;
  status: BaseStatus;
  deps: string[];
  priority: TodoPriority;
  created: number;
  updated: number;
}

const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 };
const BASE_STATUSES: readonly BaseStatus[] = ["open", "active", "done"];
const PRIORITIES: readonly TodoPriority[] = ["high", "medium", "low"];

function idRank(id: string): number {
  const match = /^t(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareItems(a: StoredItem, b: StoredItem): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  const byId = idRank(a.id) - idRank(b.id);
  if (byId !== 0) return byId;
  return a.id.localeCompare(b.id);
}

function parseStoredItem(raw: unknown): StoredItem | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== "string" || rec.id.trim() === "") return null;
  if (typeof rec.text !== "string" || rec.text.trim() === "") return null;
  const status: BaseStatus = BASE_STATUSES.find((value) => value === rec.status) ?? "open";
  const priority: TodoPriority = PRIORITIES.find((value) => value === rec.priority) ?? "medium";
  const deps = Array.isArray(rec.deps)
    ? [...new Set(rec.deps.filter((dep): dep is string => typeof dep === "string" && dep.trim() !== "").map((dep) => dep.trim()))]
    : [];
  const now = Date.now();
  const created = typeof rec.created === "number" && Number.isFinite(rec.created) ? rec.created : now;
  const updated = typeof rec.updated === "number" && Number.isFinite(rec.updated) ? rec.updated : created;
  return { id: rec.id.trim(), text: rec.text.trim(), status, deps, priority, created, updated };
}

export class TodoStore {
  private counter = 0;
  private items = new Map<string, StoredItem>();

  add(text: string, deps?: string[], priority?: TodoPriority): TodoItem {
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("todo text must not be empty");
    const id = `t${this.counter + 1}`;
    const cleanDeps = this.normalizeDeps(deps ?? [], id);
    this.assertNoCycle(id, cleanDeps);
    this.counter += 1;
    const now = Date.now();
    const item: StoredItem = {
      id,
      text: trimmed,
      status: "open",
      deps: cleanDeps,
      priority: priority ?? "medium",
      created: now,
      updated: now,
    };
    this.items.set(id, item);
    return this.view(item);
  }

  update(id: string, patch: TodoPatch): TodoItem {
    const item = this.require(id);
    if (patch.text === undefined && patch.status === undefined && patch.deps === undefined && patch.priority === undefined) {
      throw new Error("update requires at least one of text, status, deps, priority");
    }
    if (patch.text !== undefined) {
      const trimmed = patch.text.trim();
      if (trimmed === "") throw new Error("todo text must not be empty");
      item.text = trimmed;
    }
    if (patch.deps !== undefined) {
      const cleanDeps = this.normalizeDeps(patch.deps, item.id);
      this.assertNoCycle(item.id, cleanDeps);
      item.deps = cleanDeps;
    }
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.priority !== undefined) item.priority = patch.priority;
    item.updated = Date.now();
    return this.view(item);
  }

  done(id: string): TodoItem {
    const item = this.require(id);
    item.status = "done";
    item.updated = Date.now();
    return this.view(item);
  }

  remove(id: string): TodoItem {
    const item = this.require(id);
    const removed = this.view(item);
    this.items.delete(item.id);
    for (const other of this.items.values()) {
      if (other.deps.includes(item.id)) {
        other.deps = other.deps.filter((dep) => dep !== item.id);
        other.updated = Date.now();
      }
    }
    return removed;
  }

  get(id: string): TodoItem | undefined {
    const item = this.items.get(id.trim());
    return item ? this.view(item) : undefined;
  }

  size(): number {
    return this.items.size;
  }

  clear(): number {
    const removed = this.items.size;
    this.items.clear();
    return removed;
  }

  list(): TodoItem[] {
    return [...this.items.values()].sort(compareItems).map((item) => this.view(item));
  }

  counts(): TodoCounts {
    let open = 0;
    let done = 0;
    for (const item of this.items.values()) {
      if (item.status === "done") done += 1;
      else open += 1;
    }
    return { open, done };
  }

  snapshot(): TodoSnapshot {
    return { counter: this.counter, items: this.list() };
  }

  restore(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    if (!Array.isArray(data.items)) return false;
    const next = new Map<string, StoredItem>();
    let highest = 0;
    for (const raw of data.items) {
      const item = parseStoredItem(raw);
      if (!item || next.has(item.id)) continue;
      next.set(item.id, item);
      const rank = idRank(item.id);
      if (rank !== Number.MAX_SAFE_INTEGER && rank > highest) highest = rank;
    }
    for (const item of next.values()) {
      item.deps = item.deps.filter((dep) => dep !== item.id && next.has(dep));
    }
    this.items = next;
    const counter =
      typeof data.counter === "number" && Number.isInteger(data.counter) && data.counter >= 0 ? data.counter : 0;
    this.counter = Math.max(counter, highest);
    for (const item of this.items.values()) {
      if (this.findCycle(item.id, item.deps)) item.deps = [];
    }
    return true;
  }

  private require(id: string): StoredItem {
    const key = id.trim();
    const item = this.items.get(key);
    if (!item) throw new Error(`no todo with id "${key}"${this.known()}`);
    return item;
  }

  private known(): string {
    const ids = [...this.items.keys()];
    return ids.length > 0 ? ` (known ids: ${ids.join(", ")})` : " (the todo list is empty)";
  }

  private normalizeDeps(deps: string[], selfId: string): string[] {
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const raw of deps) {
      const dep = raw.trim();
      if (dep === "" || seen.has(dep)) continue;
      seen.add(dep);
      if (dep === selfId) throw new Error(`todo ${selfId} cannot depend on itself`);
      if (!this.items.has(dep)) throw new Error(`unknown dependency id "${dep}"${this.known()}`);
      clean.push(dep);
    }
    return clean;
  }

  private assertNoCycle(id: string, deps: string[]): void {
    const cycle = this.findCycle(id, deps);
    if (cycle) throw new Error(`dependency cycle rejected: ${cycle.join(" -> ")}`);
  }

  private findCycle(id: string, deps: string[]): string[] | null {
    for (const start of deps) {
      const path = this.pathBack(start, id, new Set<string>());
      if (path) return [id, ...path];
    }
    return null;
  }

  private pathBack(node: string, goal: string, seen: Set<string>): string[] | null {
    if (node === goal) return [node];
    if (seen.has(node)) return null;
    seen.add(node);
    const item = this.items.get(node);
    if (!item) return null;
    for (const dep of item.deps) {
      const rest = this.pathBack(dep, goal, seen);
      if (rest) return [node, ...rest];
    }
    return null;
  }

  private effectiveStatus(item: StoredItem): TodoStatus {
    if (item.status === "done") return "done";
    for (const dep of item.deps) {
      const target = this.items.get(dep);
      if (target && target.status !== "done") return "blocked";
    }
    return item.status;
  }

  private view(item: StoredItem): TodoItem {
    return {
      id: item.id,
      text: item.text,
      status: this.effectiveStatus(item),
      deps: [...item.deps],
      priority: item.priority,
      created: item.created,
      updated: item.updated,
    };
  }
}
