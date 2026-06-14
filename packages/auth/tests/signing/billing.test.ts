import { describe, expect, test } from "bun:test";
import { BillingHeader, type BillingMessage } from "../../src/signing/billing.ts";

const billing = new BillingHeader();

function expectFormat(value: string): void {
  expect(value).toMatch(
    /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[a-f0-9]{3}; cc_entrypoint=[^;]+; cch=[a-f0-9]{5};$/,
  );
}

describe("BillingHeader", () => {
  test("empty messages are deterministic and valid", () => {
    const value = billing.build([], "2.1.112", "sdk-cli");

    expectFormat(value);
    expect(value).toBe(billing.build([], "2.1.112", "sdk-cli"));
  });

  test("single user text message is deterministic", () => {
    const messages: BillingMessage[] = [{ role: "user", content: "hello" }];

    expectFormat(billing.build(messages, "2.1.112", "sdk-cli"));
    expect(billing.build(messages, "2.1.112", "sdk-cli")).toBe(
      billing.build(messages, "2.1.112", "sdk-cli"),
    );
  });

  test("only the first user message influences the header", () => {
    const base: BillingMessage[] = [
      { role: "assistant", content: "ignored" },
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ];
    const changedLater: BillingMessage[] = [
      { role: "assistant", content: "changed" },
      { role: "user", content: "first" },
      { role: "user", content: "changed" },
    ];

    expect(billing.build(changedLater, "2.1.112", "sdk-cli")).toBe(
      billing.build(base, "2.1.112", "sdk-cli"),
    );
  });

  test("known input produces a stable header string", () => {
    const messages: BillingMessage[] = [{ role: "user", content: "hello world" }];

    expect(billing.build(messages, "2.1.112", "sdk-cli")).toBe(
      new BillingHeader().build(messages, "2.1.112", "sdk-cli"),
    );
  });

  test("array text content is read for the first user message", () => {
    const messages: BillingMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    expectFormat(billing.build(messages, "2.1.112", "sdk-cli"));
  });
});
