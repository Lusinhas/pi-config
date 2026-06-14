import { describe, expect, test } from "bun:test";
import { PermissionsService, ENTRY_TYPE } from "../../src/permissions/state.ts";
import { Loader, type PermissionsConfig } from "../../src/permissions/loader.ts";

const config = (overrides: Partial<PermissionsConfig> = {}): PermissionsConfig => ({
  ...Loader.FALLBACK,
  ...overrides,
});

describe("PermissionsService.truncatePreview", () => {
  test("collapses whitespace and trims", () => {
    expect(PermissionsService.truncatePreview("  a   b\nc  ", 80)).toBe("a b c");
  });

  test("clips with ellipsis past the max", () => {
    expect(PermissionsService.truncatePreview("abcdef", 4)).toBe("abc…");
  });

  test("returns as-is at or below max", () => {
    expect(PermissionsService.truncatePreview("abcd", 4)).toBe("abcd");
  });
});

describe("PermissionsService mode lifecycle", () => {
  test("setMode reports whether it changed", () => {
    const service = new PermissionsService(config({ mode: "ask" }));

    expect(service.currentMode()).toBe("ask");
    expect(service.setMode("ask")).toBe(false);
    expect(service.setMode("write")).toBe(true);
    expect(service.currentMode()).toBe("write");
  });

  test("setMode clears session rules and approvals on a real change", () => {
    const service = new PermissionsService(config({ mode: "write" }));

    service.pushSessionRule({ tool: "edit", pattern: "/repo/**" });
    service.recordApproval({ tool: "read", argument: "a.ts" });

    expect(service.setMode("write")).toBe(false);
    expect(service.listApprovals()).toHaveLength(1);

    expect(service.setMode("yolo")).toBe(true);
    expect(service.listApprovals()).toEqual([]);
    expect(service.buildReport()).toContain("session allow rules: (none)");
  });

  test("modeAnnouncement and unknownModeMessage text", () => {
    const service = new PermissionsService(config());

    expect(service.modeAnnouncement("auto")).toBe(
      "permissions mode: auto (a judge model auto-approves actions that are safe and align with your request; everything else still asks)",
    );
    expect(service.unknownModeMessage("zzz")).toBe(
      'permissions: unknown mode "zzz" (valid modes: ask, auto, write, yolo)',
    );
  });

  test("modeCompletions filters by prefix", () => {
    const service = new PermissionsService(config());

    expect(service.modeCompletions("a")?.map((c) => c.value)).toEqual(["ask", "auto"]);
    expect(service.modeCompletions("zzz")).toBeNull();
  });

  test("statusText reflects judge tag", () => {
    expect(new PermissionsService(config()).statusText()).toBe("permissions: ask");
    expect(
      new PermissionsService(config({ judge: { ...Loader.FALLBACK.judge, enabled: true } })).statusText(),
    ).toBe("permissions: ask +judge");
  });
});

describe("PermissionsService.replay", () => {
  test("replays mode and allow entries, ignoring other entries", () => {
    const service = new PermissionsService(config({ mode: "ask" }));
    const entries = [
      { type: "custom", customType: ENTRY_TYPE, data: { kind: "mode", mode: "write" } },
      { type: "custom", customType: ENTRY_TYPE, data: { kind: "allow", rule: { tool: "bash", pattern: "git", prefix: true } } },
      { type: "custom", customType: "other", data: { kind: "mode", mode: "yolo" } },
      { type: "message", data: {} },
      { type: "custom", customType: ENTRY_TYPE, data: { kind: "allow", rule: { tool: "" } } },
    ];

    const mode = service.replay(entries);

    expect(mode).toBe("write");
    expect(service.currentMode()).toBe("write");

    const report = service.buildReport();

    expect(report).toContain('  - tool=bash pattern="git" (prefix)');
  });

  test("invalid mode entries do not change the replayed mode", () => {
    const service = new PermissionsService(config({ mode: "ask" }));
    const mode = service.replay([{ type: "custom", customType: ENTRY_TYPE, data: { kind: "mode", mode: "bogus" } }]);

    expect(mode).toBe("ask");
  });

  test("a clear entry resets the session rules collected so far", () => {
    const service = new PermissionsService(config({ mode: "ask" }));
    const entries = [
      { type: "custom", customType: ENTRY_TYPE, data: { kind: "mode", mode: "write" } },
      { type: "custom", customType: ENTRY_TYPE, data: { kind: "allow", rule: { tool: "bash", pattern: "git", prefix: true } } },
      { type: "custom", customType: ENTRY_TYPE, data: { kind: "clear" } },
      { type: "custom", customType: ENTRY_TYPE, data: { kind: "allow", rule: { tool: "edit", pattern: "src/**" } } },
    ];

    const mode = service.replay(entries);

    expect(mode).toBe("write");

    const report = service.buildReport();

    expect(report).not.toContain('  - tool=bash pattern="git" (prefix)');
    expect(report).toContain('  - tool=edit pattern="src/**"');
  });

  test("a final ask mode clears the replayed session rules", () => {
    const service = new PermissionsService(config({ mode: "ask" }));
    const entries = [
      { type: "custom", customType: ENTRY_TYPE, data: { kind: "allow", rule: { tool: "edit", pattern: "src/**" } } },
      { type: "custom", customType: ENTRY_TYPE, data: { kind: "mode", mode: "ask" } },
    ];

    const mode = service.replay(entries);

    expect(mode).toBe("ask");
    expect(service.buildReport()).toContain("session allow rules: (none)");
  });

  test("reset clears session rules and approvals", () => {
    const service = new PermissionsService(config());

    service.recordApproval({ tool: "read", argument: "a.ts" });
    service.pushSessionRule({ tool: "bash" });
    service.reset();

    expect(service.listApprovals()).toEqual([]);
    expect(service.buildReport()).toContain("session allow rules: (none)");
  });
});

