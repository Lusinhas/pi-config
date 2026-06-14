import { createHash } from "node:crypto";

const BILLING_SALT = "59cf53e54c78";

export interface BillingMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

export class BillingHeader {
  private readonly salt: string;

  constructor(salt: string = BILLING_SALT) {
    this.salt = salt;
  }

  build(messages: BillingMessage[], version: string, entrypoint: string): string {
    const text = this.firstUserMessageText(messages);
    const suffix = this.versionSuffix(text, version);
    const cch = this.cch(text);

    return (
      `x-anthropic-billing-header: ` +
      `cc_version=${version}.${suffix}; ` +
      `cc_entrypoint=${entrypoint}; ` +
      `cch=${cch};`
    );
  }

  private firstUserMessageText(messages: BillingMessage[]): string {
    const userMsg = messages.find((m) => m.role === "user");

    if (!userMsg) {
      return "";
    }

    const content = userMsg.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      const textBlock = content.find((b) => b.type === "text");

      if (textBlock && textBlock.type === "text" && textBlock.text) {
        return textBlock.text;
      }
    }

    return "";
  }

  private cch(messageText: string): string {
    return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
  }

  private versionSuffix(messageText: string, version: string): string {
    const sampled = [4, 7, 20].map((i) => (i < messageText.length ? messageText[i] : "0")).join("");
    const input = `${this.salt}${sampled}${version}`;

    return createHash("sha256").update(input).digest("hex").slice(0, 3);
  }
}
