import { StringEnum } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SnapshotCache } from "../lines/index.ts";
import { formatSize } from "../lines/disk.ts";
import { ModeState } from "../lines/mode.ts";
import { Editor } from "../lines/editor.ts";
import type { CompletionItem, EditParams, ReadParams, ToolResult } from "../lines/editor.ts";
import type { HashlineConfig } from "../lines/config.ts";

const readParameters = Type.Object({
  path: Type.String({ description: "Absolute or cwd-relative path of the text file to read" }),
  offset: Type.Optional(Type.Number({ description: "1-based line number to start reading from (default 1)" })),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of lines to return (defaults to the configured cap, normally 2000)" }),
  ),
});

const editParameters = Type.Object({
  path: Type.String({ description: "Absolute or cwd-relative path of the text file to edit" }),
  edits: Type.Optional(
    Type.Array(
      Type.Object({
        anchor: Type.Optional(Type.String({ description: "Hash anchor from the latest read output, e.g. @abc1234" })),
        line: Type.Optional(
          Type.Number({
            description:
              "1-based line number from read output; required with anchor when identical content gives duplicate anchors",
          }),
        ),
        op: StringEnum(["replace", "insertafter", "insertbefore", "delete"], {
          description: "replace the anchored line, insert text after or before it, or delete it",
        }),
        text: Type.Optional(
          Type.String({
            description: "Replacement or inserted text; may span multiple lines; required for every op except delete",
          }),
        ),
      }),
      {
        minItems: 1,
        description:
          "Hash-anchor edits for one file; verified together and applied atomically. Include line with anchor when the read output shows duplicate @hash values.",
      },
    ),
  ),
  oldText: Type.Optional(
    Type.String({ description: "Compat form: exact existing text to replace; must match exactly one location" }),
  ),
  newText: Type.Optional(
    Type.String({ description: "Compat form: replacement text; pass an empty string to delete the match" }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Whole-file replacement: write this exact text as the entire file (no anchors or matching). Use alone, without edits or oldText/newText.",
    }),
  ),
});

function extractModelId(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;

    for (const key of ["id", "model", "name"]) {
      const candidate = record[key];

      if (typeof candidate === "string" && candidate !== "") {
        return candidate;
      }
    }
  }

  return "";
}

export class HashlineRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: HashlineConfig;
  private readonly editor: Editor;

  constructor(pi: ExtensionAPI, config: HashlineConfig) {
    this.pi = pi;
    this.config = config;
    this.editor = new Editor(new SnapshotCache(), config, new ModeState(config.modes, config.defaultMode));
  }

  register(): void {
    this.registerRead();
    this.registerEdit();
    this.registerCommand();
    this.registerEvents();
  }

  private registerRead(): void {
    const editor = this.editor;
    const config = this.config;

    this.pi.registerTool({
      name: "read",
      label: "Read",
      description: `Read a text file. Lines render as "@<hash> <line>: <text>"; use the @hash value as edit.anchor and include line when duplicate anchors need disambiguation. Content-bearing anchors survive line shifts; structural-only lines are line-scoped to avoid ambiguous braces. The edit tool verifies cached line content and can follow unambiguous line shifts. Returns up to ${config.maxLines} lines and ${formatSize(config.maxBytes)} with truncation notes; offset is 1-based, limit caps lines.`,
      parameters: readParameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
        return editor.read(params as ReadParams, ctx.cwd);
      },
    });
  }

  private registerEdit(): void {
    const editor = this.editor;

    this.pi.registerTool({
      name: "edit",
      label: "Edit",
      description:
        'Edit a text file using hash anchors from the most recent read; batch all changes to one file into a single call. Primary form: {path, edits: [{anchor, op, text?}]} where anchor is the @hash shown by read, and op is replace (text may be multi-line), insertafter, insertbefore, or delete. Every target anchor is verified against cached read content; if the line moved, edit resolves it only when the surrounding cached context is unambiguous. Edits apply atomically and the response shows the changed region with fresh anchors. Compat form: {path, oldText, newText} replaces one unique occurrence.',
      parameters: editParameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
        return editor.edit(params as EditParams, ctx.cwd, (abs, run) => withFileMutationQueue(abs, run));
      },
    });
  }

  private registerCommand(): void {
    const editor = this.editor;

    this.pi.registerCommand("hashline", {
      description: "Show hashline mode and edit stats; /hashline toggle|hashline|compat|auto switches mode",
      getArgumentCompletions: (argumentPrefix: string): CompletionItem[] | null => editor.completions(argumentPrefix),
      handler: async (args, ctx): Promise<void> => {
        const result = editor.command(args ?? "");

        if (ctx.hasUI) {
          ctx.ui.notify(result.message, result.level);
        }
      },
    });
  }

  private registerEvents(): void {
    const editor = this.editor;

    this.pi.on("model_select", (event) => {
      editor.selectModel(extractModelId(event.model));
    });

    this.pi.on("session_start", (_event, ctx) => {
      editor.startSession(extractModelId(ctx.model));
    });
  }
}
