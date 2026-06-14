import type { DirListing, Style, StyleError, StyleFileParser, StyleSource, DirectoryReader } from "./parse.ts";

interface Tier {
  source: StyleSource;
  listing: DirListing;
}

export class Catalog {
  private readonly styles: Map<string, Style>;
  private readonly errors: StyleError[];

  constructor(styles: Map<string, Style>, errors: StyleError[]) {
    this.styles = styles;
    this.errors = errors;
  }

  get map(): Map<string, Style> {
    return this.styles;
  }

  get problems(): StyleError[] {
    return this.errors;
  }

  get(name: string): Style | undefined {
    return this.styles.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.styles.has(name.toLowerCase());
  }

  values(): Style[] {
    return [...this.styles.values()];
  }
}

export class StyleStore {
  private readonly parser: StyleFileParser;
  private readonly reader: DirectoryReader;
  private readonly presetDir: string;
  private cache: Catalog | null = null;
  private cacheKey: string | null = null;

  constructor(parser: StyleFileParser, reader: DirectoryReader, presetDir: string) {
    this.parser = parser;
    this.reader = reader;
    this.presetDir = presetDir;
  }

  discover(userDir: string): Catalog {
    const key = `${this.presetDir} ${this.reader.fingerprint(this.presetDir)} ${userDir} ${this.reader.fingerprint(userDir)}`;

    if (this.cache !== null && this.cacheKey === key) {
      return this.cache;
    }

    const catalog = this.build(userDir);
    this.cache = catalog;
    this.cacheKey = key;

    return catalog;
  }

  private build(userDir: string): Catalog {
    const styles = new Map<string, Style>();
    const errors: StyleError[] = [];
    const tiers: Tier[] = [
      { source: "preset", listing: this.reader.list(this.presetDir) },
      { source: "user", listing: this.reader.list(userDir) },
    ];

    for (const tier of tiers) {
      if (tier.listing.error !== null) {
        errors.push(tier.listing.error);
      }

      for (const entry of tier.listing.entries) {
        if (entry.content === null) {
          errors.push({ path: entry.path, message: `unreadable: ${entry.readError ?? "unknown error"}` });
          continue;
        }

        const result = this.parser.parse(entry.content, entry.path, tier.source);

        if (result.error !== null) {
          errors.push(result.error);
          continue;
        }

        if (result.style === null) {
          continue;
        }

        const styleKey = result.style.name.toLowerCase();
        const existing = styles.get(styleKey);

        if (existing !== undefined && existing.source === tier.source) {
          errors.push({
            path: entry.path,
            message: `duplicate style name "${result.style.name}" (already defined by ${existing.path})`,
          });
          continue;
        }

        styles.set(styleKey, result.style);
      }
    }

    return new Catalog(styles, errors);
  }
}