describe("PermissionsService approvals", () => {
  test("records and detects approvals by structured key", () => {
    const service = new PermissionsService(config());
    const approval = { tool: "read", argument: "src a.ts" };

    expect(service.hasApproval(approval)).toBe(false);

    service.recordApproval(approval);

    expect(service.hasApproval(approval)).toBe(true);
    expect(service.hasApproval({ tool: "read", argument: "src a.ts" })).toBe(true);
    expect(service.hasApproval({ tool: "read", argument: "other" })).toBe(false);
  });

  test("listApprovals preserves insertion order", () => {
    const service = new PermissionsService(config());

    service.recordApproval({ tool: "a", argument: "1" });
    service.recordApproval({ tool: "b", argument: "2" });

    expect(service.listApprovals()).toEqual([
      { tool: "a", argument: "1" },
      { tool: "b", argument: "2" },
    ]);
  });

  test("the approval cache is gated by mode", () => {
    const approval = { tool: "edit", argument: "a.ts" };

    const ask = new PermissionsService(config({ mode: "ask" }));
    ask.recordApproval(approval);

    expect(ask.skipApprovalCache()).toBe(true);
    expect(ask.hasApproval(approval)).toBe(true);
    expect(ask.approvalActiveForMode(approval)).toBe(false);

    for (const mode of ["auto", "write", "yolo"] as const) {
      const service = new PermissionsService(config({ mode }));
      service.recordApproval(approval);

      expect(service.skipApprovalCache()).toBe(false);
      expect(service.approvalActiveForMode(approval)).toBe(true);
    }
  });
});

describe("PermissionsService.mapEvaluation", () => {
  test("allow maps to undefined, deny maps to a block, ask is a sentinel", () => {
    const service = new PermissionsService(config());

    expect(service.mapEvaluation({ action: "allow", reason: "r", units: [] })).toBeUndefined();
    expect(service.mapEvaluation({ action: "deny", reason: "deny rule tool=x", units: [] })).toEqual({
      block: true,
      reason: "permissions: blocked by deny rule tool=x",
    });
    expect(service.mapEvaluation({ action: "ask", reason: "r", units: [] })).toBe("ask");
  });
});

describe("PermissionsService.evaluate reflects runtime state", () => {
  test("mode changes and session rules take effect on the next evaluation", () => {
    const service = new PermissionsService(config({ mode: "ask" }));

    expect(service.evaluate("edit", { file_path: "/repo/a.ts" }, "/repo").action).toBe("ask");

    service.setMode("yolo");

    expect(service.evaluate("edit", { file_path: "/repo/a.ts" }, "/repo").action).toBe("allow");

    service.setMode("write");
    service.pushSessionRule({ tool: "edit", pattern: "/repo/**" });

    expect(service.evaluate("edit", { file_path: "/repo/a.ts" }, "/repo").action).toBe("allow");

    service.reset();

    expect(service.evaluate("edit", { file_path: "/repo/a.ts" }, "/repo").action).toBe("ask");

    service.setMode("ask");

    expect(service.evaluate("edit", { file_path: "/repo/a.ts" }, "/repo").action).toBe("ask");
  });
});

