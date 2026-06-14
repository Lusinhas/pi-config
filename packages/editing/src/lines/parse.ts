import { lineAnchor } from "./hash.ts";

export interface ParsedFile {
  lines: string[];
  eols: string[];
  dominantEol: string;
}

export function parseContent(content: string): ParsedFile {
  if (content === "") {
    return { lines: [], eols: [], dominantEol: "\n" };
  }

  const lines: string[] = [];
  const eols: string[] = [];
  let start = 0;
  let crlf = 0;
  let lf = 0;

  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      const hasCr = i > start && content.charCodeAt(i - 1) === 13;
      lines.push(content.slice(start, hasCr ? i - 1 : i));
      eols.push(hasCr ? "\r\n" : "\n");

      if (hasCr) {
        crlf += 1;
      } else {
        lf += 1;
      }

      start = i + 1;
    }
  }

  if (start < content.length) {
    lines.push(content.slice(start));
    eols.push("");
  }

  return { lines, eols, dominantEol: crlf > lf ? "\r\n" : "\n" };
}

export function joinContent(lines: string[], eols: string[]): string {
  let out = "";

  for (let i = 0; i < lines.length; i += 1) {
    out += lines[i] + (eols[i] ?? "\n");
  }

  return out;
}

export function renderNumberedLine(lineNumber: number, text: string, maxLineLength: number): string {
  const display =
    text.length > maxLineLength
      ? `${text.slice(0, maxLineLength)} [line truncated: ${text.length - maxLineLength} more chars]`
      : text;

  return `@${lineAnchor(lineNumber, text)} ${lineNumber}: ${display}`;
}

export function splitText(text: string): string[] {
  const stripped = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;

  return stripped.split(/\r\n|\n/);
}
