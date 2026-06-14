import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ArtifactStore } from "../artifacts/index.ts";
import { Retrieve, Spiller, type ArtifactArgs, type ToolResult } from "../artifacts/retrieve.ts";
import type { ArtifactsConfig } from "../artifacts/render.ts";
import type { LifecycleHub } from "./lifecycle.ts";

export class ArtifactsRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: ArtifactsConfig;
  private readonly hub: LifecycleHub;
  private readonly store: ArtifactStore;
  private readonly retrieve: Retrieve;
  private readonly spiller: Spiller;

  constructor(pi: ExtensionAPI, config: ArtifactsConfig, hub: LifecycleHub) {
    this.pi = pi;
    this.config = config;
    this.hub = hub;
    this.store = new ArtifactStore();
    this.retrieve = new Retrieve(this.store, config);
    this.spiller = new Spiller(this.store, config);
  }

  register(): void {
    this.pi.registerTool({
      name: "artifact",
      label: "Artifact",
      description:
        'Read back oversized tool output that was spilled to a per-session artifact store. Pass {"id":"<id>"} to read from the start (add offset, a 1-based line, and limit to page); {"id":"list"} lists every artifact saved in this session.',
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: 'Artifact id from a spill banner, or "list" to see all session artifacts' }),
        ),
        offset: Type.Optional(Type.Number({ description: "1-based line number to start reading from (default 1)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return (default 200)" })),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> =>
        this.retrieve.execute(ctx, params as ArtifactArgs),
    });

    this.hub.on("session_start", (_event, ctx: ExtensionContext) => {
      try {
        this.store.prune(this.config.maxAgeDays);
      } catch {
        void 0;
      }

      this.store.attach(ctx);

      return undefined;
    });

    this.hub.on("tool_result", (event: { toolName?: unknown; content?: unknown }, ctx: ExtensionContext) => {
      const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";

      return this.spiller.decide(toolName, event.content, ctx);
    });
  }
}
