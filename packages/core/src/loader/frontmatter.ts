export interface ParsedFrontmatter {
  ok: boolean;
  hasFrontmatter: boolean;
  data: Record<string, string>;
  body: string;
  error?: string;
}

const blockScalars = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

export class QuoteStripper {
  strip(value: string): string {
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }

    return value;
  }
}

export class FrontmatterParser {
  private readonly quoteStripper = new QuoteStripper();

  parse(text: string): ParsedFrontmatter {
    const cleaned = text.replace(/^\uFEFF/, "");
    const lines = cleaned.split(/\r\n|\r|\n/);

    if ((lines[0] ?? "").trim() !== "---") {
      return { ok: true, hasFrontmatter: false, data: {}, body: cleaned };
    }

    let end = -1;

    for (let i = 1; i < lines.length; i += 1) {
      const trimmed = (lines[i] ?? "").trim();

      if (trimmed === "---" || trimmed === "...") {
        end = i;
        break;
      }
    }

    if (end === -1) {
      return { ok: false, hasFrontmatter: true, data: {}, body: "", error: "unterminated frontmatter block" };
    }

    const data: Record<string, string> = {};
    const body = lines.slice(end + 1).join("\n");

    for (let i = 1; i < end; i += 1) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();

      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }

      if (/^\s/.test(line)) {
        continue;
      }

      if (trimmed.startsWith("- ")) {
        continue;
      }

      const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);

      if (!match) {
        return { ok: false, hasFrontmatter: true, data, body, error: `invalid frontmatter line ${i + 1}: ${trimmed}` };
      }

      const key = match[1];
      let value = match[2].trim();

      if (blockScalars.has(value)) {
        const parts: string[] = [];
        let j = i + 1;

        while (j < end && ((lines[j] ?? "").trim().length === 0 || /^\s/.test(lines[j] ?? ""))) {
          if ((lines[j] ?? "").trim().length > 0) {
            parts.push((lines[j] ?? "").trim());
          }

          j += 1;
        }

        value = parts.join(" ");
        i = j - 1;
      } else {
        value = this.quoteStripper.strip(value);
      }

      data[key] = value;
    }

    return { ok: true, hasFrontmatter: true, data, body };
  }
}
