import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TodosConfig } from "../todos/config.ts";
import { type BaseStatus, type TodoPatch, type TodoPriority, type TodoSnapshot, TodoStore } from "../todos/index.ts";
import { TodoRender } from "../todos/render.ts";
import { TodoEngine } from "../todos/summaries.ts";
import { TodoMirror } from "../todos/mirror.ts";

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

const TOOL_DESCRIPTION =
  "Manage the session task list. Ops: add (text required; optional deps, priority, status), update (id plus any of text, status, deps, priority), done (id), remove (id), list. Items show as blocked while any dependency is unfinished; completing or removing a dependency unblocks them. Dependency cycles are rejected.";


const TODO_HANDLE_KEY = Symbol.for("piconfig.todo");

interface TodoHandle {
  execute(params: Record<string, unknown>, ctx: ExtensionContext): Promise<ToolResult>;
}

export class TodosRegistrar {
  private readonly store = new TodoStore();
  private readonly render = new TodoRender();
  private readonly engine = new TodoEngine(this.store);
  private readonly mirror = new TodoMirror(this.store);

  private lastReminder = "";

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: TodosConfig,
  ) {}

  register(): void {
    this.registerTool();
    this.registerCommand();
    this.registerInjection();
    this.registerRestore();
    this.publishHandle();
  }

  private publishHandle(): void {
    const host = globalThis as unknown as Record<symbol, unknown>;
    const handle: TodoHandle = {
      execute: (params, ctx) => this.run(params as unknown as TodoArgs, ctx),
    };

    host[TODO_HANDLE_KEY] = handle;
  }

  private broadcast(): void {
    try {
      const counts = this.store.counts();

      this.pi.events.emit("piconfig:todos", { open: counts.open, done: counts.done, items: this.store.list() });
    } catch {
      return;
    }
  }

  private writeMirror(ctx: ExtensionContext): void {
    if (!this.config.mirror) {
      return;
    }

    try {
      this.mirror.writeMirror(ctx.cwd);
    } catch {
      return;
    }
  }

  private refreshWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return;
    }

    try {
      if (!this.config.widget) {
        ctx.ui.setWidget("todos", undefined);

        return;
      }

      const lines = this.render.renderTodos(this.store.list(), this.config.widgetLimit);

      ctx.ui.setWidget("todos", lines.length > 0 ? lines : undefined);
    } catch {
      return;
    }
  }

  private commit(ctx: ExtensionContext): void {
    try {
      this.pi.appendEntry("todos", this.store.snapshot());
    } catch {
      void 0;
    }

    this.broadcast();
    this.writeMirror(ctx);
    this.refreshWidget(ctx);
  }

  private registerTool(): void {
    this.pi.registerTool({
      name: "todo",
      label: "Todo",
      description: TOOL_DESCRIPTION,
      parameters: todoParameters,
      execute: (_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> => this.run(params as TodoArgs, ctx),
    });
  }

  async run(args: TodoArgs, ctx: ExtensionContext): Promise<ToolResult> {
    const delta = (summary: string): ToolResult => ({
      content: [{ type: "text", text: this.engine.delta(summary) }],
      details: this.store.snapshot(),
    });

    switch (args.op) {
      case "add": {
        if (typeof args.text !== "string" || args.text.trim() === "") {
          throw new Error('op "add" requires non-empty text');
        }

        let item = this.store.add(args.text, args.deps, args.priority);

        if (args.status !== undefined && args.status !== "open") {
          item = this.store.update(item.id, { status: args.status });
        }

        this.commit(ctx);

        return delta(this.engine.addedSummary(item));
      }
      case "update": {
        const id = this.engine.requireId(args.id, "update");
        const patch: TodoPatch = {};

        if (args.text !== undefined) {
          patch.text = args.text;
        }

        if (args.status !== undefined) {
          patch.status = args.status;
        }

        if (args.deps !== undefined) {
          patch.deps = args.deps;
        }

        if (args.priority !== undefined) {
          patch.priority = args.priority;
        }

        const before = this.engine.blockedIds();
        const item = this.store.update(id, patch);

        this.commit(ctx);

        return delta(this.engine.updatedSummary(item, before));
      }
      case "done": {
        const id = this.engine.requireId(args.id, "done");
        const before = this.engine.blockedIds();
        const item = this.store.done(id);

        this.commit(ctx);

        return delta(this.engine.doneSummary(item, before));
      }
      case "remove": {
        const id = this.engine.requireId(args.id, "remove");
        const before = this.engine.blockedIds();
        const item = this.store.remove(id);

        this.commit(ctx);

        return delta(this.engine.removedSummary(item, before));
      }
      case "list":
        return {
          content: [{ type: "text", text: this.render.formatTodoList(this.store.list()) }],
          details: this.store.snapshot(),
        };
      default:
        throw new Error(`unknown op "${String(args.op)}"`);
    }
  }

  private registerCommand(): void {
    const store = this.store;
    const engine = this.engine;
    const render = this.render;

    this.pi.registerCommand("todos", {
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
          if (ctx.hasUI) {
            ctx.ui.notify(message, level);
          }
        };
        const trimmed = (args ?? "").trim();

        if (trimmed === "") {
          notify(render.formatTodoList(store.list()), "info");
          this.refreshWidget(ctx);

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

            if (!confirmed) {
              return;
            }
          }

          const removed = store.clear();

          this.commit(ctx);
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
            const before = engine.blockedIds();
            const item = store.done(id);

            this.commit(ctx);
            notify(engine.doneSummary(item, before), "info");
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), "error");
          }

          return;
        }

        notify(`Unknown subcommand "${sub}". Usage: /todos | /todos clear | /todos done <id>`, "error");
      },
    });
  }

  private registerInjection(): void {
    this.pi.on("before_agent_start", () => {
      if (!this.config.inject) {
        return undefined;
      }

      const reminder = this.render.buildReminder(this.store.list());

      if (reminder === "") {
        this.lastReminder = "";

        return undefined;
      }

      const fingerprint = this.engine.reminderFingerprint(reminder);

      if (fingerprint === this.lastReminder) {
        return undefined;
      }

      this.lastReminder = fingerprint;

      return { message: { customType: "todosreminder", content: reminder, display: false } };
    });
  }

  private registerRestore(): void {
    this.pi.on("session_start", (_event, ctx) => {
      let selection: { found: boolean; data: unknown } = { found: false, data: undefined };

      try {
        selection = this.engine.selectRestoreData(ctx.sessionManager.getEntries() as Iterable<Record<string, unknown>>);
      } catch {
        selection = { found: false, data: undefined };
      }

      const restored = selection.found && this.store.restore(selection.data);

      if (!restored && this.store.size() > 0) {
        this.store.clear();
      }

      this.lastReminder = "";
      this.broadcast();

      if (restored) {
        this.writeMirror(ctx);
      }

      this.refreshWidget(ctx);
    });
  }
}

export function registerTodos(pi: ExtensionAPI, config: TodosConfig): void {
  new TodosRegistrar(pi, config).register();
}
