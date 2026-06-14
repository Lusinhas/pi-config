import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLoader } from "../../src/extension/config.ts";

let home: string;
let cwd: string;

function writeGlobalSuite(value: unknown): void {
  const dir = join(home, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "suite.json"), JSON.stringify(value), "utf-8");
}

function writeProjectSuite(value: unknown): void {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "suite.json"), JSON.stringify(value), "utf-8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "auth-home-"));
  cwd = mkdtempSync(join(tmpdir(), "auth-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("ConfigLoader", () => {
  test("defaults to disabled with long context off", () => {
    expect(new ConfigLoader(cwd, home).load()).toEqual({ enabled: false, longContext: false });
  });

  test("global suite flips enabled on", () => {
    writeGlobalSuite({ auth: { enabled: true } });

    expect(new ConfigLoader(cwd, home).load()).toEqual({ enabled: true, longContext: false });
  });

  test("project suite overrides global suite", () => {
    writeGlobalSuite({ auth: { enabled: true, longContext: true } });
    writeProjectSuite({ auth: { enabled: false } });

    expect(new ConfigLoader(cwd, home).load()).toEqual({ enabled: false, longContext: true });
  });

  test("non-boolean values fall back to the default", () => {
    writeGlobalSuite({ auth: { enabled: "yes", longContext: 1 } });

    expect(new ConfigLoader(cwd, home).load()).toEqual({ enabled: false, longContext: false });
  });
});
