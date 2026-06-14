import { describe, expect, test } from "bun:test";
import { RulesConfig } from "../../src/rules/settings.ts";

const shipped = {
  formats: { pi: true, claude: true, cursor: true, copilot: true, windsurf: true, cline: true },
  alwaysBudget: 8000,
  scopedBudget: 6000,
};

describe("RulesConfig", () => {
  test("returns shipped defaults with no overrides", () => {
    const settings = new RulesConfig(shipped).resolve([]);

    expect(settings.alwaysBudget).toBe(8000);
    expect(settings.scopedBudget).toBe(6000);
    expect(settings.formats).toEqual({
      pi: true,
      claude: true,
      cursor: true,
      copilot: true,
      windsurf: true,
      cline: true,
    });
  });

  test("missing keys fall back to defaults", () => {
    const settings = new RulesConfig({}).resolve([]);

    expect(settings.alwaysBudget).toBe(8000);
    expect(settings.scopedBudget).toBe(6000);
    expect(settings.formats.pi).toBe(true);
  });

  test("only boolean format flags are accepted", () => {
    const settings = new RulesConfig(shipped).resolve([{ formats: { pi: false, claude: "no", cursor: 1 } }]);

    expect(settings.formats.pi).toBe(false);
    expect(settings.formats.claude).toBe(true);
    expect(settings.formats.cursor).toBe(true);
  });

  test("budget floors finite non-negative numbers", () => {
    const settings = new RulesConfig(shipped).resolve([{ alwaysBudget: 1234.9, scopedBudget: 0 }]);

    expect(settings.alwaysBudget).toBe(1234);
    expect(settings.scopedBudget).toBe(0);
  });

  test("negative, infinite, and non-number budgets fall back", () => {
    const settings = new RulesConfig(shipped).resolve([
      { alwaysBudget: -5, scopedBudget: Number.POSITIVE_INFINITY },
    ]);

    expect(settings.alwaysBudget).toBe(8000);
    expect(settings.scopedBudget).toBe(6000);

    const stringy = new RulesConfig(shipped).resolve([{ alwaysBudget: "100" }]);

    expect(stringy.alwaysBudget).toBe(8000);
  });

  test("project override wins over global override", () => {
    const settings = new RulesConfig(shipped).resolve([
      { alwaysBudget: 100, formats: { pi: false } },
      { alwaysBudget: 200, formats: { pi: true } },
    ]);

    expect(settings.alwaysBudget).toBe(200);
    expect(settings.formats.pi).toBe(true);
  });

  test("deep merge preserves untouched nested keys", () => {
    const settings = new RulesConfig(shipped).resolve([{ formats: { cline: false } }]);

    expect(settings.formats.cline).toBe(false);
    expect(settings.formats.pi).toBe(true);
    expect(settings.formats.windsurf).toBe(true);
  });

  test("non-record formats override is ignored", () => {
    const settings = new RulesConfig(shipped).resolve([{ formats: "all" }]);

    expect(settings.formats.pi).toBe(true);
  });

  test("defaultSettings returns an independent clone", () => {
    const config = new RulesConfig(shipped);
    const a = config.defaultSettings();
    a.formats.pi = false;
    a.alwaysBudget = 1;

    const b = config.defaultSettings();

    expect(b.formats.pi).toBe(true);
    expect(b.alwaysBudget).toBe(8000);
  });
});
