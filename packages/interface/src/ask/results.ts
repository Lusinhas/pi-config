import type { AskDetails, AskOption, AskResult } from "./types.ts";

export class Results {
  static abortError(): Error {
    return new Error("ask was cancelled before the user answered");
  }

  static noUi(question: string, options: AskOption[]): AskResult {
    const listing = options
      .map((option, index) => {
        const suffix = option.description !== undefined ? ` — ${option.description}` : "";

        return `${index + 1}. ${option.label}${suffix}`;
      })
      .join("\n");
    const text = [
      "No interactive UI is available in this mode, so the user could not be asked.",
      "Proceed with your best judgment: choose the most reasonable option yourself and clearly state that assumption in your reply.",
      `Question: ${question}`,
      "Options:",
      listing,
    ].join("\n");

    return { content: [{ type: "text", text }], details: { answered: false, selected: [], reason: "noui" } };
  }

  static noAnswer(
    reason: "timeout" | "dismissed",
    selected: string[],
    other: string | undefined,
  ): AskResult {
    const cause =
      reason === "timeout"
        ? "No answer (timeout): the user did not respond before the dialog expired."
        : "No answer (dismissed): the user closed the dialog without confirming a choice.";
    const lines = [cause];

    if (selected.length > 0) {
      lines.push(`Options toggled before the dialog closed, but never submitted: ${selected.join("; ")}.`);
    }

    if (other !== undefined) {
      lines.push(`Unsubmitted custom answer: "${other}".`);
    }

    lines.push("Proceed with your best judgment and clearly state the assumption you make.");

    const details: AskDetails = { answered: false, selected, reason };

    if (other !== undefined) {
      details.other = other;
    }

    return { content: [{ type: "text", text: lines.join("\n") }], details };
  }

  static answered(
    labels: string[],
    other: string | undefined,
    descriptions: Map<string, string>,
  ): AskResult {
    const parts: string[] = [];

    if (labels.length > 0) {
      const rendered = labels.map((label) => {
        const description = descriptions.get(label);

        return description !== undefined ? `${label} (${description})` : label;
      });

      parts.push(`User selected: ${rendered.join("; ")}`);
    }

    if (other !== undefined) {
      parts.push(`Custom answer: "${other}"`);
    }

    if (parts.length === 0) {
      parts.push("User submitted without selecting any option.");
    }

    const details: AskDetails = { answered: true, selected: labels };

    if (other !== undefined) {
      details.other = other;
    }

    return { content: [{ type: "text", text: parts.join("\n") }], details };
  }
}
