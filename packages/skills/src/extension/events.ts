import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigLoader } from "./config.ts";
import { Discovery } from "../skills/index.ts";

const MAX_CACHE_ENTRIES = 32;

interface DiscoverEvent {
  cwd?: unknown;
}

interface CacheEntry {
  fingerprint: string;
  skillPaths: string[];
}

export class EventBridge {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly discovery: Discovery,
  ) {}

  resourcesDiscover(event: DiscoverEvent, ctx: ExtensionContext): { skillPaths: string[] } {
    const cwd = this.cwdFor(event, ctx);

    if (cwd.length === 0) {

      throw new Error("skills: resources_discover requires a non-empty cwd from event or ctx");
    }

    const trusted = this.trustedFor(ctx);
    const key = `${trusted ? "1" : "0"}:${cwd}`;
    const fingerprint = this.configLoader.fingerprint(cwd, trusted);
    const cached = this.cache.get(key);

    if (cached !== undefined && cached.fingerprint === fingerprint) {

      return { skillPaths: cached.skillPaths };
    }

    const config = this.configLoader.load(cwd, trusted);
    const skillPaths = this.discovery.discoverClaudeSkills(cwd, trusted, config.values);

    this.remember(key, { fingerprint, skillPaths });

    return { skillPaths };
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);

    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;

      if (oldest === undefined) {

        break;
      }

      this.cache.delete(oldest);
    }
  }

  private cwdFor(event: DiscoverEvent, ctx: ExtensionContext): string {

    if (typeof event.cwd === "string" && event.cwd.length > 0) {

      return event.cwd;
    }

    return typeof ctx.cwd === "string" ? ctx.cwd : "";
  }

  private trustedFor(ctx: ExtensionContext): boolean {
    try {

      return ctx.isProjectTrusted();
    } catch {

      return false;
    }
  }
}
