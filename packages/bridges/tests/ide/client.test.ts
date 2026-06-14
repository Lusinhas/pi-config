import { describe, expect, test } from "bun:test";
import { parseDiagnosticsResponse, parseDiffApprovalResponse, parseEditorContext } from "../../src/ide/contract.ts";
import { canReviewDiff, isAlive, readConnectionFromEnv, retryBackoffMs, workspaceScore } from "../../src/ide/index.ts";

describe("parseEditorContext", () => {
  test("flatMaps valid open files and gates isTrusted", () => {
    const raw = JSON.stringify({
      isTrusted: true,
      openFiles: [
        { path: "/a.ts", timestamp: 5, isActive: true, selectedText: "x", cursor: { line: 2, character: 3 } },
        { path: "/b.ts" },
      ],
    });
    const context = parseEditorContext(raw);

    expect(context?.isTrusted).toBe(true);
    expect(context?.openFiles.length).toBe(2);
    expect(context?.openFiles[0]).toEqual({ path: "/a.ts", timestamp: 5, isActive: true, selectedText: "x", cursor: { line: 2, character: 3 } });
    expect(context?.openFiles[1]).toEqual({ path: "/b.ts", timestamp: 0, isActive: false, selectedText: undefined, cursor: undefined });
  });

  test("isTrusted defaults to false when not strictly true", () => {
    const context = parseEditorContext(JSON.stringify({ isTrusted: "yes", openFiles: [] }));

    expect(context?.isTrusted).toBe(false);
    expect(context?.openFiles).toEqual([]);
  });

  test("drops files without a string path and partial cursors", () => {
    const raw = JSON.stringify({
      openFiles: [
        { timestamp: 1 },
        { path: "/c.ts", cursor: { line: 1 } },
      ],
    });
    const context = parseEditorContext(raw);

    expect(context?.openFiles.length).toBe(1);
    expect(context?.openFiles[0].cursor).toBeUndefined();
  });

  test("malformed input yields undefined", () => {
    expect(parseEditorContext("not json")).toBeUndefined();
    expect(parseEditorContext(JSON.stringify([1, 2]))).toBeUndefined();
  });
});

describe("parseDiagnosticsResponse", () => {
  test("keeps only error and warning severities", () => {
    const response = {
      files: [
        {
          path: "/a.ts",
          diagnostics: [
            { severity: "error", message: "boom", line: 1, character: 2, source: "ts", code: "1009" },
            { severity: "warning", message: "careful", line: 3, character: 0 },
            { severity: "hint", message: "tip", line: 5, character: 1 },
            { severity: "info", message: "fyi", line: 6, character: 1 },
          ],
        },
      ],
    };
    const parsed = parseDiagnosticsResponse(response);

    expect(parsed?.files.length).toBe(1);
    expect(parsed?.files[0].diagnostics.length).toBe(2);
    expect(parsed?.totalErrors).toBe(1);
    expect(parsed?.totalWarnings).toBe(1);
  });

  test("uses provided totals when present", () => {
    const response = { files: [], totalErrors: 9, totalWarnings: 4 };
    const parsed = parseDiagnosticsResponse(response);

    expect(parsed?.totalErrors).toBe(9);
    expect(parsed?.totalWarnings).toBe(4);
  });

  test("ok false yields undefined", () => {
    expect(parseDiagnosticsResponse({ ok: false, files: [] })).toBeUndefined();
  });

  test("missing files array yields undefined", () => {
    expect(parseDiagnosticsResponse({})).toBeUndefined();
  });
});

describe("parseDiffApprovalResponse", () => {
  test("parses a valid accept decision", () => {
    expect(parseDiffApprovalResponse({ decision: "accept", content: "next" })).toEqual({ decision: "accept", content: "next" });
  });

  test("parses a valid reject decision", () => {
    expect(parseDiffApprovalResponse({ decision: "reject", content: "" })).toEqual({ decision: "reject", content: "" });
  });

  test("missing or invalid decision yields undefined", () => {
    expect(parseDiffApprovalResponse({ content: "next" })).toBeUndefined();
    expect(parseDiffApprovalResponse({ decision: "maybe", content: "next" })).toBeUndefined();
  });

  test("non-string content yields undefined", () => {
    expect(parseDiffApprovalResponse({ decision: "accept", content: 5 })).toBeUndefined();
    expect(parseDiffApprovalResponse({ decision: "accept" })).toBeUndefined();
  });

  test("non-object input yields undefined", () => {
    expect(parseDiffApprovalResponse("nope")).toBeUndefined();
    expect(parseDiffApprovalResponse(undefined)).toBeUndefined();
  });
});

