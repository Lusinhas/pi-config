import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PATH_KEYS, PATH_LIST_KEYS, RulesEngine, SEARCH_LOCATIONS } from "../rules/index.ts";
import { TouchTracker } from "../rules/matcher.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TrustContext {
  isProjectTrusted(): boolean;
}

export class RulesRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly engine: RulesEngine;
  private readonly tracker: TouchTracker;

  constructor(pi: ExtensionAPI, engine: RulesEngine, tracker: TouchTracker) {
    this.pi = pi;
    this.engine = engine;
    this.tracker = tracker;
  }

  register(): void {
    this.registerEvents();
    this.registerCommand();
  }

  private trustOf(ctx: TrustContext): boolean {
    try {
      return ctx.isProjectTrusted();
    } catch {
      return false;
    }
  }

  private registerEvents(): void {
    const pi = this.pi;

    pi.on("session_start", (_event, ctx) => {
      this.engine.refresh(ctx.cwd, this.trustOf(ctx));
      this.tracker.reset();
      this.engine.resetTurns();
    });

    pi.on("resources_discover", (event, ctx) => {
      if (event.reason !== "reload") {
        return undefined;
      }

      const cwd = typeof event.cwd === "string" && event.cwd !== "" ? event.cwd : ctx.cwd;
      this.engine.refresh(cwd, this.trustOf(ctx));

      return undefined;
    });

    pi.on("tool_call", (event, ctx) => {
      try {
        const input: unknown = event.input;

        if (!isRecord(input)) {
          return undefined;
        }

        if (event.toolName === "bash") {
          const rawCwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
          const base = rawCwd !== "" ? resolve(ctx.cwd, rawCwd) : ctx.cwd;

          if (rawCwd !== "") {
            this.tracker.touch(rawCwd, ctx.cwd, ctx.cwd);
          }

          if (typeof input.command === "string") {
            this.tracker.touchBashCommand(input.command, ctx.cwd, base);
          }

          return undefined;
        }

        for (const key of PATH_KEYS) {
          const value = input[key];

          if (typeof value === "string") {
            this.tracker.touch(value, ctx.cwd, ctx.cwd);
          }
        }

        for (const key of PATH_LIST_KEYS) {
          const value = input[key];

          if (Array.isArray(value)) {
            for (const item of value) {
              if (typeof item === "string") {
                this.tracker.touch(item, ctx.cwd, ctx.cwd);
              }
            }
          }
        }
      } catch {
        return undefined;
      }

      return undefined;
    });

    pi.on("before_agent_start", () => {
      const injection = this.engine.buildInjection(this.tracker.consume());

      if (injection === undefined) {
        return undefined;
      }

      return { message: injection };
    });
  }

  private registerCommand(): void {
    this.pi.registerCommand("rules", {
      description: "List discovered path-scoped rules with source, scope, last-turn activity, and parse errors",
      handler: async (_args, ctx): Promise<void> => {
        if (!ctx.hasUI) {
          return;
        }

        if (!this.engine.isTrusted()) {
          ctx.ui.notify("Rules: project is not trusted; rule files are not loaded.", "warning");
          return;
        }

        if (!this.engine.hasRulesOrErrors()) {
          ctx.ui.notify(`Rules: no rule files found. Searched: ${SEARCH_LOCATIONS}.`, "info");
          return;
        }

        ctx.ui.notify(this.engine.report().join("\n"), "info");
      },
    });
  }
}
