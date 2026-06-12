import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HTTP_TIMEOUT_MS = 15000;
const EXPIRY_SKEW_MS = 30000;
const FALLBACK_REDIRECT = "http://127.0.0.1:33418/callback";

export interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: number | null;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  resource: string;
  scope: string | null;
}

export interface AuthUi {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
}

interface AuthCode {
  code: string;
  state: string | null;
}

interface Loopback {
  redirectUri: string;
  wait: Promise<AuthCode | null>;
  close: () => void;
}

interface OauthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  resource: string;
  scope: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storePath(): string {
  return join(homedir(), ".pi", "agent", "piconfig.json");
}

function readStoreRoot(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoreRoot(root: Record<string, unknown>): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

function tokensOf(root: Record<string, unknown>): Record<string, unknown> {
  const mcp = isRecord(root.mcp) ? root.mcp : {};
  return isRecord(mcp.tokens) ? mcp.tokens : {};
}

export function loadToken(name: string): StoredToken | null {
  const raw = tokensOf(readStoreRoot())[name];
  if (!isRecord(raw) || typeof raw.accessToken !== "string" || raw.accessToken === "") return null;
  return {
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === "string" && raw.refreshToken !== "" ? raw.refreshToken : null,
    tokenType: typeof raw.tokenType === "string" && raw.tokenType !== "" ? raw.tokenType : "Bearer",
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : null,
    tokenEndpoint: typeof raw.tokenEndpoint === "string" ? raw.tokenEndpoint : "",
    clientId: typeof raw.clientId === "string" ? raw.clientId : "",
    clientSecret: typeof raw.clientSecret === "string" ? raw.clientSecret : null,
    resource: typeof raw.resource === "string" ? raw.resource : "",
    scope: typeof raw.scope === "string" && raw.scope !== "" ? raw.scope : null,
  };
}

export function saveToken(name: string, token: StoredToken | null): void {
  try {
    const root = readStoreRoot();
    const mcp = isRecord(root.mcp) ? root.mcp : {};
    const tokens = isRecord(mcp.tokens) ? mcp.tokens : {};
    if (token === null) delete tokens[name];
    else tokens[name] = { ...token };
    mcp.tokens = tokens;
    root.mcp = mcp;
    writeStoreRoot(root);
  } catch {
    return;
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.text().catch(() => "");
      return null;
    }
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function joinPath(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

async function discoverEndpoints(serverUrl: string, wwwAuthenticate: string | null): Promise<OauthEndpoints> {
  const base = new URL(serverUrl);
  let resourceMeta: Record<string, unknown> | null = null;
  const headerMatch = wwwAuthenticate !== null ? /resource_metadata="([^"]+)"/.exec(wwwAuthenticate) : null;
  if (headerMatch !== null) resourceMeta = await fetchJson(headerMatch[1]);
  if (resourceMeta === null) {
    const path = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
    resourceMeta =
      (await fetchJson(`${base.origin}/.well-known/oauth-protected-resource${path}`)) ??
      (await fetchJson(`${base.origin}/.well-known/oauth-protected-resource`));
  }
  let authServer = base.origin;
  let resource = `${base.origin}${base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "")}`;
  let scope: string | null = null;
  const headerScope = wwwAuthenticate !== null ? /scope="([^"]+)"/.exec(wwwAuthenticate) : null;
  if (headerScope !== null) scope = headerScope[1];
  if (resourceMeta !== null) {
    if (Array.isArray(resourceMeta.authorization_servers)) {
      const first = resourceMeta.authorization_servers.find((entry) => typeof entry === "string" && entry !== "");
      if (typeof first === "string") authServer = first;
    }
    if (typeof resourceMeta.resource === "string" && resourceMeta.resource !== "") resource = resourceMeta.resource;
    if (scope === null && Array.isArray(resourceMeta.scopes_supported)) {
      const scopes = resourceMeta.scopes_supported.filter((entry) => typeof entry === "string" && entry !== "");
      if (scopes.length > 0) scope = scopes.join(" ");
    }
  }
  let asUrl: URL;
  try {
    asUrl = new URL(authServer);
  } catch {
    asUrl = base;
    authServer = base.origin;
  }
  const asPath = asUrl.pathname === "/" ? "" : asUrl.pathname.replace(/\/+$/, "");
  const candidates = [
    `${asUrl.origin}/.well-known/oauth-authorization-server${asPath}`,
    `${asUrl.origin}${asPath}/.well-known/oauth-authorization-server`,
    `${asUrl.origin}/.well-known/openid-configuration${asPath}`,
    `${asUrl.origin}${asPath}/.well-known/openid-configuration`,
  ];
  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    const meta = await fetchJson(candidate);
    if (
      meta !== null &&
      typeof meta.authorization_endpoint === "string" &&
      meta.authorization_endpoint !== "" &&
      typeof meta.token_endpoint === "string" &&
      meta.token_endpoint !== ""
    ) {
      if (scope === null && Array.isArray(meta.scopes_supported)) {
        const scopes = meta.scopes_supported.filter((entry) => typeof entry === "string" && entry !== "");
        if (scopes.length > 0) scope = scopes.join(" ");
      }
      return {
        authorizationEndpoint: meta.authorization_endpoint,
        tokenEndpoint: meta.token_endpoint,
        registrationEndpoint:
          typeof meta.registration_endpoint === "string" && meta.registration_endpoint !== ""
            ? meta.registration_endpoint
            : null,
        resource,
        scope,
      };
    }
  }
  return {
    authorizationEndpoint: joinPath(authServer, "authorize"),
    tokenEndpoint: joinPath(authServer, "token"),
    registrationEndpoint: joinPath(authServer, "register"),
    resource,
    scope,
  };
}

