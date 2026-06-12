import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface MemoryConfig {
  injectBudget: number;
  consolidateEvery: number;
  consolidateOnQuit: boolean;
  model: string;
  maxFacts: number;
  recallBudget: number;
  maxTopicBytes: number;
  transcriptBudget: number;
}

export interface TopicRef {
  slug: string;
  title: string;
  summary: string;
}

export interface SaveResult {
  slug: string;
  created: boolean;
  file: string;
}

const rootCache = new Map<string, string>();

function projectRoot(cwd: string): string {
  const start = resolve(cwd);
  const cached = rootCache.get(start);
  if (cached !== undefined) return cached;
  let dir = start;
  let root = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      root = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  rootCache.set(start, root);
  return root;
}

export function memoryDir(cwd: string): string {
  const root = projectRoot(cwd);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(homedir(), ".pi", "agent", "memory", hash);
}

export function indexPath(dir: string): string {
  return join(dir, "MEMORY.md");
}

export function slugify(topic: string): string {
  const slug = topic
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "topic";
}

export function clip(text: string, budget: number): string {
  if (budget <= 0 || text.length <= budget) return text;
  const head = text.slice(0, Math.max(1, budget - 13));
  const cut = head.lastIndexOf("\n");
  const kept = cut > head.length / 2 ? head.slice(0, cut) : head;
  return `${kept.trimEnd()}\n[truncated]`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\[\]()]/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

const indexLine = /^- \[(.+?)\]\((.+?)\.md\) — (.*)$/;

export function parseIndex(text: string): TopicRef[] {
  const refs: TopicRef[] = [];
  for (const raw of text.split("\n")) {
    const match = indexLine.exec(raw.trim());
    if (match) refs.push({ title: match[1], slug: match[2], summary: match[3] });
  }
  return refs;
}

function formatIndex(refs: TopicRef[]): string {
  if (refs.length === 0) return "";
  return `${refs.map((ref) => `- [${ref.title}](${ref.slug}.md) — ${ref.summary}`).join("\n")}\n`;
}

export async function readIndex(dir: string): Promise<string> {
  try {
    return await readFile(indexPath(dir), "utf8");
  } catch {
    return "";
  }
}

export async function listTopics(dir: string): Promise<TopicRef[]> {
  const refs = parseIndex(await readIndex(dir));
  const seen = new Set(refs.map((ref) => ref.slug));
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.endsWith(".md") || file === "MEMORY.md") continue;
    const slug = file.slice(0, -3);
    if (!seen.has(slug)) {
      seen.add(slug);
      refs.push({ slug, title: slug, summary: "" });
    }
  }
  return refs;
}

export async function resolveSlug(dir: string, topic: string): Promise<string | undefined> {
  const direct = slugify(topic);
  if (existsSync(join(dir, `${direct}.md`))) return direct;
  const wanted = topic.trim().toLowerCase();
  for (const ref of await listTopics(dir)) {
    if (ref.slug === wanted || ref.title.toLowerCase() === wanted) return ref.slug;
  }
  return undefined;
}

function capBytes(text: string, maxBytes: number, title: string): string {
  if (maxBytes <= 0 || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const head = `# ${title}\n\n`;
  const budget = Math.max(256, maxBytes - Buffer.byteLength(head, "utf8"));
  const buf = Buffer.from(text, "utf8");
  let tail = buf
    .subarray(Math.max(0, buf.length - budget))
    .toString("utf8")
    .replace(/^[\u{FFFD}]+/u, "");
  const cut = tail.indexOf("\n");
  if (cut >= 0 && cut < tail.length - 1) tail = tail.slice(cut + 1);
  return `${head}${tail.trimEnd()}\n`;
}

export async function saveTopic(dir: string, topic: string, text: string, maxTopicBytes: number): Promise<SaveResult> {
  const title = oneLine(topic, 64);
  const slug = slugify(topic);
  const body = text.trim();
  if (title.length === 0) throw new Error("memory save requires a non-empty topic");
  if (body.length === 0) throw new Error("memory save requires non-empty text");
  const file = join(dir, `${slug}.md`);
  return withFileMutationQueue(indexPath(dir), async () => {
    await mkdir(dir, { recursive: true });
    let existing: string | undefined;
    try {
      existing = await readFile(file, "utf8");
    } catch {
      existing = undefined;
    }
    const created = existing === undefined;
    const merged = existing === undefined ? `# ${title}\n\n${body}\n` : `${existing.trimEnd()}\n\n${body}\n`;
    await writeFile(file, capBytes(merged, maxTopicBytes, title), "utf8");
    const refs = parseIndex(await readIndex(dir));
    const summary = oneLine(body, 100);
    const ref = refs.find((candidate) => candidate.slug === slug);
    if (ref) {
      ref.title = title;
      ref.summary = summary;
    } else {
      refs.push({ slug, title, summary });
    }
    try {
      await writeFile(indexPath(dir), formatIndex(refs), "utf8");
    } catch {}
    return { slug, created, file };
  });
}

export async function readTopic(dir: string, topic: string): Promise<string | undefined> {
  const slug = await resolveSlug(dir, topic);
  if (slug === undefined) return undefined;
  try {
    return await readFile(join(dir, `${slug}.md`), "utf8");
  } catch {
    return undefined;
  }
}

export async function forgetTopic(dir: string, topic: string): Promise<boolean> {
  const slug = await resolveSlug(dir, topic);
  if (slug === undefined) return false;
  return withFileMutationQueue(indexPath(dir), async () => {
    let removed = false;
    try {
      await rm(join(dir, `${slug}.md`));
      removed = true;
    } catch {}
    const refs = parseIndex(await readIndex(dir));
    const kept = refs.filter((ref) => ref.slug !== slug);
    if (kept.length !== refs.length) {
      try {
        await writeFile(indexPath(dir), formatIndex(kept), "utf8");
        removed = true;
      } catch {}
    }
    return removed;
  });
}
