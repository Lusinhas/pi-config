const DONE_STATUSES: ReadonlySet<string> = new Set(["done", "completed", "cancelled", "canceled"]);

const LABEL_KEYS = ["text", "title", "content", "label", "description"] as const;

export class Text {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static flatten(content: unknown): string {

    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const parts: string[] = [];

    for (const block of content) {

      if (Text.isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }

    return parts.join("\n");
  }

  static lastAssistant(messages: readonly unknown[]): string {

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];

      if (!Text.isRecord(message) || message.role !== "assistant") {
        continue;
      }

      const content = message.content;

      if (typeof content === "string") {

        if (content.trim()) {
          return content;
        }

        continue;
      }

      if (!Array.isArray(content)) {
        continue;
      }

      const text = Text.flatten(content);

      if (text.trim()) {
        return text;
      }
    }

    return "";
  }

  static clipLine(text: string, maxChars: number): string {
    const flat = text.replace(/\s+/g, " ").trim();

    if (maxChars <= 0 || flat.length <= maxChars) {
      return flat;
    }

    return `${flat.slice(0, Math.max(1, maxChars - 1))}…`;
  }

  static openTodoLabels(open: number, items: readonly unknown[]): string[] {

    if (open <= 0) {
      return [];
    }

    const labels: string[] = [];

    for (const item of items) {

      if (typeof item === "string") {

        if (item.trim()) {
          labels.push(item.trim());
        }

        continue;
      }

      if (!Text.isRecord(item)) {
        continue;
      }

      if (item.done === true || item.completed === true) {
        continue;
      }

      if (typeof item.status === "string" && DONE_STATUSES.has(item.status)) {
        continue;
      }

      const label = LABEL_KEYS.map(key => item[key]).find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      labels.push(label ? label.trim() : JSON.stringify(item));
    }

    if (labels.length === 0) {
      labels.push(`${open} open todo${open === 1 ? "" : "s"}`);
    }

    return labels;
  }
}
