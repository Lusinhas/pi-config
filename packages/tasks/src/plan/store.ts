export interface PersistedPlan {
  active: boolean;
  snapshot: string[];
  gated: string[];
}

export class Parser {
  constructor(private readonly stateType: string) {}

  static onlyStrings(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const out: string[] = [];

    for (const item of value) {
      if (typeof item === "string" && item.length > 0 && !out.includes(item)) {
        out.push(item);
      }
    }

    return out;
  }

  readPersisted(entries: unknown): PersistedPlan | undefined {
    if (!Array.isArray(entries)) {
      return undefined;
    }

    let latest: PersistedPlan | undefined;

    for (const raw of entries) {
      if (!raw || typeof raw !== "object") {
        continue;
      }

      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };

      if (entry.type !== "custom" || entry.customType !== this.stateType) {
        continue;
      }

      const data = entry.data;

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        continue;
      }

      const record = data as { active?: unknown; snapshot?: unknown; gated?: unknown };

      latest = {
        active: record.active === true,
        snapshot: Parser.onlyStrings(record.snapshot),
        gated: Parser.onlyStrings(record.gated),
      };
    }

    return latest;
  }
}

export class Builder {
  static state(snapshot: string[], gated: string[], active: boolean): Record<string, unknown> {
    return {
      active,
      snapshot: [...snapshot],
      gated: [...gated],
      at: new Date().toISOString(),
    };
  }

  static approved(text: string): Record<string, unknown> {
    return { text, approvedAt: new Date().toISOString() };
  }
}

export class Store {
  static readonly STATETYPE = "piconfig:plan:state";
  static readonly APPROVEDTYPE = "piconfig:plan:approved";

  private static readonly parser = new Parser(Store.STATETYPE);

  static onlyStrings(value: unknown): string[] {
    return Parser.onlyStrings(value);
  }

  static readPersisted(entries: unknown): PersistedPlan | undefined {
    return Store.parser.readPersisted(entries);
  }

  static stateEntry(snapshot: string[], gated: string[], active: boolean): Record<string, unknown> {
    return Builder.state(snapshot, gated, active);
  }

  static approvedEntry(text: string): Record<string, unknown> {
    return Builder.approved(text);
  }
}