describe("PermissionsService judge verdict", () => {
  test("judge gate active when enabled or auto", () => {
    expect(new PermissionsService(config()).judgeGateActive()).toBe(false);
    expect(new PermissionsService(config({ mode: "auto" })).judgeGateActive()).toBe(true);
    expect(
      new PermissionsService(config({ judge: { ...Loader.FALLBACK.judge, enabled: true } })).judgeGateActive(),
    ).toBe(true);
  });

  test("safe verdict within maxRisk approves with notify", () => {
    const service = new PermissionsService(config({ mode: "auto" }));
    const approval = { tool: "bash", argument: "ls" };
    const outcome = service.applyJudgeVerdict(approval, { risk: "safe", reason: "read only" });

    expect(outcome.result).toBeUndefined();
    expect(outcome.approvals).toEqual([approval]);
    expect(outcome.notify).toBe("permissions: judge approved bash (safe: read only)");
  });

  test("risky verdict above maxRisk produces a judge note", () => {
    const service = new PermissionsService(config({ mode: "auto" }));
    const outcome = service.applyJudgeVerdict({ tool: "bash", argument: "rm" }, { risk: "risky", reason: "deletes" });

    expect(outcome.approvals).toEqual([]);
    expect(outcome.judgeNote).toBe("judge: risky (deletes)");
  });

  test("no verdict yields the unavailable note", () => {
    const service = new PermissionsService(config({ mode: "auto" }));
    const outcome = service.applyJudgeVerdict({ tool: "bash", argument: "rm" }, undefined);

    expect(outcome.judgeNote).toBe("judge: unavailable, falling back to manual approval");
  });

  test("risky verdict allowed when maxRisk is risky", () => {
    const service = new PermissionsService(
      config({ mode: "auto", judge: { ...Loader.FALLBACK.judge, maxRisk: "risky" } }),
    );
    const outcome = service.applyJudgeVerdict({ tool: "bash", argument: "rm" }, { risk: "risky", reason: "ok" });

    expect(outcome.approvals).toHaveLength(1);
    expect(outcome.notify).toContain("judge approved");
  });
});

describe("PermissionsService.buildAskPlan and resolveChoice", () => {
  const askEval = { action: "ask" as const, reason: "ask mode default for bash", units: ["rm x"] };

  test("plan header without origin in ask mode omits the always-allow choice", () => {
    const service = new PermissionsService(config());
    const plan = service.buildAskPlan("bash", "rm x", askEval, "", "");

    expect(plan.header).toBe("permissions: allow bash?");
    expect(plan.choices).toEqual(["allow once", "deny"]);
    expect(plan.footer).toEqual(["matched: ask mode default for bash"]);
  });

  test("plan with origin and non-auto mode inserts the auto choice before deny", () => {
    const service = new PermissionsService(config({ mode: "write" }));
    const plan = service.buildAskPlan("bash", "rm x", askEval, "judge: risky (x)", "worker");

    expect(plan.header).toBe('permissions: allow bash from subagent "worker"?');
    expect(plan.choices).toEqual([
      "allow once",
      "always allow this session",
      "allow + switch to auto mode",
      "deny",
    ]);
    expect(plan.choices[plan.choices.length - 2]).toBe("allow + switch to auto mode");
    expect(plan.choices[plan.choices.length - 1]).toBe("deny");
    expect(plan.footer).toEqual(["matched: ask mode default for bash", "judge: risky (x)"]);
  });

  test("plan with origin in ask mode inserts the auto choice just before deny", () => {
    const service = new PermissionsService(config({ mode: "ask" }));
    const plan = service.buildAskPlan("bash", "rm x", askEval, "", "worker");

    expect(plan.choices).toEqual(["allow once", "allow + switch to auto mode", "deny"]);
  });

  test("plan with origin in auto mode omits the auto choice", () => {
    const service = new PermissionsService(config({ mode: "auto" }));
    const plan = service.buildAskPlan("bash", "rm x", askEval, "", "worker");

    expect(plan.choices).toEqual(["allow once", "always allow this session", "deny"]);
  });

  test("allow once approves without entries", () => {
    const service = new PermissionsService(config());
    const plan = service.buildAskPlan("bash", "rm x", askEval, "", "");
    const outcome = service.resolveChoice("bash", plan, askEval, "/repo", "allow once");

    expect(outcome.result).toBeUndefined();
    expect(outcome.approvals).toEqual([{ tool: "bash", argument: "rm x" }]);
    expect(outcome.entries).toEqual([]);
    expect(outcome.switchToAuto).toBe(false);
  });

  test("always allow pushes session rules and entries", () => {
    const service = new PermissionsService(config({ mode: "write" }));
    const plan = service.buildAskPlan("bash", "rm x", askEval, "", "");
    const outcome = service.resolveChoice("bash", plan, askEval, "/repo", "always allow this session");

    expect(outcome.entries).toEqual([{ kind: "allow", rule: { tool: "bash", pattern: "rm", prefix: true } }]);
    expect(outcome.approvals).toEqual([{ tool: "bash", argument: "rm x" }]);
    expect(service.buildReport()).toContain('  - tool=bash pattern="rm" (prefix)');
  });

  test("allow + switch to auto signals the mode change", () => {
    const service = new PermissionsService(config({ mode: "ask" }));
    const plan = service.buildAskPlan("bash", "rm x", askEval, "", "worker");
    const outcome = service.resolveChoice("bash", plan, askEval, "/repo", "allow + switch to auto mode");

    expect(outcome.switchToAuto).toBe(true);
    expect(outcome.approvals).toEqual([{ tool: "bash", argument: "rm x" }]);
  });

  test("deny and dismissed map to the right block reasons", () => {
    const service = new PermissionsService(config());
    const plan = service.buildAskPlan("bash", "rm x", askEval, "", "");

    expect(service.resolveChoice("bash", plan, askEval, "/repo", "deny").result).toEqual({
      block: true,
      reason: "permissions: bash denied by user",
    });
    expect(service.resolveChoice("bash", plan, askEval, "/repo", undefined).result).toEqual({
      block: true,
      reason: "permissions: approval request for bash was dismissed",
    });
  });
});

