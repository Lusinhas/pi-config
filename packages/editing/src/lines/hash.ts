import { createHash } from "node:crypto";

function normalizedAnchorText(text: string): string {
  return text.replace(/\r/g, "").trimEnd();
}

function anchorSeed(lineNumber: number, text: string): string {
  return /[\p{L}\p{N}]/u.test(text) ? "content" : `line:${lineNumber}`;
}

export function lineAnchor(lineNumber: number, text: string): string {
  const normalized = normalizedAnchorText(text);
  const digest = createHash("sha256")
    .update(`${anchorSeed(lineNumber, normalized)}\0${normalized}`, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return digest.slice(0, 7);
}

export function contextWeight(distance: number): number {
  if (distance === 0) {
    return 100;
  }

  return Math.max(1, 50 - distance);
}
