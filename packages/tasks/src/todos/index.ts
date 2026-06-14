import {
  type BaseStatus,
  compareItems,
  idRank,
  type StoredItem,
  StoredItemParser,
  type TodoPriority,
  type TodoStatus,
} from "./store.ts";

export type { BaseStatus, TodoPriority, TodoStatus } from "./store.ts";

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

export class TodoStore {
  private counter = 0;
  private items = new Map<string, StoredItem>();
  private readonly parser = new StoredItemParser();
  private cachedList: TodoItem[] | null = null;
  private cachedCounts: TodoCounts | null = null;

  add(text: string, deps?: string[], priority?: TodoPriority): TodoItem {
    const trimmed = text.trim();

    if (trimmed === "") {
      throw new Error("todo text must not be empty");
    }

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
    this.invalidate();

    return this.viewOf(item);
  }

  update(id: string, patch: TodoPatch): TodoItem {
    const item = this.require(id);
    const empty =
      patch.text === undefined && patch.status === undefined && patch.deps === undefined && patch.priority === undefined;

    if (empty) {
      throw new Error("update requires at least one of text, status, deps, priority");
    }

    if (patch.text !== undefined) {
      const trimmed = patch.text.trim();

      if (trimmed === "") {
        throw new Error("todo text must not be empty");
      }

      item.text = trimmed;
    }

    if (patch.deps !== undefined) {
      const cleanDeps = this.normalizeDeps(patch.deps, item.id);

      this.assertNoCycle(item.id, cleanDeps);
      item.deps = cleanDeps;
    }

    if (patch.status !== undefined) {
      item.status = patch.status;
    }

    if (patch.priority !== undefined) {
      item.priority = patch.priority;
    }

    item.updated = Date.now();
    this.invalidate();

    return this.viewOf(item);
  }

  done(id: string): TodoItem {
    const item = this.require(id);

    item.status = "done";
    item.updated = Date.now();
    this.invalidate();

    return this.viewOf(item);
  }

  remove(id: string): TodoItem {
    const item = this.require(id);
    const removed = this.viewOf(item);

    this.items.delete(item.id);

    for (const other of this.items.values()) {
      if (other.deps.includes(item.id)) {
        other.deps = other.deps.filter((dep) => dep !== item.id);
        other.updated = Date.now();
      }
    }

    this.invalidate();

    return removed;
  }

  get(id: string): TodoItem | undefined {
    const item = this.items.get(id.trim());

    return item ? this.viewOf(item) : undefined;
  }

  size(): number {
    return this.items.size;
  }

  clear(): number {
    const removed = this.items.size;

    this.items.clear();
    this.invalidate();

    return removed;
  }

  list(): TodoItem[] {
    if (this.cachedList === null) {
      this.rebuild();
    }

    return this.cachedList as TodoItem[];
  }

  counts(): TodoCounts {
    if (this.cachedCounts === null) {
      this.rebuild();
    }

    return this.cachedCounts as TodoCounts;
  }

  snapshot(): TodoSnapshot {
    return { counter: this.counter, items: this.list() };
  }

  restore(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }

    const data = value as Record<string, unknown>;

    if (!Array.isArray(data.items)) {
      return false;
    }

    const next = new Map<string, StoredItem>();
    let highest = 0;

    for (const raw of data.items) {
      const item = this.parser.parse(raw);

      if (!item || next.has(item.id)) {
        continue;
      }

      next.set(item.id, item);

      const rank = idRank(item.id);

      if (rank !== Number.MAX_SAFE_INTEGER && rank > highest) {
        highest = rank;
      }
    }

    for (const item of next.values()) {
      item.deps = item.deps.filter((dep) => dep !== item.id && next.has(dep));
    }

    this.items = next;

    const counter =
      typeof data.counter === "number" && Number.isInteger(data.counter) && data.counter >= 0 ? data.counter : 0;

    this.counter = Math.max(counter, highest);

    for (const item of this.items.values()) {
      if (this.findCycle(item.id, item.deps)) {
        item.deps = [];
      }
    }

    this.invalidate();

    return true;
  }

  private invalidate(): void {
    this.cachedList = null;
    this.cachedCounts = null;
  }

  private rebuild(): void {
    const stored = [...this.items.values()].sort(compareItems);
    const done = new Set<string>();

    for (const item of stored) {
      if (item.status === "done") {
        done.add(item.id);
      }
    }

    let open = 0;
    const list: TodoItem[] = [];

    for (const item of stored) {
      const view = this.viewFrom(item, done);

      list.push(view);

      if (view.status === "done") {
        continue;
      }

      open += 1;
    }

    this.cachedList = list;
    this.cachedCounts = { open, done: list.length - open };
  }

  private require(id: string): StoredItem {
    const key = id.trim();
    const item = this.items.get(key);

    if (!item) {
      throw new Error(`no todo with id "${key}"${this.known()}`);
    }

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

      if (dep === "" || seen.has(dep)) {
        continue;
      }

      seen.add(dep);

      if (dep === selfId) {
        throw new Error(`todo ${selfId} cannot depend on itself`);
      }

      if (!this.items.has(dep)) {
        throw new Error(`unknown dependency id "${dep}"${this.known()}`);
      }

      clean.push(dep);
    }

    return clean;
  }

  private assertNoCycle(id: string, deps: string[]): void {
    const cycle = this.findCycle(id, deps);

    if (cycle) {
      throw new Error(`dependency cycle rejected: ${cycle.join(" -> ")}`);
    }
  }

  private findCycle(id: string, deps: string[]): string[] | null {
    for (const start of deps) {
      const path = this.pathBack(start, id, new Set<string>());

      if (path) {
        return [id, ...path];
      }
    }

    return null;
  }

  private pathBack(node: string, goal: string, seen: Set<string>): string[] | null {
    if (node === goal) {
      return [node];
    }

    if (seen.has(node)) {
      return null;
    }

    seen.add(node);

    const item = this.items.get(node);

    if (!item) {
      return null;
    }

    for (const dep of item.deps) {
      const rest = this.pathBack(dep, goal, seen);

      if (rest) {
        return [node, ...rest];
      }
    }

    return null;
  }

  private viewOf(item: StoredItem): TodoItem {
    return this.viewFrom(item, this.doneSet());
  }

  private doneSet(): Set<string> {
    const done = new Set<string>();

    for (const item of this.items.values()) {
      if (item.status === "done") {
        done.add(item.id);
      }
    }

    return done;
  }

  private viewFrom(item: StoredItem, done: Set<string>): TodoItem {
    return {
      id: item.id,
      text: item.text,
      status: this.effectiveStatus(item, done),
      deps: [...item.deps],
      priority: item.priority,
      created: item.created,
      updated: item.updated,
    };
  }

  private effectiveStatus(item: StoredItem, done: Set<string>): TodoStatus {
    if (item.status === "done") {
      return "done";
    }

    for (const dep of item.deps) {
      if (this.items.has(dep) && !done.has(dep)) {
        return "blocked";
      }
    }

    return item.status;
  }
}
