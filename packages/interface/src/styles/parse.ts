export type StyleSource = "preset" | "user";

export interface Style {
  name: string;
  description: string;
  body: string;
  source: StyleSource;
  path: string;
}

export interface StyleError {
  path: string;
  message: string;
}

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
  error: string | null;
}

export interface StyleParseResult {
  style: Style | null;
  error: StyleError | null;
}

export interface DirEntry {
  path: string;
  content: string | null;
  readError: string | null;
}

export interface DirListing {
  entries: DirEntry[];
  error: StyleError | null;
}

export interface DirectoryReader {
  list(dir: string): DirListing;
  fingerprint(dir: string): string;
}

export class FrontmatterParser {
  private unquote(value: string): string {
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];

      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return value.slice(1, -1);
      }
    }

    return value;
  }

  parse(raw: string): Frontmatter {
    const lines = raw
      .replace(/^﻿/, "")
      .split("\n")
      .map((line) => line.replace(/\r$/, ""));

    if (lines.length === 0 || lines[0].trim() !== "---") {
      return { data: {}, body: "", error: "missing frontmatter opening delimiter" };
    }

    let close = -1;

    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        close = i;
        break;
      }
    }

    if (close === -1) {
      return { data: {}, body: "", error: "missing frontmatter closing delimiter" };
    }

    const data: Record<string, string> = {};

    for (let i = 1; i < close; i += 1) {
      const trimmed = lines[i].trim();

      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }

      const colon = trimmed.indexOf(":");

      if (colon <= 0) {
        return { data: {}, body: "", error: `invalid frontmatter line ${i + 1}: "${trimmed}"` };
      }

      const key = trimmed.slice(0, colon).trim();
      data[key] = this.unquote(trimmed.slice(colon + 1).trim());
    }

    return { data, body: lines.slice(close + 1).join("\n").trim(), error: null };
  }
}

export class StyleFileParser {
  constructor(private readonly frontmatter: FrontmatterParser) {}

  parse(content: string, path: string, source: StyleSource): StyleParseResult {
    const parsed = this.frontmatter.parse(content);

    if (parsed.error !== null) {
      return { style: null, error: { path, message: parsed.error } };
    }

    const name = parsed.data.name ?? "";

    if (name === "") {
      return { style: null, error: { path, message: 'frontmatter "name" is required and must be non-empty' } };
    }

    if (!/^\S+$/.test(name)) {
      return { style: null, error: { path, message: 'frontmatter "name" must be a single word without whitespace' } };
    }

    if (name.toLowerCase() === "off") {
      return { style: null, error: { path, message: '"off" is a reserved style name' } };
    }

    const description = parsed.data.description ?? "";

    if (description === "") {
      return { style: null, error: { path, message: 'frontmatter "description" is required and must be non-empty' } };
    }

    if (parsed.body === "") {
      return { style: null, error: { path, message: "style body is empty" } };
    }

    return { style: { name, description, body: parsed.body, source, path }, error: null };
  }
}