describe("PermissionsService headless and failure", () => {
  test("headlessAsk respects the policy", () => {
    const evaluation = { action: "ask" as const, reason: "ask mode default for edit", units: [] };

    expect(new PermissionsService(config({ headless: "allow" })).headlessAsk("edit", evaluation)).toBeUndefined();
    expect(new PermissionsService(config({ headless: "deny" })).headlessAsk("edit", evaluation)).toEqual({
      block: true,
      reason:
        "permissions: edit needs approval (ask mode default for edit) and no UI is available; headless policy is deny",
    });
  });

  test("headlessBroker respects the policy", () => {
    expect(new PermissionsService(config({ headless: "allow" })).headlessBroker("edit", "worker")).toBeUndefined();
    expect(new PermissionsService(config({ headless: "deny" })).headlessBroker("edit", "worker")).toEqual({
      block: true,
      reason:
        'permissions: edit from subagent "worker" needs approval and no session is available; headless policy is deny',
    });
  });

  test("failure allows under yolo and blocks otherwise", () => {
    expect(new PermissionsService(config({ mode: "yolo" })).failure("bash", "boom")).toBeUndefined();
    expect(new PermissionsService(config({ mode: "ask" })).failure("bash", "boom")).toEqual({
      block: true,
      reason: "permissions: evaluation failed for bash (boom); blocked under ask mode",
    });
  });
});

describe("PermissionsService.buildReport", () => {
  test("renders the full structured report", () => {
    const service = new PermissionsService(
      config({
        mode: "write",
        deny: [{ tool: "bash", pattern: "rm" }],
        allow: [],
        ask: [{ tool: "edit" }],
      }),
    );

    service.recordApproval({ tool: "read", argument: "a.ts" });

    const report = service.buildReport();

    expect(report).toContain("mode: write (reads, searches, and most tools run freely, writes and bash need approval)");
    expect(report).toContain("judge: disabled");
    expect(report).toContain("headless policy: deny");
    expect(report).toContain("free read tools: read, grep, find, ls, artifact, advisor, ask, todo, astsearch, history");
    expect(report).toContain("gated write tools: write, edit, bash");
    expect(report).toContain("deny rules:");
    expect(report).toContain("  - tool=bash pattern=\"rm\"");
    expect(report).toContain("allow rules: (none)");
    expect(report).toContain("ask rules:");
    expect(report).toContain("session allow rules: (none)");
    expect(report).toContain("session approvals: 1");
    expect(report).toContain("  - read: a.ts");
  });

  test("judge line shows auto-mode origin and truncates approval overflow", () => {
    const service = new PermissionsService(config({ mode: "auto" }));

    for (let i = 0; i < 20; i += 1) {
      service.recordApproval({ tool: "read", argument: `f${i}.ts` });
    }

    const report = service.buildReport();

    expect(report).toContain(
      "judge: active (anthropic/claude-haiku-4-5, auto-approves up to safe, via auto mode)",
    );
    expect(report).toContain("session approvals: 20");
    expect(report).toContain("  … 5 more");
  });

  test("judge line drops the auto-mode suffix when explicitly enabled", () => {
    const service = new PermissionsService(config({ judge: { ...Loader.FALLBACK.judge, enabled: true } }));

    expect(service.buildReport()).toContain("judge: active (anthropic/claude-haiku-4-5, auto-approves up to safe)");
  });

  test("approval with no arguments renders the marker", () => {
    const service = new PermissionsService(config());

    service.recordApproval({ tool: "read", argument: "" });

    expect(service.buildReport()).toContain("  - read: (no arguments)");
  });
});
