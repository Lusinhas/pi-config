import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SEGMENT_IDS, type SegmentId, type SegmentToggle } from "./index.ts";
import { Config } from "./config.ts";

export interface PersistOutcome {
  ok: boolean;
  message: string;
}

export class SegmentStore {
  #dir: string;
  #file: string;

  constructor(dir: string, file: string) {
    this.#dir = dir;
    this.#file = file;
  }

  persist(segments: Record<SegmentId, SegmentToggle>): PersistOutcome {
    let root: Record<string, unknown> = {};
    let existing: string | null = null;

    try {
      existing = readFileSync(this.#file, "utf8");
    } catch {
      existing = null;
    }

    if (existing !== null && existing.trim() !== "") {
      let parsed: unknown;

      try {
        parsed = JSON.parse(existing);
      } catch {
        return { ok: false, message: `Statusline not saved: ${this.#file} contains invalid JSON` };
      }

      if (Config.isRecord(parsed)) {
        root = parsed;
      } else {
        return { ok: false, message: `Statusline not saved: ${this.#file} is not a JSON object` };
      }
    }

    const current = root.statusline;
    const section = Config.isRecord(current) ? { ...current } : {};

    section.segments = Object.fromEntries(
      SEGMENT_IDS.map(id => [id, { enabled: segments[id].enabled }])
    );
    root.statusline = section;

    try {
      mkdirSync(this.#dir, { recursive: true });
      writeFileSync(this.#file, `${JSON.stringify(root, null, 2)}\n`, "utf8");

      return { ok: true, message: `Statusline preferences saved to ${this.#file}` };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      return { ok: false, message: `Statusline not saved: ${reason}` };
    }
  }
}
