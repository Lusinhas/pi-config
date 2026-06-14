import { describe, expect, test } from "bun:test";
import { Store } from "../../src/plan/store.ts";

describe("Store constants", () => {
  test("entry type strings are byte-identical to the contract", () => {
    expect(Store.STATETYPE).toBe("piconfig:plan:state");
    expect(Store.APPROVEDTYPE).toBe("piconfig:plan:approved");
  });
});

describe("Store.onlyStrings", () => {
  test("returns empty for non-arrays", () => {
    expect(Store.onlyStrings("x")).toEqual([]);
    expect(Store.onlyStrings(null)).toEqual([]);
    expect(Store.onlyStrings({})).toEqual([]);
  });

  test("keeps non-empty strings, dedups, preserves order, does not trim", () => {
    expect(Store.onlyStrings([" a", "a", "", "b", 5, "b"])).toEqual([" a", "a", "b"]);
  });
});

describe("Store.readPersisted", () => {
  test("returns undefined when entries is not an array", () => {
    expect(Store.readPersisted("nope")).toBeUndefined();
    expect(Store.readPersisted(null)).toBeUndefined();
  });

  test("returns undefined when no matching custom entry exists", () => {
    const entries = [
      { type: "message", role: "assistant" },
      { type: "custom", customType: "other", data: { active: true } },
    ];

    expect(Store.readPersisted(entries)).toBeUndefined();
  });

  test("ignores entries with non-object data", () => {
    const entries = [{ type: "custom", customType: Store.STATETYPE, data: [1, 2] }];

    expect(Store.readPersisted(entries)).toBeUndefined();
  });

  test("parses the latest matching state entry", () => {
    const entries = [
      { type: "custom", customType: Store.STATETYPE, data: { active: true, snapshot: ["a"], gated: ["a"] } },
      {
        type: "custom",
        customType: Store.STATETYPE,
        data: { active: true, snapshot: ["read", "grep", ""], gated: ["read"] },
      },
    ];

    expect(Store.readPersisted(entries)).toEqual({ active: true, snapshot: ["read", "grep"], gated: ["read"] });
  });

  test("coerces missing active to false and missing arrays to empty", () => {
    const entries = [{ type: "custom", customType: Store.STATETYPE, data: { snapshot: 9 } }];

    expect(Store.readPersisted(entries)).toEqual({ active: false, snapshot: [], gated: [] });
  });

  test("active is only true for an exact boolean true", () => {
    const entries = [{ type: "custom", customType: Store.STATETYPE, data: { active: "true" } }];

    expect(Store.readPersisted(entries)?.active).toBe(false);
  });
});

describe("Store.stateEntry", () => {
  test("clones arrays and includes an iso timestamp", () => {
    const snapshot = ["read"];
    const gated = ["read", "grep"];
    const entry = Store.stateEntry(snapshot, gated, true) as {
      active: boolean;
      snapshot: string[];
      gated: string[];
      at: string;
    };

    expect(entry.active).toBe(true);
    expect(entry.snapshot).toEqual(["read"]);
    expect(entry.snapshot).not.toBe(snapshot);
    expect(entry.gated).toEqual(["read", "grep"]);
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  });
});

describe("Store.approvedEntry", () => {
  test("carries text and an iso approvedAt", () => {
    const entry = Store.approvedEntry("the plan") as { text: string; approvedAt: string };

    expect(entry.text).toBe("the plan");
    expect(Number.isNaN(Date.parse(entry.approvedAt))).toBe(false);
  });
});
