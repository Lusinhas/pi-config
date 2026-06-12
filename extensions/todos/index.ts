import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type BaseStatus, type TodoPatch, type TodoPriority, type TodoSnapshot, TodoStore } from "./store";
import { buildReminder, formatTodoList, renderTodos } from "./widget";

interface TodosConfig {
  mirror: boolean;
  widget: boolean;
  inject: boolean;
  widgetLimit: number;
}

interface TodoArgs {
  op: "add" | "update" | "done" | "remove" | "list";
  id?: string;
  text?: string;
  status?: BaseStatus;
  deps?: string[];
  priority?: TodoPriority;
}

interface ToolText {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolText[];
  details: TodoSnapshot;
}

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

const DEFAULTS: TodosConfig = { mirror: true, widget: true, inject: true, widgetLimit: 8 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadConfig(): TodosConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "piconfig.json"));
  if (globalConfig && isRecord(globalConfig.todos)) merged = deepMerge(merged, globalConfig.todos);
  const projectConfig = readJson(join(process.cwd(), ".pi", "piconfig.json"));
  if (projectConfig && isRecord(projectConfig.todos)) merged = deepMerge(merged, projectConfig.todos);
  return {
    mirror: typeof merged.mirror === "boolean" ? merged.mirror : DEFAULTS.mirror,
    widget: typeof merged.widget === "boolean" ? merged.widget : DEFAULTS.widget,
    inject: typeof merged.inject === "boolean" ? merged.inject : DEFAULTS.inject,
    widgetLimit:
      typeof merged.widgetLimit === "number" && Number.isInteger(merged.widgetLimit) && merged.widgetLimit > 0
        ? merged.widgetLimit
        : DEFAULTS.widgetLimit,
  };
}

function requireId(id: string | undefined, op: string): string {
  const trimmed = (id ?? "").trim();
  if (trimmed === "") throw new Error(`op "${op}" requires an id`);
  return trimmed;
}

const todoParameters = Type.Object({
  op: StringEnum(["add", "update", "done", "remove", "list"], {
    description: "add a todo, update fields of one, mark one done, remove one, or list all",
  }),
  id: Type.Optional(Type.String({ description: "todo id; required for update, done, and remove" })),
  text: Type.Optional(Type.String({ description: "todo text; required for add, optional for update" })),
  status: Type.Optional(
    StringEnum(["open", "active", "done"], {
      description: "explicit status; blocked is derived automatically from unfinished dependencies",
    }),
  ),
  deps: Type.Optional(Type.Array(Type.String(), { description: "ids of todos this one depends on; cycles are rejected" })),
  priority: Type.Optional(StringEnum(["high", "medium", "low"], { description: "defaults to medium" })),
});

