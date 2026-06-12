import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerConsolidation } from "./consolidate";
import { registerInject } from "./inject";
import {
  clip,
  forgetTopic,
  listTopics,
  memoryDir,
  readIndex,
  readTopic,
  saveTopic,
  type MemoryConfig,
} from "./store";

const defaults: MemoryConfig = {
  injectBudget: 2000,
  consolidateEvery: 0,
  consolidateOnQuit: true,
  model: "",
  maxFacts: 3,
  recallBudget: 6000,
  maxTopicBytes: 65536,
  transcriptBudget: 12000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    if (isRecord(current) && isRecord(value)) {
      out[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function sanitize(raw: Record<string, unknown>): MemoryConfig {
  const num = (value: unknown, fallback: number, min: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
  return {
    injectBudget: num(raw.injectBudget, defaults.injectBudget, 100),
    consolidateEvery: num(raw.consolidateEvery, defaults.consolidateEvery, 0),
    consolidateOnQuit: typeof raw.consolidateOnQuit === "boolean" ? raw.consolidateOnQuit : defaults.consolidateOnQuit,
    model: typeof raw.model === "string" ? raw.model : defaults.model,
    maxFacts: Math.min(num(raw.maxFacts, defaults.maxFacts, 1), 10),
    recallBudget: num(raw.recallBudget, defaults.recallBudget, 500),
    maxTopicBytes: num(raw.maxTopicBytes, defaults.maxTopicBytes, 4096),
    transcriptBudget: num(raw.transcriptBudget, defaults.transcriptBudget, 1000),
  };
}

function loadConfig(): MemoryConfig {
  let merged: Record<string, unknown> = { ...defaults };
  try {
    const shipped: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(shipped)) merged = deepMerge(merged, shipped);
  } catch {}
  const overridePaths = [join(homedir(), ".pi", "agent", "suite.json"), join(process.cwd(), ".pi", "suite.json")];
  for (const path of overridePaths) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(parsed) && isRecord(parsed.memory)) merged = deepMerge(merged, parsed.memory);
    } catch {}
  }
  return sanitize(merged);
}

function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, kind);
}

