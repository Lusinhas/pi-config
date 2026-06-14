import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../../src/credentials/store.ts";

const store = new CredentialStore();

describe("CredentialStore.parse", () => {
  test("accepts claudeAiOauth camelCase blob", () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 123 },
    });

    expect(store.parse(raw)).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 123 });
  });

  test("accepts top-level snake_case blob", () => {
    const raw = JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 456 });

    expect(store.parse(raw)).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 456 });
  });

  test("rejects blob missing fields", () => {
    expect(store.parse(JSON.stringify({ accessToken: "a", refreshToken: "r" }))).toBeNull();
    expect(store.parse(JSON.stringify({ accessToken: "a", expiresAt: 1 }))).toBeNull();
  });

  test("rejects malformed json", () => {
    expect(store.parse("not json")).toBeNull();
  });
});

describe("CredentialStore.writeBack", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auth-creds-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes credentials atomically and preserves other keys", () => {
    const path = join(dir, ".credentials.json");
    writeFileSync(path, JSON.stringify({ other: "keep" }), "utf-8");
    const fileStore = new CredentialStore(path);

    fileStore.writeBack({ accessToken: "a", refreshToken: "r", expiresAt: 789 });

    const written = JSON.parse(readFileSync(path, "utf-8"));

    expect(written.other).toBe("keep");
    expect(written.claudeAiOauth).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 789 });
    expect(fileStore.parse(readFileSync(path, "utf-8"))).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 789,
    });
  });
});