export default function todos(pi: ExtensionAPI): void {
  const config = loadConfig();
  const store = new TodoStore();

  const blockedIds = (): Set<string> =>
    new Set(
      store
        .list()
        .filter((item) => item.status === "blocked")
        .map((item) => item.id),
    );

  const freedNote = (before: Set<string>): string => {
    const freed = store
      .list()
      .filter((item) => before.has(item.id) && item.status !== "blocked" && item.status !== "done")
      .map((item) => item.id);
    return freed.length > 0 ? ` (unblocked: ${freed.join(", ")})` : "";
  };

  const broadcast = (): void => {
    try {
      const counts = store.counts();
      pi.events.emit("piconfig:todos", { open: counts.open, done: counts.done, items: store.list() });
    } catch {
      return;
    }
  };

  const mirrorPath = (ctx: ExtensionContext): string => {
    let project = ctx.cwd;
    try {
      project = realpathSync(ctx.cwd);
    } catch {
      project = ctx.cwd;
    }
    const hash = createHash("sha1").update(project).digest("hex").slice(0, 12);
    return join(homedir(), ".pi", "agent", "todos", `${hash}.json`);
  };

  const mirror = (ctx: ExtensionContext): void => {
    if (!config.mirror) return;
    try {
      const target = mirrorPath(ctx);
      mkdirSync(join(homedir(), ".pi", "agent", "todos"), { recursive: true });
      const snapshot = { project: ctx.cwd, todos: store.snapshot() };
      writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    } catch {
      return;
    }
  };

  const refreshWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    try {
      if (!config.widget) {
        ctx.ui.setWidget("todos", undefined);
        return;
      }
      const lines = renderTodos(store.list(), config.widgetLimit);
      ctx.ui.setWidget("todos", lines.length > 0 ? lines : undefined);
    } catch {
      return;
    }
  };

  const commit = (ctx: ExtensionContext): void => {
    try {
      pi.appendEntry("todos", store.snapshot());
    } catch {
      void 0;
    }
    broadcast();
    mirror(ctx);
    refreshWidget(ctx);
  };

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage the session task list. Ops: add (text required; optional deps, priority, status), update (id plus any of text, status, deps, priority), done (id), remove (id), list. Items show as blocked while any dependency is unfinished; completing or removing a dependency unblocks them. Dependency cycles are rejected.",
    parameters: todoParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const args = params as TodoArgs;
      const respond = (summary: string): ToolResult => ({
        content: [{ type: "text", text: `${summary}\n\n${formatTodoList(store.list())}` }],
        details: store.snapshot(),
      });
      switch (args.op) {
        case "add": {
          if (typeof args.text !== "string" || args.text.trim() === "") {
            throw new Error('op "add" requires non-empty text');
          }
          let item = store.add(args.text, args.deps, args.priority);
          if (args.status !== undefined && args.status !== "open") {
            item = store.update(item.id, { status: args.status });
          }
          commit(ctx);
          const blocking = item.deps.filter((dep) => {
            const target = store.get(dep);
            return target !== undefined && target.status !== "done";
          });
          const blockedTag = item.status === "blocked" ? ` (blocked by ${blocking.join(", ")})` : "";
          return respond(`Added ${item.id}: ${item.text}${blockedTag}`);
        }
        case "update": {
          const id = requireId(args.id, "update");
          const patch: TodoPatch = {};
          if (args.text !== undefined) patch.text = args.text;
          if (args.status !== undefined) patch.status = args.status;
          if (args.deps !== undefined) patch.deps = args.deps;
          if (args.priority !== undefined) patch.priority = args.priority;
          const before = blockedIds();
          const item = store.update(id, patch);
          commit(ctx);
          return respond(`Updated ${item.id}: ${item.text} [${item.status}]${freedNote(before)}`);
        }
        case "done": {
          const id = requireId(args.id, "done");
          const before = blockedIds();
          const item = store.done(id);
          commit(ctx);
          return respond(`Completed ${item.id}: ${item.text}${freedNote(before)}`);
        }
        case "remove": {
          const id = requireId(args.id, "remove");
          const before = blockedIds();
          const item = store.remove(id);
          commit(ctx);
          return respond(`Removed ${item.id}: ${item.text}${freedNote(before)}`);
        }
        case "list":
          return {
            content: [{ type: "text", text: formatTodoList(store.list()) }],
            details: store.snapshot(),
          };
        default:
          throw new Error(`unknown op "${String(args.op)}"`);
      }
    },
  });

  pi.registerCommand("todos", {
    description: "List todos; /todos clear removes all; /todos done <id> completes one",
    getArgumentCompletions: (argumentPrefix: string): CompletionItem[] | null => {
      const prefix = argumentPrefix.trimStart();
      const candidates: CompletionItem[] = [{ value: "clear", label: "clear", description: "remove all todos" }];
      for (const item of store.list()) {
        if (item.status !== "done") {
          candidates.push({ value: `done ${item.id}`, label: `done ${item.id}`, description: item.text });
        }
      }
      const matches = candidates.filter((candidate) => candidate.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx): Promise<void> => {
      const notify = (message: string, level: "info" | "warning" | "error"): void => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
      };
      const trimmed = (args ?? "").trim();
      if (trimmed === "") {
        notify(formatTodoList(store.list()), "info");
        refreshWidget(ctx);
        return;
      }
      const [sub, ...rest] = trimmed.split(/\s+/);
      if (sub === "clear") {
        if (store.size() === 0) {
          notify("No todos to clear.", "info");
          return;
        }
        if (ctx.hasUI) {
          const confirmed = await ctx.ui.confirm("Clear todos", `Remove all ${store.size()} todos?`);
          if (!confirmed) return;
        }
        const removed = store.clear();
        commit(ctx);
        notify(`Cleared ${removed} todo${removed === 1 ? "" : "s"}.`, "info");
        return;
      }
      if (sub === "done") {
        const id = rest.join(" ").trim();
        if (id === "") {
          notify("Usage: /todos done <id>", "error");
          return;
        }
        try {
          const before = blockedIds();
          const item = store.done(id);
          commit(ctx);
          notify(`Completed ${item.id}: ${item.text}${freedNote(before)}`, "info");
        } catch (error) {
          notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      notify(`Unknown subcommand "${sub}". Usage: /todos | /todos clear | /todos done <id>`, "error");
    },
  });

  pi.on("before_agent_start", () => {
    if (!config.inject) return;
    const reminder = buildReminder(store.list());
    if (reminder === "") return;
    return { message: { customType: "todosreminder", content: reminder, display: false } };
  });

  pi.on("session_start", (_event, ctx) => {
    let latest: unknown;
    let found = false;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        const rec = entry as unknown as Record<string, unknown>;
        if (rec.type === "custom" && rec.customType === "todos") {
          latest = rec.data;
          found = true;
        }
      }
    } catch {
      found = false;
    }
    const restored = found && store.restore(latest);
    if (!restored && store.size() > 0) store.clear();
    broadcast();
    if (restored) mirror(ctx);
    refreshWidget(ctx);
  });
}