async function tokenRequest(
  endpoint: string,
  fields: Record<string, string>,
  clientSecret: string | null,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(fields);
  if (clientSecret !== null) body.set("client_secret", clientSecret);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const record = isRecord(parsed) ? parsed : {};
    const detail =
      typeof record.error_description === "string"
        ? record.error_description
        : typeof record.error === "string"
          ? record.error
          : text.slice(0, 200);
    throw new Error(`token request failed (HTTP ${response.status}): ${detail}`);
  }
  if (!isRecord(parsed)) throw new Error("token endpoint returned a non-JSON response");
  return parsed;
}

function buildStoredToken(
  response: Record<string, unknown>,
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string | null,
  resource: string,
  scope: string | null,
  previousRefreshToken: string | null,
): StoredToken {
  if (typeof response.access_token !== "string" || response.access_token === "") {
    throw new Error("token endpoint did not return an access_token");
  }
  const expiresIn = typeof response.expires_in === "number" && response.expires_in > 0 ? response.expires_in : null;
  return {
    accessToken: response.access_token,
    refreshToken:
      typeof response.refresh_token === "string" && response.refresh_token !== ""
        ? response.refresh_token
        : previousRefreshToken,
    tokenType: typeof response.token_type === "string" && response.token_type !== "" ? response.token_type : "Bearer",
    expiresAt: expiresIn !== null ? Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS : null,
    tokenEndpoint,
    clientId,
    clientSecret,
    resource,
    scope: typeof response.scope === "string" && response.scope !== "" ? response.scope : scope,
  };
}

async function refreshStoredToken(name: string, token: StoredToken): Promise<StoredToken | null> {
  if (token.refreshToken === null || token.tokenEndpoint === "" || token.clientId === "") return null;
  try {
    const fields: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: token.clientId,
    };
    if (token.resource !== "") fields.resource = token.resource;
    if (token.scope !== null) fields.scope = token.scope;
    const response = await tokenRequest(token.tokenEndpoint, fields, token.clientSecret);
    const refreshed = buildStoredToken(
      response,
      token.tokenEndpoint,
      token.clientId,
      token.clientSecret,
      token.resource,
      token.scope,
      token.refreshToken,
    );
    saveToken(name, refreshed);
    return refreshed;
  } catch {
    saveToken(name, null);
    return null;
  }
}

export async function getAccessToken(name: string): Promise<string | null> {
  const token = loadToken(name);
  if (token === null) return null;
  if (token.expiresAt !== null && Date.now() >= token.expiresAt) {
    const refreshed = await refreshStoredToken(name, token);
    return refreshed !== null ? refreshed.accessToken : null;
  }
  return token.accessToken;
}