describe("workspaceScore", () => {
  test("scores by matching prefix length", () => {
    const cwd = "/home/user/project/src";

    expect(workspaceScore(["/home/user/project"], cwd)).toBe("/home/user/project".length);
  });

  test("prefers the longest matching folder", () => {
    const cwd = "/home/user/project/src";
    const score = workspaceScore(["/home/user", "/home/user/project"], cwd);

    expect(score).toBe("/home/user/project".length);
  });

  test("returns -1 when no folder matches", () => {
    expect(workspaceScore(["/other/place"], "/home/user/project")).toBe(-1);
  });
});

describe("isAlive", () => {
  test("non-positive pid is treated as alive", () => {
    expect(isAlive(0)).toBe(true);
    expect(isAlive(-5)).toBe(true);
  });

  test("current process pid is alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe("readConnectionFromEnv", () => {
  test("returns undefined when port or token is missing", () => {
    const port = process.env.PI_IDE_BRIDGE_SERVER_PORT;
    const token = process.env.PI_IDE_BRIDGE_AUTH_TOKEN;
    delete process.env.PI_IDE_BRIDGE_SERVER_PORT;
    delete process.env.PI_IDE_BRIDGE_AUTH_TOKEN;

    expect(readConnectionFromEnv()).toBeUndefined();

    if (port !== undefined) process.env.PI_IDE_BRIDGE_SERVER_PORT = port;
    if (token !== undefined) process.env.PI_IDE_BRIDGE_AUTH_TOKEN = token;
  });

  test("parses a valid env connection", () => {
    const port = process.env.PI_IDE_BRIDGE_SERVER_PORT;
    const token = process.env.PI_IDE_BRIDGE_AUTH_TOKEN;
    process.env.PI_IDE_BRIDGE_SERVER_PORT = "4242";
    process.env.PI_IDE_BRIDGE_AUTH_TOKEN = "secret";

    expect(readConnectionFromEnv()).toEqual({ port: 4242, authToken: "secret" });

    if (port === undefined) delete process.env.PI_IDE_BRIDGE_SERVER_PORT;
    else process.env.PI_IDE_BRIDGE_SERVER_PORT = port;
    if (token === undefined) delete process.env.PI_IDE_BRIDGE_AUTH_TOKEN;
    else process.env.PI_IDE_BRIDGE_AUTH_TOKEN = token;
  });

  test("rejects an out-of-range port", () => {
    const port = process.env.PI_IDE_BRIDGE_SERVER_PORT;
    const token = process.env.PI_IDE_BRIDGE_AUTH_TOKEN;
    process.env.PI_IDE_BRIDGE_SERVER_PORT = "70000";
    process.env.PI_IDE_BRIDGE_AUTH_TOKEN = "secret";

    expect(readConnectionFromEnv()).toBeUndefined();

    if (port === undefined) delete process.env.PI_IDE_BRIDGE_SERVER_PORT;
    else process.env.PI_IDE_BRIDGE_SERVER_PORT = port;
    if (token === undefined) delete process.env.PI_IDE_BRIDGE_AUTH_TOKEN;
    else process.env.PI_IDE_BRIDGE_AUTH_TOKEN = token;
  });
});

describe("retryBackoffMs", () => {
  test("returns the bounded backoff schedule", () => {
    expect(retryBackoffMs(0)).toBe(1000);
    expect(retryBackoffMs(2)).toBe(5000);
    expect(retryBackoffMs(99)).toBe(30000);
    expect(retryBackoffMs(-1)).toBe(1000);
  });
});

describe("canReviewDiff", () => {
  test("accepts small diffs", () => {
    expect(canReviewDiff("a", "b")).toBe(true);
  });

  test("rejects diffs over the review byte budget", () => {
    const huge = "x".repeat(6 * 1024 * 1024);

    expect(canReviewDiff(huge, huge)).toBe(false);
  });
});
