import { createHash } from "node:crypto";

export interface TopicRef {
  slug: string;
  title: string;
  summary: string;
}

export interface SaveResult {
  slug: string;
  created: boolean;
  file: string;
}

export const INDEX_FILE = "MEMORY.md";

const indexLine = /^- \[(.+?)\]\((.+?)\.md\) — (.*)$/;

export class Text {
  static slugify(topic: string): string {
    const slug = topic
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/, "");

    return slug.length > 0 ? slug : "topic";
  }

  static clip(text: string, budget: number): string {

    if (budget <= 0 || text.length <= budget) {
      return text;
    }

    const head = text.slice(0, Math.max(1, budget - 13));
    const cut = head.lastIndexOf("\n");
    const kept = cut > head.length / 2 ? head.slice(0, cut) : head;

    return `${kept.trimEnd()}\n[truncated]`;
  }

  static oneLine(text: string, max: number): string {
    const flat = text.replace(/[\[\]()]/g, "").replace(/\s+/g, " ").trim();

    if (flat.length <= max) {
      return flat;
    }

    return `${flat.slice(0, max - 1).trimEnd()}…`;
  }

  static capBytes(text: string, maxBytes: number, title: string): string {

    if (maxBytes <= 0 || Buffer.byteLength(text, "utf8") <= maxBytes) {
      return text;
    }

    const header = `# ${title}\n\n`;
    const budget = Math.max(256, maxBytes - Buffer.byteLength(header, "utf8"));
    const buf = Buffer.from(text, "utf8");
    let tail = buf
      .subarray(Math.max(0, buf.length - budget))
      .toString("utf8")
      .replace(/^[\u{FFFD}]+/u, "");
    const cut = tail.indexOf("\n");

    if (cut >= 0 && cut < tail.length - 1) {
      tail = tail.slice(cut + 1);
    }

    return `${header}${tail.trimEnd()}\n`;
  }

  static sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  static parseIndex(text: string): TopicRef[] {
    const refs: TopicRef[] = [];

    for (const raw of text.split("\n")) {
      const match = indexLine.exec(raw.trim());

      if (match) {
        refs.push({ title: match[1], slug: match[2], summary: match[3] });
      }
    }

    return refs;
  }

  static formatIndex(refs: readonly TopicRef[]): string {

    if (refs.length === 0) {
      return "";
    }

    return `${refs.map((ref) => `- [${ref.title}](${ref.slug}.md) — ${ref.summary}`).join("\n")}\n`;
  }
}
