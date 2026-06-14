import { Messages } from "./index.ts";

export const HANDOFFSYSTEM = `You write handoff documents that let a fresh coding-agent session continue work seamlessly.
Produce a markdown document with exactly these sections:
## Goal
What the user is ultimately trying to achieve.
## Current state
What has been done so far, which files were created or modified, what works and what does not.
## Decisions
Choices made and their rationale, including approaches that were considered and rejected.
## Open items
Remaining work, known issues, and concrete next steps.
Be specific: include file paths, command names, identifiers, and error messages where they matter.
The document must be self-contained; the reader has no access to the previous session.
Output only the document, with no preamble or closing remarks.`;

export class Handoff {
  constructor(private readonly messages: Messages) {}

  clip(text: string, max: number): string {
    if (text.length <= max) {
      return text;
    }

    const head = text.slice(0, Math.floor(max * 0.7));
    const tailStart = text.length - Math.floor(max * 0.2);

    return `${head}\n[...${text.length - max} chars clipped...]\n${text.slice(tailStart)}`;
  }

  renderToolCall(block: Record<string, unknown>): string {
    const serialized = this.messages.safeStringify(block.arguments ?? {});
    const args = serialized === undefined ? "{}" : serialized;

    return `TOOL CALL ${block.name}(${this.clip(args, 300)})`;
  }

  renderMessage(message: Record<string, unknown>): string {
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "user") {
      const text = this.messages.textOfContent(message.content).trim();

      return text ? `USER:\n${this.clip(text, 4000)}` : "";
    }

    if (role === "assistant") {
      const parts: string[] = [];
      const text = this.messages.textOfContent(message.content).trim();

      if (text) {
        parts.push(this.clip(text, 4000));
      }

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (this.messages.isRecord(block) && block.type === "toolCall" && typeof block.name === "string") {
            parts.push(this.renderToolCall(block));
          }
        }
      }

      return parts.length > 0 ? `ASSISTANT:\n${parts.join("\n")}` : "";
    }

    if (this.messages.isToolResult(message)) {
      const text = this.messages.textOfContent(message.content).trim();
      const flag = message.isError ? " (error)" : "";

      return text ? `TOOL RESULT ${message.toolName}${flag}:\n${this.clip(text, 1200)}` : "";
    }

    if (role === "developer") {
      const text = this.messages.textOfContent(message.content).trim();

      return text ? `SYSTEM NOTE:\n${this.clip(text, 1500)}` : "";
    }

    return "";
  }

  serializeRecentEntries(entries: unknown[], maxChars: number): string {
    const rendered: string[] = [];

    for (const entry of entries) {
      const message = this.messages.messageOf(entry);

      if (!message) {
        continue;
      }

      const text = this.renderMessage(message);

      if (text) {
        rendered.push(text);
      }
    }

    const kept: string[] = [];
    let total = 0;

    for (let i = rendered.length - 1; i >= 0; i--) {
      const piece = rendered[i];

      if (kept.length > 0 && total + piece.length > maxChars) {
        break;
      }

      kept.push(piece);
      total += piece.length;
    }

    return kept.reverse().join("\n\n");
  }

  buildPrompt(serialized: string, instructions: string): string {
    const sections: string[] = [];

    if (instructions) {
      sections.push(`The user gave these instructions for the handoff: ${instructions}`);
    }

    sections.push(`Write the handoff document for the session below.\n\n<session>\n${serialized}\n</session>`);

    return sections.join("\n\n");
  }

  extractText(content: unknown): string {
    if (!Array.isArray(content)) {
      return "";
    }

    const parts: string[] = [];

    for (const block of content) {
      if (this.messages.isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }

    return parts.join("\n").trim();
  }

  openingText(handoffPath: string, doc: string): string {
    return `Continuing work from a previous session. The handoff document below was saved to ${handoffPath}.\n\n${doc}`;
  }
}
