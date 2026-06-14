import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text as TuiText, type Component } from "@earendil-works/pi-tui";
import { Engine } from "../ask/index.ts";
import { Text } from "../ask/display.ts";
import type { AskConfig } from "../ask/config.ts";
import { TIMEOUT_EPSILON_MS, type AskArgs, type AskResult, type Prompt, type Reply } from "../ask/types.ts";

const askParameters = Type.Object({
  question: Type.String({ description: "the question to ask the user" }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: "short answer label shown to the user" }),
      description: Type.Optional(Type.String({ description: "optional clarification shown next to the label" })),
    }),
    { minItems: 1, maxItems: 8, description: "1 to 8 answer choices" },
  ),
  multi: Type.Optional(Type.Boolean({ description: "allow selecting multiple options; defaults to false" })),
  allowOther: Type.Optional(
    Type.Boolean({ description: "offer a free-form Other answer in addition to the options; defaults to true" }),
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description:
        "seconds to wait for an answer before giving up; 0 means wait indefinitely; omitted uses the configured default",
    }),
  ),
});

class Driver {
  readonly #config: AskConfig;

  constructor(config: AskConfig) {
    this.#config = config;
  }

  async run(params: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<AskResult> {
    const engine = Engine.create(params as AskArgs, this.#config);

    if (!ctx.hasUI) {
      return engine.noUiResult();
    }

    const timeoutMs = engine.timeoutMs();
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;

    let step = engine.start();

    while (step.kind === "prompt") {
      const reply = await this.#ask(step.prompt, signal, deadline, ctx);

      step = engine.advance(reply);
    }

    return step.result;
  }

  async #ask(
    prompt: Prompt,
    signal: AbortSignal | undefined,
    deadline: number | undefined,
    ctx: ExtensionContext,
  ): Promise<Reply> {
    const opts: { signal?: AbortSignal; timeout?: number } = {};

    if (signal !== undefined) {
      opts.signal = signal;
    }

    if (deadline !== undefined) {
      opts.timeout = Math.max(deadline - Date.now(), 1);
    }

    const value =
      prompt.kind === "select"
        ? await ctx.ui.select(prompt.title, prompt.displays, opts)
        : await ctx.ui.input(prompt.title, prompt.placeholder, opts);

    if (value === undefined) {
      const timedOut = deadline !== undefined && Date.now() >= deadline - TIMEOUT_EPSILON_MS;
      const aborted = signal?.aborted === true;

      return { kind: "empty", timedOut, aborted };
    }

    return { kind: "picked", value };
  }
}

class Renderer {
  render(args: unknown, theme: Theme): Component {
    const call = args as Partial<AskArgs>;
    const count = Array.isArray(call.options) ? call.options.length : 0;
    const flags: string[] = [`${count} option${count === 1 ? "" : "s"}`];

    if (call.multi === true) {
      flags.push("multi");
    }

    if (call.allowOther === false) {
      flags.push("no other");
    }

    if (typeof call.timeoutSec === "number" && Number.isFinite(call.timeoutSec) && call.timeoutSec > 0) {
      flags.push(`${Math.round(call.timeoutSec)}s`);
    }

    const questionText = typeof call.question === "string" ? Text.clip(call.question, 80) : "";
    const segments = [theme.fg("toolTitle", theme.bold("ask"))];

    if (questionText !== "") {
      segments.push(theme.fg("text", questionText));
    }

    segments.push(theme.fg("muted", `(${flags.join(", ")})`));

    return new TuiText(segments.join(" "), 0, 0);
  }
}

export class AskRegistrar {
  readonly #pi: ExtensionAPI;
  readonly #config: AskConfig;

  constructor(pi: ExtensionAPI, config: AskConfig) {
    this.#pi = pi;
    this.#config = config;
  }

  register(): void {
    const driver = new Driver(this.#config);
    const renderer = new Renderer();

    this.#pi.registerTool({
      name: "ask",
      label: "Ask",
      description:
        "Ask the user a structured question with 1-8 answer options. Use multi: true to let the user pick several options, allowOther (default true) to also offer a free-form answer, and timeoutSec to bound the wait. Returns the chosen label(s) plus any free text. If no UI is available or the user does not answer, the result says so: proceed with your best judgment and explicitly state the assumptions you made.",
      parameters: askParameters,
      execute(
        _toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ): Promise<AskResult> {
        return driver.run(params, signal, ctx);
      },
      renderCall(args: unknown, theme: Theme): Component {
        return renderer.render(args, theme);
      },
    });
  }
}
