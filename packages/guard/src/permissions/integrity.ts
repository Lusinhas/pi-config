import { isRecord } from "./text.ts";

const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

export class ContentIntegrity {
  violation(toolName: string, input: unknown): string | undefined {
    if (toolName !== "write" && toolName !== "edit") {
      return undefined;
    }

    if (!isRecord(input)) {
      return undefined;
    }

    const path = typeof input.path === "string" ? input.path : "the target file";

    for (const text of this.writtenText(input)) {
      const offset = this.controlOffset(text);

      if (offset >= 0) {
        const code = text.charCodeAt(offset).toString(16).toUpperCase().padStart(4, "0");

        return `refusing to ${toolName} non-text content into ${path}: control byte U+${code} at offset ${offset}`;
      }
    }

    return undefined;
  }

  private writtenText(input: Record<string, unknown>): string[] {
    const texts: string[] = [];

    if (typeof input.content === "string") {
      texts.push(input.content);
    }

    if (Array.isArray(input.edits)) {
      for (const edit of input.edits) {
        if (isRecord(edit) && typeof edit.newText === "string") {
          texts.push(edit.newText);
        }
      }
    }

    return texts;
  }

  private controlOffset(text: string): number {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);

      if (code === 0x7f || (code < 0x20 && !ALLOWED_CONTROL.has(code))) {
        return i;
      }
    }

    return -1;
  }
}
