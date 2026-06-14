import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  CommandHandler,
  McpRegistry,
  ServerFormatter,
  type CommandDescriptor,
  type CommandSession,
  type ManagedServer,
  type NotifyFn,
  type RegistryCollaborators,
  type ToolDescriptor,
} from "../mcp/index.ts";
import { ServerCache, collectServerSpecs } from "../mcp/cache.ts";
import { OAuth, type AuthUi } from "../mcp/oauth.ts";
import type { McpConfig } from "./config.ts";
import type { LifecycleHub } from "./lifecycle.ts";

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

function toParameters(schema: Record<string, unknown> | null): TSchema {
  if (schema !== null && schema.type === "object") {
    return Type.Unsafe(schema);
  }

  return Type.Unsafe({ type: "object", properties: {}, additionalProperties: true });
}

export class McpRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: McpConfig;
  private readonly hub: LifecycleHub;
  private readonly oauth: OAuth;
  private readonly registry: McpRegistry;
  private readonly formatter: ServerFormatter;
  private readonly handler: CommandHandler;

  constructor(pi: ExtensionAPI, config: McpConfig, hub: LifecycleHub) {
    this.pi = pi;
    this.config = config;
    this.hub = hub;
    this.oauth = new OAuth();

    const collaborators: RegistryCollaborators = {
      oauth: this.oauth,
      cache: new ServerCache(),
      truncate: (text, options) => truncateTail(text, options),
      sendUserMessage: (text) => this.sendUserMessage(text),
      toolRegistrar: { register: (descriptor) => this.registerTool(descriptor) },
      commandRegistrar: { register: (descriptor) => this.registerPromptCommand(descriptor) },
    };

    this.registry = new McpRegistry(
      {
        outputLimit: config.outputLimit,
        inlineLimit: config.inlineLimit,
        requestTimeoutMs: config.requestTimeoutMs,
        startTimeoutMs: config.startTimeoutMs,
        idleMs: config.idleMs,
        stderrLines: config.stderrLines,
      },
      collaborators,
    );
    this.formatter = new ServerFormatter(this.registry);
    this.handler = new CommandHandler(this.registry, this.formatter);
  }

  register(): void {
    for (const spec of collectServerSpecs(this.config.servers, this.config.framing, process.cwd(), this.config.lazy)) {
      this.registry.addServer(spec);
    }

    let started = false;

    this.hub.on("session_start", () => {
      if (!started) {
        started = true;
        this.registry.startAll();
      }

      return undefined;
    });

    this.hub.on("session_shutdown", async () => {
      await this.registry.shutdown();

      return undefined;
    });

    this.registerMcpCommand();
  }

  private sendUserMessage(text: string): void {
    try {
      this.pi.sendMessage({ content: text, display: true }, { deliverAs: "userMessage" });
    } catch {
      return;
    }
  }

  private registerTool(descriptor: ToolDescriptor): void {
    this.pi.registerTool({
      name: descriptor.name,
      label: descriptor.label,
      description: descriptor.description,
      parameters: toParameters(descriptor.schema),
      execute: async (toolCallId, params, signal, onUpdate) =>
        descriptor.execute(toolCallId, params as Record<string, unknown>, signal, onUpdate),
    });
  }

  private registerPromptCommand(descriptor: CommandDescriptor): void {
    this.pi.registerCommand(descriptor.name, {
      description: descriptor.description,
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const notify: NotifyFn = (message, level) => {
          if (ctx.hasUI) {
            ctx.ui.notify(message, level);
          }
        };

        await descriptor.handler(args ?? "", notify);
      },
    });
  }

  private registerMcpCommand(): void {
    this.pi.registerCommand("mcp", {
      description: "List MCP servers; /mcp restart <name> restarts one; /mcp auth <name> runs OAuth for an HTTP server",
      getArgumentCompletions: (argumentPrefix: string): CompletionItem[] | null => this.handler.completions(argumentPrefix),
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const session: CommandSession = {
          hasUI: ctx.hasUI,
          notify: (message, level) => {
            if (ctx.hasUI) {
              ctx.ui.notify(message, level);
            }
          },
          authorize: (server: ManagedServer) => this.authorize(server, ctx),
        };

        await this.handler.handle(args ?? "", session);
      },
    });
  }

  private async authorize(server: ManagedServer, ctx: ExtensionCommandContext): Promise<void> {
    if (server.spec.kind !== "http") {
      return;
    }

    const authUi: AuthUi = {
      hasUI: ctx.hasUI,
      ui: {
        notify: (message, level) => ctx.ui.notify(message, level),
        input: (title, placeholder) => ctx.ui.input(title, placeholder),
      },
    };

    await this.oauth.authorize(server.spec.name, server.spec.url, server.wwwAuthenticate, authUi, this.config.authTimeoutMs);
  }
}