async function registerClient(
  endpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const body = {
    client_name: "pi-config-mcp",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`dynamic client registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok || !isRecord(parsed) || typeof parsed.client_id !== "string" || parsed.client_id === "") {
    throw new Error(`dynamic client registration failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  return {
    clientId: parsed.client_id,
    clientSecret: typeof parsed.client_secret === "string" && parsed.client_secret !== "" ? parsed.client_secret : null,
  };
}

function startLoopback(): Promise<Loopback | null> {
  return new Promise((resolve) => {
    let settle: (value: AuthCode | null) => void = () => undefined;
    const wait = new Promise<AuthCode | null>((res) => {
      settle = res;
    });
    const server = createServer((request, response) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        response.statusCode = 400;
        response.end("bad request");
        return;
      }
      if (url.pathname !== "/callback") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      response.setHeader("content-type", "text/html");
      if (code !== null && code !== "") {
        response.end("<html><body><p>Authorization received. You can close this tab and return to pi.</p></body></html>");
        settle({ code, state: url.searchParams.get("state") });
      } else {
        const errorParam = url.searchParams.get("error") ?? "unknown error";
        response.end(`<html><body><p>Authorization failed: ${errorParam}. Return to pi and try again.</p></body></html>`);
        settle(null);
      }
    });
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        try {
          server.close();
        } catch {
          void 0;
        }
        resolve(null);
        return;
      }
      server.unref();
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        wait,
        close: () => {
          try {
            server.close();
          } catch {
            return;
          }
        },
      });
    });
  });
}

function parsePasted(text: string): AuthCode | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (code !== null && code !== "") return { code, state: url.searchParams.get("state") };
    return null;
  } catch {
    void 0;
  }
  if (trimmed.includes("code=")) {
    const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed;
    const params = new URLSearchParams(query);
    const code = params.get("code");
    if (code !== null && code !== "") return { code, state: params.get("state") };
    return null;
  }
  return { code: trimmed, state: null };
}

function waitForGrant(
  loopback: Loopback | null,
  manual: Promise<AuthCode | null>,
  timeoutMs: number,
): Promise<AuthCode | null> {
  return new Promise((resolve) => {
    let done = false;
    let remaining = loopback !== null ? 2 : 1;
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    const finish = (value: AuthCode | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const accept = (value: AuthCode | null): void => {
      if (value !== null) {
        finish(value);
        return;
      }
      remaining -= 1;
      if (remaining <= 0) finish(null);
    };
    if (loopback !== null) void loopback.wait.then(accept, () => accept(null));
    void manual.then(accept, () => accept(null));
  });
}

export async function authorize(
  name: string,
  serverUrl: string,
  wwwAuthenticate: string | null,
  ctx: AuthUi,
  timeoutMs: number,
): Promise<StoredToken> {
  if (!ctx.hasUI) throw new Error("MCP OAuth authorization requires an interactive session");
  const endpoints = await discoverEndpoints(serverUrl, wwwAuthenticate);
  const loopback = await startLoopback();
  const redirectUri = loopback !== null ? loopback.redirectUri : FALLBACK_REDIRECT;
  let clientId: string;
  let clientSecret: string | null = null;
  if (endpoints.registrationEndpoint !== null) {
    const registered = await registerClient(endpoints.registrationEndpoint, redirectUri);
    clientId = registered.clientId;
    clientSecret = registered.clientSecret;
  } else {
    const stored = loadToken(name);
    if (stored !== null && stored.clientId !== "") {
      clientId = stored.clientId;
      clientSecret = stored.clientSecret;
    } else {
      loopback?.close();
      throw new Error(
        `the authorization server for "${name}" does not offer dynamic client registration and no stored client exists`,
      );
    }
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", endpoints.resource);
  if (endpoints.scope !== null) authUrl.searchParams.set("scope", endpoints.scope);
  ctx.ui.notify(`Open this URL in your browser to authorize MCP server "${name}":\n${authUrl.toString()}`, "info");
  const manual = ctx.ui
    .input(`MCP auth: ${name}`, "paste the redirect URL or authorization code")
    .then((value) => (value === undefined || value.trim() === "" ? null : parsePasted(value)));
  const granted = await waitForGrant(loopback, manual, timeoutMs);
  loopback?.close();
  if (granted === null) throw new Error("authorization was not completed before the timeout");
  if (granted.state !== null && granted.state !== state) throw new Error("authorization state mismatch; aborting");
  const response = await tokenRequest(
    endpoints.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: granted.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: endpoints.resource,
    },
    clientSecret,
  );
  const token = buildStoredToken(
    response,
    endpoints.tokenEndpoint,
    clientId,
    clientSecret,
    endpoints.resource,
    endpoints.scope,
    null,
  );
  saveToken(name, token);
  return token;
}
