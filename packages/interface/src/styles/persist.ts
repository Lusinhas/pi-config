export type PersistFailureReason = "parse" | "nonrecord";

export interface PersistSuccess {
  ok: true;
  content: string;
}

export interface PersistFailure {
  ok: false;
  reason: PersistFailureReason;
}

export type PersistResult = PersistSuccess | PersistFailure;

export class ActivePersister {
  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  build(existing: string | null, active: string): PersistResult {
    let root: Record<string, unknown> = {};

    if (existing !== null) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(existing);
      } catch {
        return { ok: false, reason: "parse" };
      }

      if (!ActivePersister.isRecord(parsed)) {
        return { ok: false, reason: "nonrecord" };
      }

      root = { ...parsed };
    }

    const section: Record<string, unknown> = ActivePersister.isRecord(root.styles) ? { ...root.styles } : {};
    section.active = active;
    root.styles = section;

    return { ok: true, content: `${JSON.stringify(root, null, 2)}\n` };
  }
}
