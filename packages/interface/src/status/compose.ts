import type { SegmentPart } from "./index.ts";

export type Paint = (token: string, text: string) => string;

export class Text {
  static points(text: string): number {
    return [...text].length;
  }

  static clip(text: string, max: number): string {
    if (max <= 0) {
      return "";
    }

    const points = [...text];

    if (points.length <= max) {
      return text;
    }

    if (max === 1) {
      return "…";
    }

    return `${points.slice(0, max - 1).join("")}…`;
  }
}

export function composeLine(
  parts: SegmentPart[],
  separator: string,
  width: number,
  paint: Paint
): string {
  if (parts.length === 0) {
    return "";
  }

  const max = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
  const sepWidth = Text.points(separator);
  const widths = parts.map(part => Text.points(part.text));

  let kept = parts.length;
  let total = widths.reduce((sum, value) => sum + value, 0) + (parts.length - 1) * sepWidth;

  while (kept > 1 && total > max) {
    kept -= 1;
    total -= widths[kept] + sepWidth;
  }

  const paintedSeparator = paint("dim", separator);
  const rendered: string[] = [];

  for (let index = 0; index < kept; index += 1) {
    const part = parts[index];
    const text = kept === 1 && widths[index] > max ? Text.clip(part.text, max) : part.text;

    rendered.push(part.token ? paint(part.token, text) : text);
  }

  return rendered.join(paintedSeparator);
}
