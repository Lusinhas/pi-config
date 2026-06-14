import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "../keywords/config.ts";
import { KeywordsEngine, type ThinkingPort } from "../keywords/index.ts";
import { isLevel, type ThinkingLevel } from "../keywords/scan.ts";

class PiThinkingPort implements ThinkingPort {
  constructor(private readonly pi: ExtensionAPI) {}

  current(): ThinkingLevel | undefined {
    try {
      const value = this.pi.getThinkingLevel();

      return isLevel(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  apply(target: ThinkingLevel): boolean {
    try {
      this.pi.setThinkingLevel(target);

      return true;
    } catch {
      return false;
    }
  }

  taskAvailable(): boolean {
    try {
      return this.pi.getActiveTools().includes("task");
    } catch {
      return false;
    }
  }
}

export class KeywordsRegistrar {
  private readonly engine: KeywordsEngine;

  constructor(
    private readonly pi: ExtensionAPI,
    config: Config,
  ) {
    this.engine = new KeywordsEngine(config, new PiThinkingPort(pi));
  }

  register(): void {
    this.pi.on("session_start", () => {
      this.engine.onSessionStart();
    });

    this.pi.on("thinking_level_select", (event: { level?: unknown; previousLevel?: unknown }) => {
      this.engine.onThinkingLevelSelect(event.level);
    });

    this.pi.on("input", (event: { text?: unknown; source?: unknown }) => {
      const result = this.engine.processInput(event.text, event.source);

      if (result.action === "transform") {
        return { action: "transform" as const, text: result.text };
      }

      return { action: "continue" as const };
    });

    this.pi.on("agent_end", () => {
      this.engine.onAgentEnd();
    });

    this.registerCommand();
  }

  private notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error"): void {
    if (!ctx.hasUI) {
      return;
    }

    try {
      ctx.ui.notify(message, kind);
    } catch {
      return;
    }
  }

  private registerCommand(): void {
    this.pi.registerCommand("keywords", {
      description: "List magic keywords and adaptive thinking state, or toggle adaptive (/keywords adaptive [on|off])",
      handler: async (args, ctx) => {
        const result = this.engine.command(args);

        this.notify(ctx, result.message, result.kind === "error" ? "error" : "info");
      },
      getArgumentCompletions: (prefix: string) => this.engine.completions(prefix),
    });
  }
}

export function registerKeywords(pi: ExtensionAPI, config: Config): void {
  new KeywordsRegistrar(pi, config).register();
}
