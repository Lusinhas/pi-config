import { Text } from "./text.ts";

export interface SessionSummary {
  path: string;
  id: string;
  name: string;
  firstMessage: string;
  messageCount: number;
  modified: number;
  created: number;
  cwd: string;
}

export interface TranscriptItem {
  index: number;
  entryId: string;
  label: string;
  text: string;
}

export interface SessionTranscript {
  id: string;
  cwd: string;
  items: TranscriptItem[];
}

export interface SearchHit {
  path: string;
  sessionId: string;
  sessionTitle: string;
  modified: number;
  itemIndex: number;
  label: string;
  excerpt: string;
}

export type SessionLister = (cwd: string, all: boolean) => Promise<unknown>;

export const ITEM_CAP = 1600;
export const CALL_ARG_CAP = 220;
export const RESULT_LINE_CAP = 300;

export class Transcript {
  static contentText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const parts: string[] = [];

    for (const block of content) {
      const rendered = Transcript.blockText(block);

      if (rendered !== "") {
        parts.push(rendered);
      }
    }

    return parts.join("\n");
  }

  static blockText(block: unknown): string {
    if (typeof block === "string") {
      return block;
    }

    if (!Text.isRecord(block)) {
      return "";
    }

    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }

    if (block.type === "thinking") {
      return "";
    }

    if (block.type === "toolCall") {
      const name = typeof block.name === "string" ? block.name : "tool";
      let argsText = "";

      try {
        argsText = JSON.stringify(block.arguments ?? block.input ?? {});
      } catch {
        argsText = "(unserializable arguments)";
      }

      return `[tool ${name}(${Text.oneLine(argsText, CALL_ARG_CAP)})]`;
    }

    if (block.type === "image") {
      return "[image]";
    }

    return "";
  }

  static entriesToItems(entries: unknown[]): TranscriptItem[] {
    const items: TranscriptItem[] = [];

    const push = (entryId: string, label: string, text: string): void => {
      const cleaned = text.replace(/\r/g, "").trim();

      if (cleaned === "") {
        return;
      }

      items.push({ index: items.length, entryId, label, text: Text.clip(cleaned, ITEM_CAP) });
    };

    for (const entry of entries) {
      if (!Text.isRecord(entry)) {
        continue;
      }

      const entryId = typeof entry.id === "string" ? entry.id : "";

      if (entry.type === "message" && Text.isRecord(entry.message)) {
        const message = entry.message;
        const role = typeof message.role === "string" ? message.role : "";

        if (role === "user") {
          push(entryId, "user", Transcript.contentText(message.content));
        } else if (role === "assistant") {
          push(entryId, "assistant", Transcript.contentText(message.content));
        } else if (role === "toolResult") {
          const name = typeof message.toolName === "string" ? message.toolName : "tool";
          push(
            entryId,
            "tool",
            `[${name} result] ${Text.oneLine(Transcript.contentText(message.content), RESULT_LINE_CAP)}`,
          );
        } else if (role !== "") {
          push(entryId, role, Transcript.contentText(message.content));
        }
      } else if (entry.type === "custom_message") {
        const customType = typeof entry.customType === "string" ? entry.customType : "extension";
        push(entryId, `note:${customType}`, Transcript.contentText(entry.content));
      } else if (entry.type === "compaction" && typeof entry.summary === "string") {
        push(entryId, "compaction", entry.summary);
      } else if (entry.type === "branch_summary" && typeof entry.summary === "string") {
        push(entryId, "branch", entry.summary);
      } else if (entry.type === "model_change") {
        const provider = typeof entry.provider === "string" ? entry.provider : "";
        const modelId = typeof entry.modelId === "string" ? entry.modelId : "";
        push(entryId, "model", `switched to ${provider}/${modelId}`);
      }
    }

    return items;
  }
}
