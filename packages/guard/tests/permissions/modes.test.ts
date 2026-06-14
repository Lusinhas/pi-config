import { describe, expect, test } from "bun:test";
import { Modes, MODES } from "../../src/permissions/modes.ts";

describe("Modes", () => {
  test("MODES is the ordered tuple", () => {
    expect([...MODES]).toEqual(["ask", "auto", "write", "yolo"]);
    expect([...Modes.ALL]).toEqual([...MODES]);
  });

  test("is guards every valid value and rejects others", () => {
    for (const mode of MODES) {
      expect(Modes.is(mode)).toBe(true);
    }

    expect(Modes.is("nope")).toBe(false);
    expect(Modes.is("")).toBe(false);
    expect(Modes.is(undefined)).toBe(false);
    expect(Modes.is(42)).toBe(false);
    expect(Modes.is(null)).toBe(false);
  });

  test("next cycles through the tuple", () => {
    expect(Modes.next("ask")).toBe("auto");
    expect(Modes.next("auto")).toBe("write");
    expect(Modes.next("write")).toBe("yolo");
    expect(Modes.next("yolo")).toBe("ask");
  });

  test("describe returns the exact load-bearing strings", () => {
    expect(Modes.describe("ask")).toBe("reads and searches run freely, every other tool call needs approval");
    expect(Modes.describe("auto")).toBe(
      "a judge model auto-approves actions that are safe and align with your request; everything else still asks",
    );
    expect(Modes.describe("write")).toBe("reads, searches, and most tools run freely, writes and bash need approval");
    expect(Modes.describe("yolo")).toBe("everything runs freely except explicit deny rules");
  });

  test("defaultAction for yolo always allows", () => {
    expect(Modes.defaultAction("yolo", "rm", ["read"], ["write"])).toBe("allow");
  });

  test("defaultAction for write asks only on write tools", () => {
    expect(Modes.defaultAction("write", "write", ["read"], ["write", "bash"])).toBe("ask");
    expect(Modes.defaultAction("write", "bash", ["read"], ["write", "bash"])).toBe("ask");
    expect(Modes.defaultAction("write", "read", ["read"], ["write", "bash"])).toBe("allow");
  });

  test("defaultAction for ask and auto allow only read tools", () => {
    expect(Modes.defaultAction("ask", "read", ["read", "grep"], ["write"])).toBe("allow");
    expect(Modes.defaultAction("ask", "edit", ["read", "grep"], ["write"])).toBe("ask");
    expect(Modes.defaultAction("auto", "grep", ["read", "grep"], ["write"])).toBe("allow");
    expect(Modes.defaultAction("auto", "bash", ["read", "grep"], ["write"])).toBe("ask");
  });
});
