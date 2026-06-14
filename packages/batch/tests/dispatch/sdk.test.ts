import { describe, expect, test } from "bun:test";
import { CORE_TOOL_NAMES } from "../../src/dispatch/dispatch.ts";
import { SdkCoreTools } from "../../src/dispatch/sdk.ts";

describe("SdkCoreTools", () => {
  test("builds an executable tool for every core tool name", () => {
    const sdk = new SdkCoreTools();

    for (const name of CORE_TOOL_NAMES) {
      expect(typeof sdk.build(name, process.cwd()).execute).toBe("function");
    }
  });

  test("caches the built tool per name and cwd", () => {
    const sdk = new SdkCoreTools();
    const first = sdk.build("read", "/repo");
    const second = sdk.build("read", "/repo");
    const other = sdk.build("read", "/elsewhere");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });
});
