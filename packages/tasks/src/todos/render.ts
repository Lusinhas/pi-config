import type { TodoItem } from "./index.ts";
import type { TodoStatus } from "./store.ts";

const REMINDER_LIMIT = 500;

const GLYPHS: Record<TodoStatus, string> = {
  open: "○",
  active: "◐",
  blocked: "⊘",
  done: "●",
};

export class TodoRender {
  renderTodos(items: TodoItem[], limit: number): string[] {
    const pending = items.filter((item) => item.status !== "done");

    if (pending.length === 0) {
      return [];
    }

    const finished = this.doneIds(items);
    const cap = Math.max(1, Math.floor(limit));
    const lines = pending.slice(0, cap).map((item) => this.widgetLine(item, finished));

    if (pending.length > cap) {
      lines.push(`… ${pending.length - cap} more`);
    }

    return lines;
  }

  formatTodoList(items: TodoItem[]): string {
    if (items.length === 0) {
      return "No todos.";
    }

    const lines = items.map((item) => {
      const bang = item.priority === "high" ? "!" : "";
      const arrows = item.deps.length > 0 ? ` ← ${item.deps.join(" ")}` : "";

      return `${GLYPHS[item.status]} ${item.id}${bang} [${item.status}] ${item.text}${arrows}`;
    });

    const done = items.filter((item) => item.status === "done").length;

    lines.push(`${items.length - done} pending, ${done} done`);

    return lines.join("\n");
  }

  buildReminder(items: TodoItem[]): string {
    const pending = items.filter((item) => item.status !== "done");

    if (pending.length === 0) {
      return "";
    }

    const finished = this.doneIds(items);
    const head = `Todo list (${pending.length} pending; * active, ! high priority): `;
    const parts = pending.map((item) => this.reminderPart(item, finished));

    let body = "";
    let included = 0;

    for (const part of parts) {
      const candidate = body === "" ? part : `${body}; ${part}`;
      const left = parts.length - included - 1;
      const tail = left > 0 ? `; +${left} more` : "";

      if (head.length + candidate.length + tail.length > REMINDER_LIMIT) {
        break;
      }

      body = candidate;
      included += 1;
    }

    if (included === 0) {
      return this.clip(head + parts[0], REMINDER_LIMIT);
    }

    const left = parts.length - included;
    const tail = left > 0 ? `; +${left} more` : "";

    return this.clip(head + body + tail, REMINDER_LIMIT);
  }

  clip(text: string, max: number): string {
    if (max <= 0) {
      return "";
    }

    if (text.length <= max) {
      return text;
    }

    if (max === 1) {
      return "…";
    }

    return `${text.slice(0, max - 1)}…`;
  }

  private reminderPart(item: TodoItem, finished: Set<string>): string {
    let part = item.id;

    if (item.priority === "high") {
      part += "!";
    }

    if (item.status === "active") {
      part += "*";
    }

    part += ` ${this.clip(item.text, 60)}`;

    const waiting = this.pendingDeps(item, finished);

    if (waiting.length > 0) {
      part += ` (after ${waiting.join(",")})`;
    }

    return part;
  }

  private widgetLine(item: TodoItem, finished: Set<string>): string {
    const bang = item.priority === "high" ? "!" : "";
    const waiting = this.pendingDeps(item, finished);
    const arrows = waiting.length > 0 ? ` ← ${waiting.join(" ")}` : "";

    return `${GLYPHS[item.status]} ${item.id}${bang} ${this.clip(item.text, 64)}${arrows}`;
  }

  private doneIds(items: TodoItem[]): Set<string> {
    return new Set(items.filter((item) => item.status === "done").map((item) => item.id));
  }

  private pendingDeps(item: TodoItem, finished: Set<string>): string[] {
    return item.deps.filter((dep) => !finished.has(dep));
  }
}
