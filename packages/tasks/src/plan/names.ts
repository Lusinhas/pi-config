export class Names {
  static normalize(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const names: string[] = [];
    const seen = new Set<string>();

    for (const item of value) {
      if (typeof item === "string") {
        if (item.length > 0 && !seen.has(item)) {
          seen.add(item);
          names.push(item);
        }

        continue;
      }

      if (item && typeof item === "object") {
        const record = item as { name?: unknown };

        if (typeof record.name === "string" && record.name.length > 0 && !seen.has(record.name)) {
          seen.add(record.name);
          names.push(record.name);
        }
      }
    }

    return names;
  }

  static computeGated(allowed: string[], existing: string[]): string[] {
    const present = new Set(existing);
    const gated: string[] = [];
    const seen = new Set<string>();

    for (const name of allowed) {
      if (present.has(name) && !seen.has(name)) {
        seen.add(name);
        gated.push(name);
      }
    }

    return gated;
  }

  static restorable(snapshot: string[], existing: string[]): string[] {
    const present = new Set(existing);

    return snapshot.filter((name) => present.has(name));
  }

  static restoreTarget(snapshot: string[], existing: string[]): string[] {
    const restorable = Names.restorable(snapshot, existing);

    return restorable.length > 0 ? restorable : [...existing];
  }
}

export class Prompt {
  static compose(current: unknown, addendum: string): string {
    if (Array.isArray(current)) {
      const parts = current.filter((part): part is string => typeof part === "string");

      return [...parts, addendum].join("\n\n");
    }

    if (typeof current === "string" && current.trim().length > 0) {
      return current + "\n\n" + addendum;
    }

    return addendum;
  }
}

export class Render {
  static describeGated(gated: string[]): string {
    return gated.length > 0 ? "allowed tools: " + gated.join(", ") : "no read-only tools available";
  }

  static widgetLines(gated: string[]): string[] {
    const allowed = gated.length > 0 ? gated.join(", ") : "none";

    return ["plan mode: read-only gating active", "allowed tools: " + allowed];
  }

  static enteredNotice(gated: string[]): string {
    return "plan mode on; " + Render.describeGated(gated);
  }

  static alreadyOnNotice(): string {
    return "plan mode is already on";
  }

  static exitedNotice(): string {
    return "plan mode off; tool access restored";
  }

  static alreadyOffNotice(): string {
    return "plan mode is already off";
  }

  static showActiveNotice(gated: string[]): string {
    return "plan mode is on; " + Render.describeGated(gated);
  }

  static showInactiveNotice(): string {
    return "plan mode is off";
  }

  static usageNotice(): string {
    return "usage: /plan [on|off|show]";
  }

  static commandFailedNotice(reason: string): string {
    return reason.length > 0 ? "plan command failed: " + reason : "plan command failed";
  }
}