export default function memory(pi: ExtensionAPI): void {
  const cfg = loadConfig();
  registerInject(pi, cfg);
  const consolidate = registerConsolidation(pi, cfg);

  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      'Persistent cross-session project memory stored under ~/.pi/agent/memory. Ops: "save" appends a durable fact to a topic file and updates the index (requires topic and text); "recall" returns the index plus the full body of one topic (topic optional: omit it to get just the index); "list" shows all topics; "forget" deletes a topic (requires topic). Save stable project facts, explicit user preferences, and hard-won gotchas. Never save source code or anything git already tracks.',
    parameters: Type.Object({
      op: StringEnum(["save", "recall", "list", "forget"], { description: "Memory operation to perform" }),
      topic: Type.Optional(Type.String({ description: "Topic name, a short noun phrase; required for save and forget, optional for recall" })),
      text: Type.Optional(Type.String({ description: "Fact text to store; required for save" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const dir = memoryDir(ctx.cwd);
      const topic = params.topic?.trim() ?? "";
      if (params.op === "save") {
        const text = params.text?.trim() ?? "";
        if (topic.length === 0) throw new Error('memory op "save" requires a topic');
        if (text.length === 0) throw new Error('memory op "save" requires text');
        const result = await saveTopic(dir, topic, text, cfg.maxTopicBytes);
        return {
          content: [{ type: "text", text: `${result.created ? "Created" : "Updated"} memory topic "${result.slug}" (${result.file})` }],
          details: result,
        };
      }
      if (params.op === "recall") {
        const index = (await readIndex(dir)).trim();
        if (topic.length === 0) {
          const text = index.length > 0 ? `Memory index:\n${clip(index, cfg.recallBudget)}` : "No memories saved for this project yet.";
          return { content: [{ type: "text", text }], details: undefined };
        }
        const body = await readTopic(dir, topic);
        if (body === undefined) throw new Error(`No memory topic matches "${topic}"; use op "list" to see available topics`);
        const indexPart = index.length > 0 ? `Memory index:\n${clip(index, 1000)}\n\n` : "";
        return { content: [{ type: "text", text: `${indexPart}Topic "${topic}":\n${clip(body.trim(), cfg.recallBudget)}` }], details: undefined };
      }
      if (params.op === "list") {
        const topics = await listTopics(dir);
        const text =
          topics.length === 0
            ? "No memories saved for this project yet."
            : topics.map((ref) => `${ref.slug}${ref.summary.length > 0 ? ` — ${ref.summary}` : ""}`).join("\n");
        return { content: [{ type: "text", text }], details: { topics } };
      }
      if (topic.length === 0) throw new Error('memory op "forget" requires a topic');
      const removed = await forgetTopic(dir, topic);
      if (!removed) throw new Error(`No memory topic matches "${topic}"`);
      return { content: [{ type: "text", text: `Forgot memory topic "${topic}"` }], details: undefined };
    },
  });

  pi.registerCommand("memory", {
    description: "Show project memory index; subcommands: open <topic>, forget <topic>, consolidate",
    getArgumentCompletions: async (prefix: string) => {
      const subs = [
        { value: "open", label: "open", description: "Show a memory topic" },
        { value: "forget", label: "forget", description: "Delete a memory topic" },
        { value: "consolidate", label: "consolidate", description: "Extract durable facts from this session now" },
      ];
      const parts = prefix.split(/\s+/).filter((part) => part.length > 0);
      const trailing = /\s$/.test(prefix);
      if (parts.length === 0) return subs;
      if (parts.length === 1 && !trailing) {
        const matches = subs.filter((sub) => sub.value.startsWith(parts[0]));
        return matches.length > 0 ? matches : null;
      }
      const sub = parts[0];
      if (sub !== "open" && sub !== "forget") return null;
      const topicPrefix = trailing ? "" : parts.slice(1).join(" ");
      let topics;
      try {
        topics = await listTopics(memoryDir(process.cwd()));
      } catch {
        return null;
      }
      const items = topics
        .filter((ref) => ref.slug.startsWith(topicPrefix) || ref.title.toLowerCase().startsWith(topicPrefix.toLowerCase()))
        .map((ref) => ({
          value: `${sub} ${ref.slug}`,
          label: ref.slug,
          description: ref.summary.length > 0 ? ref.summary : ref.title,
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const dir = memoryDir(ctx.cwd);
      const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
      const sub = parts[0] ?? "";
      const rest = parts.slice(1).join(" ");
      if (sub === "") {
        const index = (await readIndex(dir)).trim();
        notify(ctx, index.length > 0 ? `Memory index (${dir}):\n${clip(index, 4000)}` : "No memories saved for this project yet.", "info");
        return;
      }
      if (sub === "open") {
        if (rest.length === 0) {
          notify(ctx, "Usage: /memory open <topic>", "warning");
          return;
        }
        const body = await readTopic(dir, rest);
        if (body === undefined) {
          notify(ctx, `No memory topic matches "${rest}"`, "warning");
          return;
        }
        notify(ctx, clip(body.trim(), 4000), "info");
        return;
      }
      if (sub === "forget") {
        if (rest.length === 0) {
          notify(ctx, "Usage: /memory forget <topic>", "warning");
          return;
        }
        if (ctx.hasUI) {
          const confirmed = await ctx.ui.confirm("Forget memory", `Delete memory topic "${rest}"?`);
          if (!confirmed) return;
        }
        const removed = await forgetTopic(dir, rest);
        notify(ctx, removed ? `Forgot memory topic "${rest}"` : `No memory topic matches "${rest}"`, removed ? "info" : "warning");
        return;
      }
      if (sub === "consolidate") {
        notify(ctx, "Consolidating session memory…", "info");
        const result = await consolidate(ctx);
        const summary =
          result.saved > 0
            ? `Saved ${result.saved} memory ${result.saved === 1 ? "fact" : "facts"}`
            : `No memories saved${result.reason.length > 0 ? ` (${result.reason})` : ""}`;
        notify(ctx, summary, "info");
        return;
      }
      notify(ctx, `Unknown subcommand "${sub}". Usage: /memory [open <topic> | forget <topic> | consolidate]`, "warning");
    },
  });
}
