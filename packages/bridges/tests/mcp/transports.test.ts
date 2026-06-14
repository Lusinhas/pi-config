import { describe, expect, test } from "bun:test";
import {
  StderrTail,
  UnauthorizedError,
  coerceJsonRpc,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseJsonRpc,
} from "../../src/mcp/transports.ts";

describe("coerceJsonRpc", () => {
  test("rejects non-records and wrong jsonrpc version", () => {
    expect(coerceJsonRpc(null)).toBeNull();
    expect(coerceJsonRpc([])).toBeNull();
    expect(coerceJsonRpc({ jsonrpc: "1.0", method: "x" })).toBeNull();
  });

  test("parses a request with id and method", () => {
    const message = coerceJsonRpc({ jsonrpc: "2.0", id: 1, method: "ping", params: { a: 1 } });

    expect(message).not.toBeNull();
    expect(isJsonRpcRequest(message!)).toBe(true);
    expect((message as { params: unknown }).params).toEqual({ a: 1 });
  });

  test("treats method without id as a notification", () => {
    const message = coerceJsonRpc({ jsonrpc: "2.0", method: "notifications/x" });

    expect(isJsonRpcNotification(message!)).toBe(true);
  });

  test("array params are dropped", () => {
    const message = coerceJsonRpc({ jsonrpc: "2.0", method: "x", params: [1, 2] });

    expect((message as { params?: unknown }).params).toBeUndefined();
  });

  test("parses success and error responses", () => {
    const ok = coerceJsonRpc({ jsonrpc: "2.0", id: 5, result: { ok: true } });

    expect(isJsonRpcResponse(ok!)).toBe(true);
    expect((ok as { result: unknown }).result).toEqual({ ok: true });

    const err = coerceJsonRpc({ jsonrpc: "2.0", id: 5, error: { code: -32601, message: "nope" } });

    expect((err as { error: { code: number } }).error.code).toBe(-32601);
  });

  test("error with missing fields gets defaults", () => {
    const err = coerceJsonRpc({ jsonrpc: "2.0", id: 1, error: {} });

    expect((err as { error: { code: number; message: string } }).error).toEqual({
      code: 0,
      message: "unknown error",
      data: undefined,
    });
  });

  test("null-id error response is accepted", () => {
    const err = coerceJsonRpc({ jsonrpc: "2.0", id: null, error: { code: 1, message: "x" } });

    expect(err).not.toBeNull();
    expect((err as { id: unknown }).id).toBeNull();
  });
});

describe("parseJsonRpc", () => {
  test("returns null on invalid JSON", () => {
    expect(parseJsonRpc("{not json")).toBeNull();
  });

  test("parses valid JSON-RPC text", () => {
    expect(parseJsonRpc('{"jsonrpc":"2.0","id":1,"result":7}')).not.toBeNull();
  });
});

describe("UnauthorizedError", () => {
  test("carries the www-authenticate header", () => {
    const error = new UnauthorizedError("denied", 'Bearer realm="x"');

    expect(error.name).toBe("UnauthorizedError");
    expect(error.wwwAuthenticate).toBe('Bearer realm="x"');
    expect(error instanceof Error).toBe(true);
  });
});

describe("StderrTail", () => {
  test("keeps only the last N lines", () => {
    const tail = new StderrTail(3);
    tail.push(["a", "b"]);
    tail.push(["c", "d", "e"]);

    expect(tail.length).toBe(3);
    expect(tail.join()).toBe("c | d | e");
  });

  test("zero limit keeps nothing", () => {
    const tail = new StderrTail(0);
    tail.push(["a"]);

    expect(tail.length).toBe(0);
    expect(tail.join()).toBe("");
  });
});
