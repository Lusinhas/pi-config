import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { TodoStore } from "../../src/todos/index.ts";
import { TodoMirror } from "../../src/todos/mirror.ts";
import { type SessionEntryLike, TodoEngine } from "../../src/todos/summaries.ts";

describe("TodoEngine requireId", () => {
  test("trims and rejects empty", () => {
    const engine = new TodoEngine(new TodoStore());

    expect(engine.requireId("  t1 ", "done")).toBe("t1");
    expect(() => engine.requireId("   ", "update")).toThrow('op "update" requires an id');
    expect(() => engine.requireId(undefined, "remove")).toThrow('op "remove" requires an id');
  });
});

describe("TodoEngine summaries and freedNote", () => {
  test("addedSummary plain and blocked", () => {
    const store = new TodoStore();
    const engine = new TodoEngine(store);
    const a = store.add("dep");

    expect(engine.addedSummary(a)).toBe("Added t1: dep");

    const b = store.add("waits", [a.id]);

    expect(engine.addedSummary(b)).toBe("Added t2: waits (blocked by t1)");
  });

  test("freedNote reports newly unblocked ids", () => {
    const store = new TodoStore();
    const engine = new TodoEngine(store);
    const a = store.add("dep");

    store.add("waits", [a.id]);

    const before = engine.blockedIds();

    expect(before).toEqual(new Set(["t2"]));

    store.done(a.id);
    expect(engine.freedNote(before)).toBe(" (unblocked: t2)");
  });

  test("freedNote empty when nothing unblocked", () => {
    const store = new TodoStore();
    const engine = new TodoEngine(store);

    store.add("a");
    expect(engine.freedNote(engine.blockedIds())).toBe("");
  });

  test("done and removed summaries include freedNote", () => {
    const store = new TodoStore();
    const engine = new TodoEngine(store);
    const a = store.add("dep");
    const b = store.add("waits", [a.id]);
    const before = engine.blockedIds();

    store.done(a.id);
    expect(engine.doneSummary(store.get(a.id)!, before)).toBe("Completed t1: dep (unblocked: t2)");

    const before2 = engine.blockedIds();
    const removed = store.remove(b.id);

    expect(engine.removedSummary(removed, before2)).toBe("Removed t2: waits");
  });

  test("updatedSummary carries derived status bracket", () => {
    const store = new TodoStore();
    const engine = new TodoEngine(store);
    const a = store.add("dep");
    const b = store.add("waits", [a.id]);
    const before = engine.blockedIds();
    const updated = store.update(b.id, { priority: "high" });

    expect(engine.updatedSummary(updated, before)).toBe("Updated t2: waits [blocked]");
  });
});

describe("TodoEngine compact delta", () => {
  test("countsTail reports open and done split", () => {
    const store = new TodoStore();
    const engine = new TodoEngine(store);

    store.add("a");
    store.add("b");
    store.done("t1");

    expect(engine.countsTail()).toBe("(1 pending, 1 done)");
  });

  test("delta appends counts tail to summary", () => {
    const store = new TodoStore();
    const engine = new TodoEngine(store);
    const a = store.add("only");

    expect(engine.delta(engine.addedSummary(a))).toBe("Added t1: only\n(1 pending, 0 done)");
  });

  test("reminderFingerprint is stable and distinguishes changes", () => {
    const engine = new TodoEngine(new TodoStore());
    const first = engine.reminderFingerprint("Todo list: t1 a");
    const same = engine.reminderFingerprint("Todo list: t1 a");
    const other = engine.reminderFingerprint("Todo list: t1 b");

    expect(first).toBe(same);
    expect(first).not.toBe(other);
  });
});

describe("TodoEngine selectRestoreData", () => {
  test("returns last todos custom entry data", () => {
    const engine = new TodoEngine(new TodoStore());
    const entries: SessionEntryLike[] = [
      { type: "custom", customType: "todos", data: { counter: 1, items: [] } },
      { type: "message", customType: "todos", data: { skip: true } },
      { type: "custom", customType: "todos", data: { counter: 5, items: [] } },
      { type: "custom", customType: "other", data: { skip: true } },
    ];
    const selection = engine.selectRestoreData(entries);

    expect(selection.found).toBe(true);
    expect(selection.data).toEqual({ counter: 5, items: [] });
  });

  test("found false when no matching entry", () => {
    const engine = new TodoEngine(new TodoStore());
    const selection = engine.selectRestoreData([{ type: "custom", customType: "usage", data: {} }]);

    expect(selection.found).toBe(false);
    expect(selection.data).toBeUndefined();
  });
});

describe("TodoMirror path and write", () => {
  test("mirror path uses sha1 of realpath sliced to 12 chars", () => {
    const mirror = new TodoMirror(new TodoStore());
    const dir = mkdtempSync(join(tmpdir(), "todos-"));

    try {
      const path = mirror.mirrorPath(dir);
      const hash = createHash("sha1").update(dir).digest("hex").slice(0, 12);

      expect(path.endsWith(`${hash}.json`)).toBe(true);
      expect(path.includes(join(".pi", "agent", "todos"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mirror path falls back to cwd string for nonexistent path", () => {
    const mirror = new TodoMirror(new TodoStore());
    const bogus = join(tmpdir(), "does-not-exist-xyz-123");
    const path = mirror.mirrorPath(bogus);
    const hash = createHash("sha1").update(bogus).digest("hex").slice(0, 12);

    expect(path.endsWith(`${hash}.json`)).toBe(true);
  });

  test("writeMirror persists project and todos snapshot json", () => {
    const home = mkdtempSync(join(tmpdir(), "todos-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const store = new TodoStore();

      store.add("write me");

      const mirror = new TodoMirror(store);
      const project = mkdtempSync(join(tmpdir(), "todos-proj-"));

      try {
        mirror.writeMirror(project);

        const target = mirror.mirrorPath(project);
        const written = JSON.parse(readFileSync(target, "utf8"));

        expect(written.project).toBe(project);
        expect(written.todos.counter).toBe(1);
        expect(written.todos.items[0].text).toBe("write me");
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      rmSync(home, { recursive: true, force: true });
    }
  });
});
