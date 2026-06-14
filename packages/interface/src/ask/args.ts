import type { AskConfig } from "./config.ts";
import { MAX_TIMEOUT_SEC, type AskArgs, type AskOption, type ValidatedArgs } from "./types.ts";

export class AskValidationError extends Error {}

export class Args {
  static validate(params: AskArgs): ValidatedArgs {
    if (typeof params.question !== "string" || params.question.trim() === "") {
      throw new AskValidationError("ask requires a non-empty question");
    }

    if (!Array.isArray(params.options) || params.options.length < 1 || params.options.length > 8) {
      throw new AskValidationError("ask requires between 1 and 8 options");
    }

    const options: AskOption[] = params.options.map((option, index) => Args.option(option, index));

    return { question: params.question.trim(), options };
  }

  private static option(option: unknown, index: number): AskOption {
    const isRecord = typeof option === "object" && option !== null && !Array.isArray(option);
    const record = option as Record<string, unknown>;

    if (!isRecord || typeof record.label !== "string" || record.label.trim() === "") {
      throw new AskValidationError(`ask option ${index + 1} requires a non-empty label`);
    }

    const hasDescription = typeof record.description === "string" && record.description.trim() !== "";
    const label = record.label.trim();

    if (hasDescription) {
      return { label, description: (record.description as string).trim() };
    }

    return { label };
  }

  static resolveTimeoutMs(timeoutSec: number | undefined, config: AskConfig): number {
    const fromArgs =
      typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec >= 0 ? timeoutSec : undefined;
    const seconds = fromArgs ?? config.defaultTimeoutSec;

    return seconds > 0 ? Math.round(Math.min(seconds, MAX_TIMEOUT_SEC) * 1000) : 0;
  }
}
