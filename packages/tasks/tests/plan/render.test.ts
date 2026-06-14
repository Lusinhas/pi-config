import { describe, expect, test } from "bun:test";
import { Render } from "../../src/plan/names.ts";

describe("Render.describeGated", () => {
  test("lists allowed tools when present", () => {
    expect(Render.describeGated(["read", "grep"])).toBe("allowed tools: read, grep");
  });

  test("reports no read-only tools when empty", () => {
    expect(Render.describeGated([])).toBe("no read-only tools available");
  });
});

describe("Render.widgetLines", () => {
  test("renders exactly two lines with the allowed tools", () => {
    expect(Render.widgetLines(["read", "ls"])).toEqual([
      "plan mode: read-only gating active",
      "allowed tools: read, ls",
    ]);
  });

  test("uses none when no tools are gated", () => {
    expect(Render.widgetLines([])).toEqual([
      "plan mode: read-only gating active",
      "allowed tools: none",
    ]);
  });
});

describe("Render notices", () => {
  test("entered notice combines on prefix with the gated description", () => {
    expect(Render.enteredNotice(["read"])).toBe("plan mode on; allowed tools: read");
    expect(Render.enteredNotice([])).toBe("plan mode on; no read-only tools available");
  });

  test("show active notice uses the on phrasing", () => {
    expect(Render.showActiveNotice(["read"])).toBe("plan mode is on; allowed tools: read");
  });

  test("static notices are byte-identical", () => {
    expect(Render.alreadyOnNotice()).toBe("plan mode is already on");
    expect(Render.exitedNotice()).toBe("plan mode off; tool access restored");
    expect(Render.alreadyOffNotice()).toBe("plan mode is already off");
    expect(Render.showInactiveNotice()).toBe("plan mode is off");
    expect(Render.usageNotice()).toBe("usage: /plan [on|off|show]");
  });
});

describe("Render.commandFailedNotice", () => {
  test("falls back to the bare message without a reason", () => {
    expect(Render.commandFailedNotice("")).toBe("plan command failed");
  });

  test("appends the diagnostic reason when present", () => {
    expect(Render.commandFailedNotice("boom")).toBe("plan command failed: boom");
  });
});
