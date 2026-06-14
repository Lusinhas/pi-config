import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { INDEX_FILE, type SaveResult, Text, type TopicRef } from "./text.ts";

export { Config } from "./config.ts";
export type { MemoryConfig } from "./config.ts";
export { Text, INDEX_FILE } from "./text.ts";
export type { SaveResult, TopicRef } from "./text.ts";

export type MutationQueue = (path: string, run: () => Promise<unknown>) => Promise<unknown>;

interface IndexCacheEntry {
  mtimeMs: number;
  raw: string;
  refs: TopicRef[];
}

export class Store {
  private readonly queue: MutationQueue;

  private readonly rootCache = new Map<string, string>();

  private readonly indexCache = new Map<string, IndexCacheEntry>();

  constructor(queue: MutationQueue) {
    this.queue = queue;
  }

  projectRoot(cwd: string): string {
    const start = resolve(cwd);
    const cached = this.rootCache.get(start);

    if (cached !== undefined) {
      return cached;
    }

    let dir = start;
    let root = start;

    for (;;) {

      if (existsSync(join(dir, ".git"))) {
        root = dir;
        break;
      }

      const parent = dirname(dir);

      if (parent === dir) {
        break;
      }

      dir = parent;
    }

    this.rootCache.set(start, root);

    return root;
  }

  memoryDir(cwd: string): string {
    const root = this.projectRoot(cwd);
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);

    return join(homedir(), ".pi", "agent", "memory", hash);
  }

  indexPath(dir: string): string {
    return join(dir, INDEX_FILE);
  }

  slugify(topic: string): string {
    return Text.slugify(topic);
  }

  clip(text: string, budget: number): string {
    return Text.clip(text, budget);
  }

  oneLine(text: string, max: number): string {
    return Text.oneLine(text, max);
  }

  capBytes(text: string, maxBytes: number, title: string): string {
    return Text.capBytes(text, maxBytes, title);
  }

  parseIndex(text: string): TopicRef[] {
    return Text.parseIndex(text);
  }

  formatIndex(refs: readonly TopicRef[]): string {
    return Text.formatIndex(refs);
  }

  async readIndex(dir: string): Promise<string> {

    try {
      return await readFile(this.indexPath(dir), "utf8");
    } catch {
      return "";
    }
  }

  private async cachedIndexRefs(dir: string): Promise<TopicRef[]> {
    const path = this.indexPath(dir);
    let mtimeMs: number;

    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      this.indexCache.delete(dir);
      return [];
    }

    const hit = this.indexCache.get(dir);

    if (hit !== undefined && hit.mtimeMs === mtimeMs) {
      return hit.refs;
    }

    const raw = await this.readIndex(dir);
    const refs = this.parseIndex(raw);
    this.indexCache.set(dir, { mtimeMs, raw, refs });

    return refs;
  }

  private invalidate(dir: string): void {
    this.indexCache.delete(dir);
  }

  async listTopics(dir: string): Promise<TopicRef[]> {
    const indexed = await this.cachedIndexRefs(dir);
    const refs = indexed.map((ref) => ({ ...ref }));
    const seen = new Set(refs.map((ref) => ref.slug));
    let files: string[] = [];

    try {
      files = await readdir(dir);
    } catch {
      files = [];
    }

    const orphans: string[] = [];

    for (const file of files) {

      if (!file.endsWith(".md") || file === INDEX_FILE) {
        continue;
      }

      const slug = file.slice(0, -3);

      if (!seen.has(slug)) {
        seen.add(slug);
        orphans.push(slug);
      }
    }

    orphans.sort((a, b) => a.localeCompare(b));

    for (const slug of orphans) {
      refs.push({ slug, title: slug, summary: "" });
    }

    return refs;
  }

  async resolveSlug(dir: string, topic: string): Promise<string | undefined> {
    const direct = this.slugify(topic);

    if (existsSync(join(dir, `${direct}.md`))) {
      return direct;
    }

    const wanted = topic.trim().toLowerCase();

    for (const ref of await this.cachedIndexRefs(dir)) {

      if (ref.slug === wanted || ref.title.toLowerCase() === wanted) {
        return ref.slug;
      }
    }

    for (const ref of await this.listTopics(dir)) {

      if (ref.slug === wanted || ref.title.toLowerCase() === wanted) {
        return ref.slug;
      }
    }

    return undefined;
  }

  async saveTopic(dir: string, topic: string, text: string, maxTopicBytes: number): Promise<SaveResult> {
    const title = this.oneLine(topic, 64);
    const slug = this.slugify(topic);
    const body = text.trim();

    if (title.length === 0) {
      throw new Error("memory save requires a non-empty topic");
    }

    if (body.length === 0) {
      throw new Error("memory save requires non-empty text");
    }

    const file = join(dir, `${slug}.md`);

    return this.queue(this.indexPath(dir), async () => {
      await mkdir(dir, { recursive: true });
      let existing: string | undefined;

      try {
        existing = await readFile(file, "utf8");
      } catch {
        existing = undefined;
      }

      const created = existing === undefined;
      const merged = existing === undefined ? `# ${title}\n\n${body}\n` : `${existing.trimEnd()}\n\n${body}\n`;
      await writeFile(file, this.capBytes(merged, maxTopicBytes, title), "utf8");
      const refs = this.parseIndex(await this.readIndex(dir));
      const summary = this.oneLine(body, 100);
      const ref = refs.find((candidate) => candidate.slug === slug);

      if (ref) {
        ref.title = title;
        ref.summary = summary;
      } else {
        refs.push({ slug, title, summary });
      }

      try {
        await writeFile(this.indexPath(dir), this.formatIndex(refs), "utf8");
      } catch {}

      this.invalidate(dir);

      return { slug, created, file };
    }) as Promise<SaveResult>;
  }

  async readTopic(dir: string, topic: string): Promise<string | undefined> {
    const slug = await this.resolveSlug(dir, topic);

    if (slug === undefined) {
      return undefined;
    }

    try {
      return await readFile(join(dir, `${slug}.md`), "utf8");
    } catch {
      return undefined;
    }
  }

  async forgetTopic(dir: string, topic: string): Promise<boolean> {
    const slug = await this.resolveSlug(dir, topic);

    if (slug === undefined) {
      return false;
    }

    return this.queue(this.indexPath(dir), async () => {
      let removed = false;

      try {
        await rm(join(dir, `${slug}.md`));
        removed = true;
      } catch {}

      const refs = this.parseIndex(await this.readIndex(dir));
      const kept = refs.filter((ref) => ref.slug !== slug);

      if (kept.length !== refs.length) {

        try {
          await writeFile(this.indexPath(dir), this.formatIndex(kept), "utf8");
          removed = true;
        } catch {}
      }

      this.invalidate(dir);

      return removed;
    }) as Promise<boolean>;
  }
}
