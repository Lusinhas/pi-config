import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuth, TokenStore, parsePasted, type StoredToken } from "../../src/mcp/oauth.ts";

function freshToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    tokenType: "Bearer",
    expiresAt: null,
    tokenEndpoint: "https://auth.test/token",
    clientId: "client-1",
    clientSecret: null,
    resource: "https://api.test",
    scope: null,
    ...overrides,
  };
}

describe("parsePasted", () => {
  test("extracts code from a full redirect URL", () => {
    expect(parsePasted("http://127.0.0.1/callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
  });

  test("extracts code from a bare query string", () => {
    expect(parsePasted("code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
  });

  test("treats a bare token as the code", () => {
    expect(parsePasted("rawcode")).toEqual({ code: "rawcode", state: null });
  });

  test("empty input is null", () => {
    expect(parsePasted("  ")).toBeNull();
  });
});

describe("TokenStore", () => {
  let dir: string;
  let store: TokenStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
    store = new TokenStore(join(dir, "suite.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("save then load roundtrips", () => {
    store.save("srv", freshToken());

    expect(store.load("srv")).toEqual(freshToken());
  });

  test("missing token yields null", () => {
    expect(store.load("none")).toBeNull();
  });

  test("save null deletes the token but keeps the store", () => {
    store.save("a", freshToken());
    store.save("b", freshToken({ accessToken: "b-access" }));
    store.save("a", null);

    expect(store.load("a")).toBeNull();
    expect(store.load("b")?.accessToken).toBe("b-access");
    const root = JSON.parse(readFileSync(join(dir, "suite.json"), "utf8"));

    expect(root.mcp.tokens.b).toBeDefined();
  });

  test("defaults applied to partial stored token", () => {
    store.save("a", freshToken({ tokenType: "", refreshToken: null }));
    const loaded = store.load("a");

    expect(loaded?.tokenType).toBe("Bearer");
    expect(loaded?.refreshToken).toBeNull();
  });
});

describe("OAuth.getAccessToken", () => {
  let dir: string;
  let store: TokenStore;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-oauth-token-"));
    store = new TokenStore(join(dir, "suite.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  test("returns null when no token stored", async () => {
    const oauth = new OAuth(store);

    expect(await oauth.getAccessToken("srv")).toBeNull();
  });

  test("returns access token when not expired", async () => {
    store.save("srv", freshToken({ expiresAt: Date.now() + 100000 }));
    const oauth = new OAuth(store);

    expect(await oauth.getAccessToken("srv")).toBe("access-1");
  });

  test("invalid_grant on refresh deletes the token", async () => {
    store.save("srv", freshToken({ expiresAt: Date.now() - 1 }));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    const oauth = new OAuth(store);

    expect(await oauth.getAccessToken("srv")).toBeNull();
    expect(store.load("srv")).toBeNull();
  });

  test("transient refresh failure also deletes the token", async () => {
    store.save("srv", freshToken({ expiresAt: Date.now() - 1 }));
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const oauth = new OAuth(store);

    expect(await oauth.getAccessToken("srv")).toBeNull();
    expect(store.load("srv")).toBeNull();
  });

  test("successful refresh stores the new token", async () => {
    store.save("srv", freshToken({ expiresAt: Date.now() - 1 }));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "access-2", expires_in: 3600 }), { status: 200 })) as typeof fetch;
    const oauth = new OAuth(store);

    expect(await oauth.getAccessToken("srv")).toBe("access-2");
    expect(store.load("srv")?.accessToken).toBe("access-2");
  });
});
