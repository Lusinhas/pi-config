import { describe, expect, test } from "bun:test";
import contract, {
  BRIDGE_CLOSE_DIFF_PATH,
  BRIDGE_CONTEXT_STREAM_PATH,
  BRIDGE_DIAGNOSTICS_PATH,
  BRIDGE_ENV_AUTH_TOKEN_KEY,
  BRIDGE_ENV_PORT_KEY,
  BRIDGE_HEALTH_PATH,
  BRIDGE_HOST,
  BRIDGE_REQUEST_DIFF_APPROVAL_PATH,
  BRIDGE_SHOW_DIFF_PATH,
} from "../../src/ide/contract.ts";

describe("bridge wire contract", () => {
  test("host and env keys are preserved verbatim", () => {
    expect(BRIDGE_HOST).toBe("127.0.0.1");
    expect(BRIDGE_ENV_PORT_KEY).toBe("PI_IDE_BRIDGE_SERVER_PORT");
    expect(BRIDGE_ENV_AUTH_TOKEN_KEY).toBe("PI_IDE_BRIDGE_AUTH_TOKEN");
  });

  test("http and sse paths are preserved verbatim", () => {
    expect(BRIDGE_SHOW_DIFF_PATH).toBe("/showDiff");
    expect(BRIDGE_CLOSE_DIFF_PATH).toBe("/closeDiff");
    expect(BRIDGE_HEALTH_PATH).toBe("/health");
    expect(BRIDGE_CONTEXT_STREAM_PATH).toBe("/context/stream");
    expect(BRIDGE_DIAGNOSTICS_PATH).toBe("/diagnostics");
    expect(BRIDGE_REQUEST_DIFF_APPROVAL_PATH).toBe("/requestDiffApproval");
  });

  test("default contract object mirrors the named exports", () => {
    expect(contract.BRIDGE_HOST).toBe(BRIDGE_HOST);
    expect(contract.BRIDGE_ENV_PORT_KEY).toBe(BRIDGE_ENV_PORT_KEY);
    expect(contract.BRIDGE_ENV_AUTH_TOKEN_KEY).toBe(BRIDGE_ENV_AUTH_TOKEN_KEY);
    expect(contract.BRIDGE_SHOW_DIFF_PATH).toBe(BRIDGE_SHOW_DIFF_PATH);
    expect(contract.BRIDGE_CLOSE_DIFF_PATH).toBe(BRIDGE_CLOSE_DIFF_PATH);
    expect(contract.BRIDGE_HEALTH_PATH).toBe(BRIDGE_HEALTH_PATH);
    expect(contract.BRIDGE_CONTEXT_STREAM_PATH).toBe(BRIDGE_CONTEXT_STREAM_PATH);
    expect(contract.BRIDGE_DIAGNOSTICS_PATH).toBe(BRIDGE_DIAGNOSTICS_PATH);
    expect(contract.BRIDGE_REQUEST_DIFF_APPROVAL_PATH).toBe(BRIDGE_REQUEST_DIFF_APPROVAL_PATH);
  });
});
