import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages.js";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { ModelCatalog } from "../models/catalog.ts";
import { ClaudeCodeTransform } from "../transforms/reshape.ts";

const CLAUDE_CODE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

type StreamBlock = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & {
  index: number;
  argumentsParseError?: string;
  argumentsParseErrorWarned?: boolean;
};

export class AnthropicStream {
  private readonly catalog: ModelCatalog;
  private readonly transform: ClaudeCodeTransform;
  private readonly longContext: boolean;
  private readonly ccToolLookup: Map<string, string>;

  constructor(catalog: ModelCatalog, transform: ClaudeCodeTransform, longContext: boolean) {
    this.catalog = catalog;
    this.transform = transform;
    this.longContext = longContext;
    this.ccToolLookup = new Map(CLAUDE_CODE_TOOLS.map((t) => [t.toLowerCase(), t]));
    this.streamSimple = this.streamSimple.bind(this);
  }

  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();

    void this.run(model, context, options, stream);

    return stream;
  }

  private async run(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    stream: AssistantMessageEventStream,
  ): Promise<void> {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = options?.apiKey ?? "";

      const betas = this.catalog.requestBetas(model.id, this.longContext);
      const version = process.env.ANTHROPIC_CLI_VERSION ?? this.catalog.ccVersion;
      const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli";
      const userAgent =
        process.env.ANTHROPIC_USER_AGENT ?? `claude-cli/${version} (external, ${entrypoint})`;

      const client = new Anthropic({
        baseURL: model.baseUrl,
        apiKey: null,
        authToken: apiKey,
        defaultHeaders: {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": betas.join(","),
          "user-agent": userAgent,
          "x-app": "cli",
        },
      });

      let params: MessageCreateParamsStreaming = {
        model: model.id,
        messages: this.convertMessages(context.messages),
        max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
        stream: true,
      };

      params.system = [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" },
        },
      ];

      if (context.systemPrompt) {
        params.system.push({
          type: "text",
          text: this.sanitizeSurrogates(context.systemPrompt),
          cache_control: { type: "ephemeral" },
        });
      }

      if (context.tools) {
        params.tools = this.convertTools(context.tools);
      }

      if (options?.reasoning && model.reasoning) {
        if (this.catalog.getOverride(model.id)?.adaptiveThinking) {
          params.thinking = { type: "adaptive" } as never;
          (params as { output_config?: unknown }).output_config = {
            effort: this.toEffort(options.reasoning),
          };
        } else {
          const defaultBudgets: Record<string, number> = {
            minimal: 1024,
            low: 4096,
            medium: 10240,
            high: 20480,
            xhigh: 32768,
            max: 64000,
          };
          const customBudget =
            options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets];

          params.thinking = {
            type: "enabled",
            budget_tokens: customBudget ?? defaultBudgets[options.reasoning] ?? 10240,
          };
        }
      }

      params = this.transform.apply(params);

      const anthropicStream = client.messages.stream({ ...params }, { signal: options?.signal });
      stream.push({ type: "start", partial: output });

      const blocks = output.content as StreamBlock[];

      for await (const event of anthropicStream) {
        if (event.type === "message_start") {
          output.usage.input = event.message.usage.input_tokens || 0;
          output.usage.output = event.message.usage.output_tokens || 0;
          output.usage.cacheRead = (event.message.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens || 0;
          output.usage.cacheWrite = (event.message.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens || 0;
          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(model, output.usage);
        } else if (event.type === "content_block_start") {
          this.onBlockStart(event, output, blocks, context, stream);
        } else if (event.type === "content_block_delta") {
          this.onBlockDelta(event, output, blocks, stream);
        } else if (event.type === "content_block_stop") {
          this.onBlockStop(event, output, blocks, stream);
        } else if (event.type === "message_delta") {
          if ((event.delta as { stop_reason?: string }).stop_reason) {
            output.stopReason = this.mapStopReason((event.delta as { stop_reason: string }).stop_reason);
          }

          if (typeof (event.usage as { output_tokens?: number }).output_tokens === "number") {
            output.usage.output = (event.usage as { output_tokens: number }).output_tokens;
          }

          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
      }

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
      }

      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  }

  private onBlockStart(
    event: { index: number; content_block: { type: string; id?: string; name?: string } },
    output: AssistantMessage,
    blocks: StreamBlock[],
    context: Context,
    stream: AssistantMessageEventStream,
  ): void {
    void blocks;

    if (event.content_block.type === "text") {
      output.content.push({ type: "text", text: "", index: event.index } as never);
      stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
    } else if (event.content_block.type === "thinking") {
      output.content.push({
        type: "thinking",
        thinking: "",
        thinkingSignature: "",
        index: event.index,
      } as never);
      stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
    } else if (event.content_block.type === "tool_use") {
      const stripped = this.transform.unprefixToolName(event.content_block.name ?? "");
      const resolved = this.fromClaudeCodeName(stripped, context.tools);

      output.content.push({
        type: "toolCall",
        id: event.content_block.id,
        name: resolved,
        arguments: {},
        partialJson: "",
        index: event.index,
      } as never);
      stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
    }
  }

  private onBlockDelta(
    event: { index: number; delta: Record<string, string> & { type: string } },
    output: AssistantMessage,
    blocks: StreamBlock[],
    stream: AssistantMessageEventStream,
  ): void {
    const index = blocks.findIndex((b) => b.index === event.index);
    const block = blocks[index];

    if (!block) {
      return;
    }

    if (event.delta.type === "text_delta" && block.type === "text") {
      block.text += event.delta.text;
      stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
    } else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += event.delta.thinking;
      stream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: output });
    } else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
      (block as { partialJson: string }).partialJson += event.delta.partial_json;
      stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: output });
    } else if (event.delta.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = (block.thinkingSignature || "") + event.delta.signature;
    }
  }

  private onBlockStop(
    event: { index: number },
    output: AssistantMessage,
    blocks: StreamBlock[],
    stream: AssistantMessageEventStream,
  ): void {
    const index = blocks.findIndex((b) => b.index === event.index);
    const block = blocks[index];

    if (!block) {
      return;
    }

    delete (block as { index?: number }).index;

    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
    } else if (block.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
    } else if (block.type === "toolCall") {
      this.parseToolCallArguments(block);
      delete (block as { partialJson?: string }).partialJson;
      delete (block as { argumentsParseErrorWarned?: boolean }).argumentsParseErrorWarned;
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
    }
  }

  private parseToolCallArguments(block: StreamBlock): void {
    if (block.type !== "toolCall") {
      return;
    }

    if (!block.partialJson || !block.partialJson.trim()) {
      block.arguments = {};
      delete block.argumentsParseError;

      return;
    }

    try {
      block.arguments = JSON.parse(block.partialJson);
      delete block.argumentsParseError;
    } catch (err) {
      block.arguments = {};
      block.argumentsParseError = String(err);

      if (!block.argumentsParseErrorWarned) {
        console.warn("Failed to parse tool_use partialJson", {
          id: block.id,
          name: block.name,
          partialJson: block.partialJson.slice(0, 200),
        });
        block.argumentsParseErrorWarned = true;
      }
    }
  }

  private convertMessages(messages: Message[]): MessageParam[] {
    const params: MessageParam[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          if (msg.content.trim()) {
            params.push({ role: "user", content: this.sanitizeSurrogates(msg.content) });
          }
        } else {
          const blocks: ContentBlockParam[] = msg.content.map((item) =>
            item.type === "text"
              ? { type: "text" as const, text: this.sanitizeSurrogates(item.text) }
              : {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: item.mimeType as never,
                    data: item.data,
                  },
                },
          );

          if (blocks.length > 0) {
            params.push({ role: "user", content: blocks });
          }
        }
      } else if (msg.role === "toolResult") {
        const toolResults: ContentBlockParam[] = [];
        toolResults.push({
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: this.convertContentBlocks(msg.content) as never,
          is_error: msg.isError,
        });

        let j = i + 1;

        while (j < messages.length && messages[j].role === "toolResult") {
          const nextMsg = messages[j] as ToolResultMessage;
          toolResults.push({
            type: "tool_result",
            tool_use_id: nextMsg.toolCallId,
            content: this.convertContentBlocks(nextMsg.content) as never,
            is_error: nextMsg.isError,
          });
          j++;
        }

        i = j - 1;
        params.push({ role: "user", content: toolResults });
      } else if (msg.role === "assistant") {
        const blocks: ContentBlockParam[] = [];

        for (const block of msg.content) {
          if (block.type === "text" && block.text.trim()) {
            blocks.push({ type: "text", text: this.sanitizeSurrogates(block.text) });
          } else if (block.type === "thinking") {
            continue;
          } else if (block.type === "toolCall") {
            blocks.push({
              type: "tool_use",
              id: block.id,
              name: this.toClaudeCodeName(block.name),
              input: block.arguments,
            });
          }
        }

        if (blocks.length === 0) {
          blocks.push({ type: "text", text: "(no content)" });
        }

        params.push({ role: "assistant", content: blocks });
      }
    }

    if (params.length > 0) {
      const last = params[params.length - 1];

      if (last.role === "user" && Array.isArray(last.content)) {
        const lastBlock = last.content[last.content.length - 1];

        if (lastBlock) {
          (lastBlock as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
        }
      }
    }

    return params;
  }

  private convertContentBlocks(
    content: (TextContent | ImageContent)[],
  ): string | Array<{ type: "text"; text: string } | { type: "image"; source: unknown }> {
    const hasImages = content.some((c) => c.type === "image");

    if (!hasImages) {
      return this.sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
    }

    const blocks = content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: this.sanitizeSurrogates(block.text) };
      }

      return {
        type: "image" as const,
        source: { type: "base64" as const, media_type: block.mimeType, data: block.data },
      };
    });

    if (!blocks.some((b) => b.type === "text")) {
      blocks.unshift({ type: "text" as const, text: "(see attached image)" });
    }

    return blocks;
  }

  private convertTools(tools: Tool[]): unknown[] {
    return tools.map((tool) => ({
      name: this.toClaudeCodeName(tool.name),
      description: tool.description,
      input_schema: {
        type: "object",
        properties: (tool.parameters as { properties?: unknown }).properties || {},
        required: (tool.parameters as { required?: unknown }).required || [],
      },
    }));
  }

  private toClaudeCodeName(name: string): string {
    return this.ccToolLookup.get(name.toLowerCase()) ?? name;
  }

  private fromClaudeCodeName(name: string, tools?: Tool[]): string {
    const lowerName = name.toLowerCase();
    const matched = tools?.find((t) => t.name.toLowerCase() === lowerName);

    return matched?.name ?? name;
  }

  private toEffort(level: string): string {
    return level === "minimal" ? "low" : level;
  }

  private sanitizeSurrogates(text: string): string {
    return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
  }

  private mapStopReason(reason: string): StopReason {
    switch (reason) {
      case "end_turn":
      case "pause_turn":
      case "stop_sequence":
        return "stop";
      case "max_tokens":
        return "length";
      case "tool_use":
        return "toolUse";
      default:
        return "error";
    }
  }
}
