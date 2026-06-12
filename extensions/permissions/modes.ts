export type Mode = "ask" | "auto" | "write" | "yolo";

export const MODES: readonly Mode[] = ["ask", "auto", "write", "yolo"];

export function isMode(value: unknown): value is Mode {
  return value === "ask" || value === "auto" || value === "write" || value === "yolo";
}

export function nextMode(mode: Mode): Mode {
  const index = MODES.indexOf(mode);
  return MODES[(index + 1) % MODES.length];
}

export function describeMode(mode: Mode): string {
  if (mode === "ask") {
    return "reads and searches run freely, every other tool call needs approval";
  }
  if (mode === "auto") {
    return "a judge model auto-approves actions that are safe and align with your request; everything else still asks";
  }
  if (mode === "write") {
    return "reads, searches, and most tools run freely, writes and bash need approval";
  }
  return "everything runs freely except explicit deny rules";
}

export function modeDefault(
  mode: Mode,
  toolName: string,
  readTools: readonly string[],
  writeTools: readonly string[],
): "allow" | "ask" {
  if (mode === "yolo") {
    return "allow";
  }
  if (mode === "write") {
    return writeTools.includes(toolName) ? "ask" : "allow";
  }
  return readTools.includes(toolName) ? "allow" : "ask";
}
