import { describe, expect, test } from "bun:test";
import type { TodoItem } from "../../src/todos/index.ts";
import { TodoRender } from "../../src/todos/render.ts";

const item = (over: Partial<TodoItem>): TodoItem => ({
  id: "t1",
  text: "task",
  status: "open",
  deps: [],
  priority: "medium",
  created: 0,
  updated: 0,
  ...over,
});

describe("clip", () => {
  const render = new TodoRender();

  test("non-positive max yields empty", () => {
    expect(render.clip("hello", 0)).toBe("");
    expect(render.clip("hello", -1)).toBe("");
  });

  test("fits unchanged", () => {
    expect(render.clip("hi", 5)).toBe("hi");
    expect(render.clip("hello", 5)).toBe("hello");
  });

  test("max one yields ellipsis", () => {
    expect(render.clip("hello", 1)).toBe("…");
  });

  test("truncates with ellipsis", () => {
    expect(render.clip("hello", 3)).toBe("he…");
  });
});

describe("renderTodos", () => {
  const render = new TodoRender();

  test("empty pending yields no lines", () => {
    expect(render.renderTodos([], 8)).toEqual([]);
    expect(render.renderTodos([item({ status: "done" })], 8)).toEqual([]);
  });

  test("renders glyphs bang and pending deps", () => {
    const items = [
      item({ id: "t1", status: "done" }),
      item({ id: "t2", text: "build", priority: "high", deps: ["t1", "t9"] }),
    ];
    const lines = render.renderTodos(items, 8);

    expect(lines).toEqual(["○ t2! build ← t9"]);
  });

  test("caps at limit and appends more line", () => {
    const items = [
      item({ id: "t1", text: "a" }),
      item({ id: "t2", text: "b" }),
      item({ id: "t3", text: "c" }),
    ];
    const lines = render.renderTodos(items, 2);

    expect(lines).toEqual(["○ t1 a", "○ t2 b", "… 1 more"]);
  });

  test("limit floors and clamps to at least one", () => {
    const items = [item({ id: "t1" }), item({ id: "t2" })];

    expect(render.renderTodos(items, 0)).toEqual(["○ t1 task", "… 1 more"]);
    expect(render.renderTodos(items, 1.9)).toEqual(["○ t1 task", "… 1 more"]);
  });
});

describe("formatTodoList", () => {
  const render = new TodoRender();

  test("empty yields No todos", () => {
    expect(render.formatTodoList([])).toBe("No todos.");
  });

  test("lines with glyph bang status text arrows and summary", () => {
    const items = [
      item({ id: "t1", text: "ship", priority: "high", status: "active", deps: ["t2"] }),
      item({ id: "t2", text: "done one", status: "done" }),
    ];

    expect(render.formatTodoList(items)).toBe(
      ["◐ t1! [active] ship ← t2", "● t2 [done] done one", "1 pending, 1 done"].join("\n"),
    );
  });
});

describe("buildReminder", () => {
  const render = new TodoRender();

  test("empty pending yields empty string", () => {
    expect(render.buildReminder([])).toBe("");
    expect(render.buildReminder([item({ status: "done" })])).toBe("");
  });

  test("encodes high active and after-deps", () => {
    const items = [
      item({ id: "t1", text: "dep", status: "done" }),
      item({ id: "t2", text: "core", priority: "high", status: "active", deps: ["t1", "t3"] }),
    ];

    expect(render.buildReminder(items)).toBe("Todo list (1 pending; * active, ! high priority): t2!* core (after t3)");
  });

  test("greedy packs and appends remaining more count", () => {
    const items = Array.from({ length: 60 }, (_value, index) =>
      item({ id: `t${index + 1}`, text: `task ${"x".repeat(40)} ${index}` }),
    );
    const reminder = render.buildReminder(items);

    expect(reminder.length).toBeLessThanOrEqual(500);
    expect(reminder).toContain("more");
    expect(reminder.startsWith("Todo list (60 pending")).toBe(true);
  });

  test("single part text is clipped to 60 chars and fits under limit", () => {
    const items = [item({ id: "t1", text: "y".repeat(2000) })];
    const reminder = render.buildReminder(items);

    expect(reminder.length).toBeLessThanOrEqual(500);
    expect(reminder).toContain("t1 ");
    expect(reminder).toContain("…");
  });

  test("clips to limit when head plus first part exceeds limit and none fit", () => {
    const items = Array.from({ length: 200 }, (_value, index) =>
      item({ id: `t${index + 1}`, text: `task ${index} ${"z".repeat(50)}` }),
    );
    const reminder = render.buildReminder(items);

    expect(reminder.length).toBeLessThanOrEqual(500);
    expect(reminder.startsWith("Todo list (200 pending")).toBe(true);
  });
});
