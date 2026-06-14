import { describe, expect, test } from "bun:test";
import { TodoStore } from "../../src/todos/index.ts";
import { compareItems, idRank, StoredItemParser } from "../../src/todos/store.ts";

describe("idRank", () => {
  test("parses numeric tN ids", () => {
    expect(idRank("t1")).toBe(1);
    expect(idRank("t42")).toBe(42);
  });

  test("non-matching ids rank as MAX_SAFE_INTEGER", () => {
    expect(idRank("x")).toBe(Number.MAX_SAFE_INTEGER);
    expect(idRank("t")).toBe(Number.MAX_SAFE_INTEGER);
    expect(idRank("ta")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("compareItems", () => {
  const make = (id: string, priority: "high" | "medium" | "low") => ({
    id,
    text: "x",
    status: "open" as const,
    deps: [] as string[],
    priority,
    created: 0,
    updated: 0,
  });

  test("orders by priority then idRank then localeCompare", () => {
    expect(compareItems(make("t2", "high"), make("t1", "low"))).toBeLessThan(0);
    expect(compareItems(make("t1", "medium"), make("t2", "medium"))).toBeLessThan(0);
    expect(compareItems(make("zzz", "low"), make("aaa", "low"))).toBeGreaterThan(0);
  });
});

describe("TodoStore add", () => {
  test("generates sequential ids and defaults", () => {
    const store = new TodoStore();
    const a = store.add("first");
    const b = store.add("second");

    expect(a.id).toBe("t1");
    expect(b.id).toBe("t2");
    expect(a.priority).toBe("medium");
    expect(a.status).toBe("open");
    expect(a.created).toBe(a.updated);
  });

  test("trims text and rejects empty", () => {
    const store = new TodoStore();
    const item = store.add("  hello  ");

    expect(item.text).toBe("hello");
    expect(() => store.add("   ")).toThrow("todo text must not be empty");
  });

  test("counter only advances on successful add", () => {
    const store = new TodoStore();

    store.add("a");
    expect(() => store.add("", undefined)).toThrow();

    const next = store.add("b");

    expect(next.id).toBe("t2");
  });

  test("rejects self dependency", () => {
    const store = new TodoStore();

    expect(() => store.add("x", ["t1"])).toThrow("todo t1 cannot depend on itself");
  });

  test("rejects unknown dependency id", () => {
    const store = new TodoStore();

    store.add("a");
    expect(() => store.add("b", ["t9"])).toThrow('unknown dependency id "t9"');
  });

  test("dedups duplicate deps", () => {
    const store = new TodoStore();
    const a = store.add("a");

    expect(() => store.add("b", [a.id, a.id])).not.toThrow();
    expect(store.get("t2")?.deps).toEqual(["t1"]);
  });

  test("derives blocked status from unfinished deps", () => {
    const store = new TodoStore();
    const a = store.add("dep");
    const b = store.add("waits", [a.id]);

    expect(b.status).toBe("blocked");

    store.done(a.id);
    expect(store.get(b.id)?.status).toBe("open");
  });
});

describe("TodoStore add with status", () => {
  test("applying non-open status mutates updated timestamp", async () => {
    const store = new TodoStore();
    const item = store.add("x");

    expect(item.created).toBe(item.updated);

    const updated = store.update(item.id, { status: "active" });

    expect(updated.status).toBe("active");
    expect(updated.updated).toBeGreaterThanOrEqual(updated.created);
  });
});

describe("TodoStore update", () => {
  test("requires at least one field", () => {
    const store = new TodoStore();
    const a = store.add("a");

    expect(() => store.update(a.id, {})).toThrow("update requires at least one of text, status, deps, priority");
  });

  test("updates fields and rejects empty text", () => {
    const store = new TodoStore();
    const a = store.add("a");

    const updated = store.update(a.id, { text: "renamed", priority: "high" });

    expect(updated.text).toBe("renamed");
    expect(updated.priority).toBe("high");
    expect(() => store.update(a.id, { text: "   " })).toThrow("todo text must not be empty");
  });

  test("rejects unknown id with known ids hint", () => {
    const store = new TodoStore();

    store.add("a");
    expect(() => store.update("t99", { text: "x" })).toThrow('no todo with id "t99" (known ids: t1)');
  });

  test("empty store known hint", () => {
    const store = new TodoStore();

    expect(() => store.done("t1")).toThrow('no todo with id "t1" (the todo list is empty)');
  });
});

describe("TodoStore cycle rejection", () => {
  test("direct cycle rejected", () => {
    const store = new TodoStore();
    const a = store.add("a");
    const b = store.add("b", [a.id]);

    expect(() => store.update(a.id, { deps: [b.id] })).toThrow(/dependency cycle rejected: t1 -> t2 -> t1/);
  });

  test("transitive cycle rejected", () => {
    const store = new TodoStore();
    const a = store.add("a");
    const b = store.add("b", [a.id]);
    const c = store.add("c", [b.id]);

    expect(() => store.update(a.id, { deps: [c.id] })).toThrow(/dependency cycle rejected/);
  });
});

describe("TodoStore done remove counts", () => {
  test("done sets terminal status", () => {
    const store = new TodoStore();
    const a = store.add("a");

    expect(store.done(a.id).status).toBe("done");
  });

  test("remove strips id from other deps and touches updated", () => {
    const store = new TodoStore();
    const a = store.add("a");
    const b = store.add("b", [a.id]);

    store.remove(a.id);

    const remaining = store.get(b.id);

    expect(remaining?.deps).toEqual([]);
    expect(store.size()).toBe(1);
  });

  test("counts splits done vs open including blocked", () => {
    const store = new TodoStore();
    const a = store.add("a");
    const b = store.add("b", [a.id]);

    expect(store.counts()).toEqual({ open: 2, done: 0 });

    store.done(a.id);
    expect(store.counts()).toEqual({ open: 1, done: 1 });
  });

  test("counts open equals list filtered non-done length", () => {
    const store = new TodoStore();

    store.add("a");
    store.add("b");
    store.done("t1");

    const counts = store.counts();
    const open = store.list().filter((item) => item.status !== "done").length;
    const done = store.list().length - open;

    expect(counts.open).toBe(open);
    expect(counts.done).toBe(done);
  });
});

describe("TodoStore list and snapshot", () => {
  test("deterministic order by priority", () => {
    const store = new TodoStore();

    store.add("low one", undefined, "low");
    store.add("high one", undefined, "high");
    store.add("med one", undefined, "medium");

    const ids = store.list().map((item) => item.id);

    expect(ids).toEqual(["t2", "t3", "t1"]);
  });

  test("snapshot carries counter and derived items", () => {
    const store = new TodoStore();
    const a = store.add("a");

    store.add("b", [a.id]);

    const snap = store.snapshot();

    expect(snap.counter).toBe(2);
    expect(snap.items.find((item) => item.id === "t2")?.status).toBe("blocked");
  });

  test("list cache invalidated after mutation", () => {
    const store = new TodoStore();

    store.add("a");
    expect(store.list().length).toBe(1);

    store.add("b");
    expect(store.list().length).toBe(2);
  });

  test("counts cache invalidated after done", () => {
    const store = new TodoStore();

    store.add("a");
    store.add("b");
    expect(store.counts()).toEqual({ open: 2, done: 0 });

    store.done("t1");
    expect(store.counts()).toEqual({ open: 1, done: 1 });
  });

  test("cached list returns stable reference until mutation", () => {
    const store = new TodoStore();

    store.add("a");

    const first = store.list();
    const second = store.list();

    expect(second).toBe(first);

    store.add("b");
    expect(store.list()).not.toBe(first);
  });
});

describe("TodoStore clear", () => {
  test("clear returns removed count and empties", () => {
    const store = new TodoStore();

    store.add("a");
    store.add("b");

    expect(store.clear()).toBe(2);
    expect(store.size()).toBe(0);
  });
});

describe("StoredItemParser", () => {
  const parser = new StoredItemParser();

  test("rejects non-object and missing fields", () => {
    expect(parser.parse(null)).toBeNull();
    expect(parser.parse([])).toBeNull();
    expect(parser.parse({ id: "", text: "x" })).toBeNull();
    expect(parser.parse({ id: "t1", text: "  " })).toBeNull();
  });

  test("coerces invalid status and priority to defaults", () => {
    const item = parser.parse({ id: "t1", text: "x", status: "weird", priority: "urgent" });

    expect(item?.status).toBe("open");
    expect(item?.priority).toBe("medium");
  });

  test("dedups and trims deps", () => {
    const item = parser.parse({ id: "t1", text: "x", deps: [" t2 ", "t2", "", 5] });

    expect(item?.deps).toEqual(["t2"]);
  });

  test("defaults created and updated", () => {
    const item = parser.parse({ id: "t1", text: "x" });

    expect(typeof item?.created).toBe("number");
    expect(item?.updated).toBe(item?.created);
  });
});

describe("TodoStore restore", () => {
  test("rejects non-object, array, and missing items", () => {
    const store = new TodoStore();

    expect(store.restore(null)).toBe(false);
    expect(store.restore([])).toBe(false);
    expect(store.restore({ counter: 1 })).toBe(false);
  });

  test("restores items, dedups by id first-wins, sets counter to max", () => {
    const store = new TodoStore();
    const ok = store.restore({
      counter: 2,
      items: [
        { id: "t5", text: "five" },
        { id: "t5", text: "dup ignored" },
        { id: "t3", text: "three" },
      ],
    });

    expect(ok).toBe(true);
    expect(store.size()).toBe(2);
    expect(store.get("t5")?.text).toBe("five");

    const next = store.add("new");

    expect(next.id).toBe("t6");
  });

  test("counter fallback to highest id when counter invalid", () => {
    const store = new TodoStore();

    store.restore({ counter: -3, items: [{ id: "t9", text: "x" }] });
    expect(store.add("z").id).toBe("t10");
  });

  test("drops self and nonexistent deps", () => {
    const store = new TodoStore();

    store.restore({ counter: 0, items: [{ id: "t1", text: "a", deps: ["t1", "t9"] }] });
    expect(store.get("t1")?.deps).toEqual([]);
  });

  test("breaks a two-node cycle by clearing the first encountered item only", () => {
    const store = new TodoStore();

    store.restore({
      counter: 0,
      items: [
        { id: "t1", text: "a", deps: ["t2"] },
        { id: "t2", text: "b", deps: ["t1"] },
        { id: "t3", text: "c", deps: ["t1"] },
      ],
    });

    expect(store.get("t1")?.deps).toEqual([]);
    expect(store.get("t2")?.deps).toEqual(["t1"]);
    expect(store.get("t3")?.deps).toEqual(["t1"]);
  });

  test("breaks a three-node cycle by clearing only the first item that still cycles", () => {
    const store = new TodoStore();

    store.restore({
      counter: 0,
      items: [
        { id: "t1", text: "a", deps: ["t2"] },
        { id: "t2", text: "b", deps: ["t3"] },
        { id: "t3", text: "c", deps: ["t1"] },
      ],
    });

    expect(store.get("t1")?.deps).toEqual([]);
    expect(store.get("t2")?.deps).toEqual(["t3"]);
    expect(store.get("t3")?.deps).toEqual(["t1"]);
  });

  test("two independent cycles each lose their first member", () => {
    const store = new TodoStore();

    store.restore({
      counter: 0,
      items: [
        { id: "t1", text: "a", deps: ["t2"] },
        { id: "t2", text: "b", deps: ["t1"] },
        { id: "t3", text: "c", deps: ["t4"] },
        { id: "t4", text: "d", deps: ["t3"] },
      ],
    });

    expect(store.get("t1")?.deps).toEqual([]);
    expect(store.get("t2")?.deps).toEqual(["t1"]);
    expect(store.get("t3")?.deps).toEqual([]);
    expect(store.get("t4")?.deps).toEqual(["t3"]);
  });
});
