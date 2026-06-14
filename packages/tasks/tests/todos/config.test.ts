import { describe, expect, test } from "bun:test";
import { Config, isRecord } from "../../src/todos/config.ts";

const shipped = { mirror: true, widget: true, inject: true, widgetLimit: 8 };

describe("isRecord", () => {
  test("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("Config defaults", () => {
  test("hard defaults match shipped contract", () => {
    expect(Config.hardDefaults()).toEqual({ mirror: true, widget: true, inject: true, widgetLimit: 8 });
  });

  test("defaultConfig reflects shipped values", () => {
    const config = new Config(shipped);

    expect(config.defaultConfig()).toEqual({ mirror: true, widget: true, inject: true, widgetLimit: 8 });
  });

  test("malformed shipped falls back to hard defaults per key", () => {
    const config = new Config({ mirror: "yes", widgetLimit: 0 });

    expect(config.defaultConfig()).toEqual({ mirror: true, widget: true, inject: true, widgetLimit: 8 });
  });
});

describe("Config resolve", () => {
  test("no overrides returns shipped", () => {
    const config = new Config(shipped);

    expect(config.resolve([])).toEqual({ mirror: true, widget: true, inject: true, widgetLimit: 8 });
  });

  test("project override wins over global", () => {
    const config = new Config(shipped);
    const resolved = config.resolve([{ mirror: false }, { mirror: true, widget: false }]);

    expect(resolved.mirror).toBe(true);
    expect(resolved.widget).toBe(false);
  });

  test("invalid scalar values fall back independently", () => {
    const config = new Config(shipped);
    const resolved = config.resolve([{ inject: "no", widgetLimit: -5, widget: 1 }]);

    expect(resolved.inject).toBe(true);
    expect(resolved.widget).toBe(true);
    expect(resolved.widgetLimit).toBe(8);
  });

  test("non-integer and zero widgetLimit reject, positive integer accepted", () => {
    const config = new Config(shipped);

    expect(config.resolve([{ widgetLimit: 3.5 }]).widgetLimit).toBe(8);
    expect(config.resolve([{ widgetLimit: 0 }]).widgetLimit).toBe(8);
    expect(config.resolve([{ widgetLimit: 12 }]).widgetLimit).toBe(12);
  });

  test("explicit booleans honored", () => {
    const config = new Config(shipped);
    const resolved = config.resolve([{ mirror: false, widget: false, inject: false }]);

    expect(resolved).toEqual({ mirror: false, widget: false, inject: false, widgetLimit: 8 });
  });

  test("invalid override falls back to hard default not shipped value", () => {
    const config = new Config({ widgetLimit: 99 });

    expect(config.resolve([{ widgetLimit: 5 }, { widgetLimit: -1 }]).widgetLimit).toBe(8);
    expect(config.resolve([]).widgetLimit).toBe(99);
  });
});
