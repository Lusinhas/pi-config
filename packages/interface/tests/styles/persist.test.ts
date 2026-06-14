import { describe, expect, test } from "bun:test";
import { ActivePersister } from "../../src/styles/persist.ts";

const persister = new ActivePersister();

describe("ActivePersister.build", () => {
  test("null existing produces root with only styles.active", () => {
    const result = persister.build(null, "explanatory");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe(`${JSON.stringify({ styles: { active: "explanatory" } }, null, 2)}\n`);
    }
  });

  test("preserves all existing keys and sections", () => {
    const existing = JSON.stringify({ permissions: { mode: "auto" }, styles: { userDir: "/x" } });
    const result = persister.build(existing, "pragmatic");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.content);
      expect(parsed).toEqual({ permissions: { mode: "auto" }, styles: { userDir: "/x", active: "pragmatic" } });
    }
  });

  test("only mutates styles.active, keeping other styles keys", () => {
    const existing = JSON.stringify({ styles: { active: "old", userDir: "/keep", extra: 1 } });
    const result = persister.build(existing, "new");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.content);
      expect(parsed.styles).toEqual({ active: "new", userDir: "/keep", extra: 1 });
    }
  });

  test("trailing newline appended", () => {
    const result = persister.build(null, "off");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.endsWith("}\n")).toBe(true);
    }
  });

  test("invalid JSON yields parse failure", () => {
    const result = persister.build("{ not json", "x");
    expect(result).toEqual({ ok: false, reason: "parse" });
  });

  test("non-record root (array) yields nonrecord failure", () => {
    const result = persister.build("[1,2,3]", "x");
    expect(result).toEqual({ ok: false, reason: "nonrecord" });
  });

  test("non-record root (scalar) yields nonrecord failure", () => {
    expect(persister.build("42", "x")).toEqual({ ok: false, reason: "nonrecord" });
    expect(persister.build('"str"', "x")).toEqual({ ok: false, reason: "nonrecord" });
  });

  test("non-record styles section is replaced with fresh record", () => {
    const existing = JSON.stringify({ styles: "broken", other: true });
    const result = persister.build(existing, "default");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.content);
      expect(parsed).toEqual({ styles: { active: "default" }, other: true });
    }
  });
});
