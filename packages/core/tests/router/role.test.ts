import { describe, expect, test } from "bun:test";
import { Roles, ROLE_CUSTOM_TYPE, type RolePorts } from "../../src/router/roles.ts";
import type { AgentModel } from "../../src/router/models.ts";

const catalog: AgentModel[] = [
  { id: "claude-opus-4-8", provider: "anthropic", name: "Opus" },
  { id: "claude-haiku-4-5", provider: "anthropic", name: "Haiku" }
];

interface Capture {
  model?: AgentModel;
  thinking?: string;
  emitted: Array<{ role: string; model: string }>;
  appended: Array<{ role: string; model: string }>;
}

function makePorts(overrides: Partial<RolePorts> = {}): { ports: RolePorts; capture: Capture } {
  const capture: Capture = { emitted: [], appended: [] };
  const ports: RolePorts = {
    registry: { getAll: () => catalog },
    currentModel: catalog[1],
    setModel: async (model: AgentModel) => {
      capture.model = model;

      return true;
    },
    setThinkingLevel: (level: string) => {
      capture.thinking = level;
    },
    emitRole: (role: string, model: string) => {
      capture.emitted.push({ role, model });
    },
    appendEntry: (role: string, model: string) => {
      capture.appended.push({ role, model });
    },
    ...overrides
  };

  return { ports, capture };
}

describe("Roles.unknownRole", () => {
  test("no roles configured variant", () => {
    const roles = new Roles({});

    expect(roles.unknownRole("x")).toBe(
      'router: unknown role "x" and no roles are configured (add them under router.roles in suite.json)'
    );
  });

  test("available with close matches both directions", () => {
    const roles = new Roles({ plan: { model: "m" }, planner: { model: "m" }, smol: { model: "m" } });

    expect(roles.unknownRole("plan")).toBe(
      'router: unknown role "plan". Available: plan, planner, smol. Close matches: plan, planner.'
    );
    expect(roles.unknownRole("plan-x")).toBe(
      'router: unknown role "plan-x". Available: plan, planner, smol. Close matches: plan.'
    );
  });

  test("available without close matches", () => {
    const roles = new Roles({ smol: { model: "m" } });

    expect(roles.unknownRole("zzz")).toBe('router: unknown role "zzz". Available: smol.');
  });
});

describe("Roles.applyRole", () => {
  test("success emits, appends when persist, returns active text", async () => {
    const roles = new Roles({ plan: { model: "claude-opus-4-8", thinking: "high" } });
    const { ports, capture } = makePorts();
    const result = await roles.applyRole("plan", ports, true);

    expect(result).toEqual({ ok: true, text: 'router: role "plan" active (anthropic/claude-opus-4-8, thinking high)', model: "anthropic/claude-opus-4-8" });
    expect(capture.thinking).toBe("high");
    expect(capture.emitted).toEqual([{ role: "plan", model: "anthropic/claude-opus-4-8" }]);
    expect(capture.appended).toEqual([{ role: "plan", model: "anthropic/claude-opus-4-8" }]);
    expect(roles.active).toBe("plan");
  });

  test("does not append when persist is false", async () => {
    const roles = new Roles({ smol: { model: "claude-haiku-4-5" } });
    const { ports, capture } = makePorts();
    const result = await roles.applyRole("smol", ports, false);

    expect(result.ok).toBe(true);
    expect(result.text).toBe('router: role "smol" active (anthropic/claude-haiku-4-5)');
    expect(capture.appended).toEqual([]);
  });

  test("unknown role returns failure text and stays inactive", async () => {
    const roles = new Roles({ plan: { model: "m" } });
    const { ports } = makePorts();
    const result = await roles.applyRole("nope", ports, true);

    expect(result.ok).toBe(false);
    expect(result.text.startsWith('router: unknown role "nope".')).toBe(true);
    expect(roles.active).toBeUndefined();
  });

  test("model not in registry surfaces suggestions", async () => {
    const roles = new Roles({ plan: { model: "claude-fake" } });
    const { ports } = makePorts();
    const result = await roles.applyRole("plan", ports, true);

    expect(result.ok).toBe(false);
    expect(result.text).toContain('points at model "claude-fake", which is not in the model registry.');
    expect(result.text).toContain("Close matches:");
  });

  test("setModel throwing surfaces error text", async () => {
    const roles = new Roles({ plan: { model: "claude-opus-4-8" } });
    const { ports } = makePorts({
      setModel: async () => {
        throw new Error("network down");
      }
    });
    const result = await roles.applyRole("plan", ports, true);

    expect(result.text).toBe("router: switching to anthropic/claude-opus-4-8 failed: network down");
  });

  test("agent rejecting the model reports rejection", async () => {
    const roles = new Roles({ plan: { model: "claude-opus-4-8" } });
    const { ports } = makePorts({ setModel: async () => false });
    const result = await roles.applyRole("plan", ports, true);

    expect(result.text).toBe("router: the agent rejected model anthropic/claude-opus-4-8");
  });
});

describe("Roles.renderRoles", () => {
  test("lists roles with active marker and unresolved note", async () => {
    const roles = new Roles({ plan: { model: "claude-opus-4-8", thinking: "high" }, missing: { model: "claude-fake" } });
    const { ports } = makePorts();
    await roles.applyRole("plan", ports, false);
    const text = await roles.renderRoles(ports);

    expect(text).toBe(
      "Roles (* = active, /role <name> switches):\n" +
        "* plan     anthropic/claude-opus-4-8  thinking=high\n" +
        "  missing  claude-fake (not in registry)\n" +
        "Current model: anthropic/claude-haiku-4-5"
    );
  });

  test("no roles configured message", async () => {
    const roles = new Roles({});
    const { ports } = makePorts();

    expect(await roles.renderRoles(ports)).toBe(
      "router: no roles configured (add them under router.roles in suite.json)"
    );
  });
});

describe("Roles.lastRoleFrom", () => {
  test("scans newest first for router:role custom entry via data", () => {
    const roles = new Roles({ plan: { model: "m" } });
    const entries = [
      { type: "custom", customType: ROLE_CUSTOM_TYPE, data: { role: "old" } },
      { type: "custom", customType: ROLE_CUSTOM_TYPE, data: { role: "plan" } }
    ];

    expect(roles.lastRoleFrom(entries)).toBe("plan");
  });

  test("accepts details when data is absent", () => {
    const roles = new Roles({});
    const entries = [{ type: "custom", customType: ROLE_CUSTOM_TYPE, details: { role: "review" } }];

    expect(roles.lastRoleFrom(entries)).toBe("review");
  });

  test("ignores other entry types and blank roles", () => {
    const roles = new Roles({});
    const entries = [
      { type: "custom", customType: "other", data: { role: "x" } },
      { type: "message", data: { role: "y" } },
      { type: "custom", customType: ROLE_CUSTOM_TYPE, data: { role: "   " } }
    ];

    expect(roles.lastRoleFrom(entries)).toBeUndefined();
  });

  test("non-array returns undefined", () => {
    const roles = new Roles({});

    expect(roles.lastRoleFrom(undefined)).toBeUndefined();
    expect(roles.lastRoleFrom("x")).toBeUndefined();
  });
});
