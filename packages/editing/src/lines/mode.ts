export type HashMode = "hashline" | "compat";

export type ModeOrigin = "manual" | "model" | "default";

export function isHashMode(value: unknown): value is HashMode {
  return value === "hashline" || value === "compat";
}

export function globToRegex(pattern: string): RegExp | null {
  try {
    const parts = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    return new RegExp(`^${parts.join(".*")}$`, "i");
  } catch {
    return null;
  }
}

export function matchedPattern(modelId: string, modes: Record<string, HashMode>): string | null {
  if (modelId === "") {
    return null;
  }

  for (const pattern of Object.keys(modes)) {
    if (pattern === "") {
      continue;
    }

    if (pattern.includes("*")) {
      const regex = globToRegex(pattern);

      if (regex !== null && regex.test(modelId)) {
        return pattern;
      }
    } else if (modelId.toLowerCase().includes(pattern.toLowerCase())) {
      return pattern;
    }
  }

  return null;
}

export function modeForModel(modelId: string, modes: Record<string, HashMode>, fallback: HashMode): HashMode {
  const pattern = matchedPattern(modelId, modes);

  return pattern === null ? fallback : modes[pattern];
}

export class ModeState {
  private readonly modes: Record<string, HashMode>;
  private readonly fallback: HashMode;
  private modelId = "";
  private override: HashMode | null = null;

  constructor(modes: Record<string, HashMode>, fallback: HashMode) {
    this.modes = modes;
    this.fallback = fallback;
  }

  current(): HashMode {
    return this.override ?? modeForModel(this.modelId, this.modes, this.fallback);
  }

  origin(): ModeOrigin {
    if (this.override !== null) {
      return "manual";
    }

    return matchedPattern(this.modelId, this.modes) === null ? "default" : "model";
  }

  model(): string {
    return this.modelId;
  }

  setModel(modelId: string): HashMode {
    this.modelId = modelId;

    return this.current();
  }

  setOverride(mode: HashMode | null): HashMode {
    this.override = mode;

    return this.current();
  }
}
