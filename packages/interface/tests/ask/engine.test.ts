import { describe, expect, test } from "bun:test";
import {
  Args,
  AskValidationError,
  Engine,
  MAX_TIMEOUT_SEC,
  MULTI_ATTEMPTS,
  Results,
  SINGLE_ATTEMPTS,
  Text,
  type AskArgs,
  type AskConfig,
  type Reply,
  type Step,
} from "../../src/ask/index.ts";

const CONFIG: AskConfig = {
  defaultTimeoutSec: 0,
  otherLabel: "Other (type a custom answer)",
  doneLabel: "Done",
};

function configWith(over: Partial<AskConfig>): AskConfig {
  return { ...CONFIG, ...over };
}

function pick(value: string): Reply {
  return { kind: "picked", value };
}

function empty(timedOut = false, aborted = false): Reply {
  return { kind: "empty", timedOut, aborted };
}

function promptDisplays(step: Step): string[] {
  if (step.kind !== "prompt" || step.prompt.kind !== "select") {
    throw new Error("expected a select prompt");
  }

  return step.prompt.displays;
}

describe("Text.clip", () => {
  test("collapses whitespace runs and trims", () => {
    expect(Text.clip("  a\t\n  b   c ", 100)).toBe("a b c");
  });

  test("returns flat text when within max", () => {
    expect(Text.clip("hello", 5)).toBe("hello");
  });

  test("truncates with U+2026 ellipsis", () => {
    expect(Text.clip("abcdef", 4)).toBe("abc…");
    expect(Text.clip("abcdef", 4).endsWith("…")).toBe(true);
  });

  test("never produces empty slice at tiny max", () => {
    expect(Text.clip("abcdef", 1)).toBe("a…");
  });
});

describe("Text.optionDisplay", () => {
  test("label only when no description", () => {
    expect(Text.optionDisplay({ label: "Yes" })).toBe("Yes");
  });

  test("joins label and description with space em-dash space", () => {
    expect(Text.optionDisplay({ label: "Yes", description: "do it" })).toBe("Yes — do it");
  });

  test("clips the combined option text to the terminal line width", () => {
    const label = "x".repeat(80);
    const description = "y".repeat(2000);
    const out = Text.optionDisplay({ label, description });

    expect(out.length).toBeLessThanOrEqual(Text.lineWidth());
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith(`${label} — `)).toBe(true);
  });
});

describe("Args.validate", () => {
  test("trims question and option labels and descriptions", () => {
    const out = Args.validate({
      question: "  pick one  ",
      options: [{ label: "  A  ", description: "  alpha  " }],
    });

    expect(out.question).toBe("pick one");
    expect(out.options[0]).toEqual({ label: "A", description: "alpha" });
  });

  test("drops empty or whitespace-only descriptions", () => {
    const out = Args.validate({ question: "q", options: [{ label: "A", description: "   " }] });

    expect(out.options[0]).toEqual({ label: "A" });
    expect("description" in out.options[0]).toBe(false);
  });

  test("rejects empty question with exact message", () => {
    expect(() => Args.validate({ question: "   ", options: [{ label: "A" }] })).toThrow(
      "ask requires a non-empty question",
    );
  });

  test("rejects wrong option count with exact message", () => {
    expect(() => Args.validate({ question: "q", options: [] as never })).toThrow(
      "ask requires between 1 and 8 options",
    );

    const tooMany = Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` }));

    expect(() => Args.validate({ question: "q", options: tooMany })).toThrow(
      "ask requires between 1 and 8 options",
    );
  });

  test("rejects bad option label with 1-based index", () => {
    expect(() =>
      Args.validate({ question: "q", options: [{ label: "A" }, { label: "   " }] }),
    ).toThrow("ask option 2 requires a non-empty label");
  });

  test("errors are AskValidationError instances", () => {
    let caught: unknown;

    try {
      Args.validate({ question: "", options: [{ label: "A" }] });
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof AskValidationError).toBe(true);
  });
});

describe("Args.resolveTimeoutMs", () => {
  test("zero means no timeout", () => {
    expect(Args.resolveTimeoutMs(0, CONFIG)).toBe(0);
  });

  test("uses config default when arg omitted or invalid", () => {
    const config = configWith({ defaultTimeoutSec: 5 });

    expect(Args.resolveTimeoutMs(undefined, config)).toBe(5000);
    expect(Args.resolveTimeoutMs(Number.NaN, config)).toBe(5000);
    expect(Args.resolveTimeoutMs(-3, config)).toBe(5000);
  });

  test("rounds seconds to milliseconds", () => {
    expect(Args.resolveTimeoutMs(1.2349, CONFIG)).toBe(1235);
  });

  test("clamps to MAX_TIMEOUT_SEC", () => {
    expect(Args.resolveTimeoutMs(999999, CONFIG)).toBe(MAX_TIMEOUT_SEC * 1000);
  });
});

describe("Results.noUi", () => {
  test("renders the exact 5-line block with numbered listing", () => {
    const result = Results.noUi("Why?", [{ label: "A" }, { label: "B", description: "bee" }]);

    expect(result.content[0].text).toBe(
      [
        "No interactive UI is available in this mode, so the user could not be asked.",
        "Proceed with your best judgment: choose the most reasonable option yourself and clearly state that assumption in your reply.",
        "Question: Why?",
        "Options:",
        "1. A\n2. B — bee",
      ].join("\n"),
    );
    expect(result.details).toEqual({ answered: false, selected: [], reason: "noui" });
    expect("other" in result.details).toBe(false);
  });
});

describe("Results.noAnswer", () => {
  test("timeout cause and trailing guidance", () => {
    const result = Results.noAnswer("timeout", [], undefined);

    expect(result.content[0].text).toBe(
      [
        "No answer (timeout): the user did not respond before the dialog expired.",
        "Proceed with your best judgment and clearly state the assumption you make.",
      ].join("\n"),
    );
    expect(result.details).toEqual({ answered: false, selected: [], reason: "timeout" });
  });

  test("dismissed cause with toggled and other lines", () => {
    const result = Results.noAnswer("dismissed", ["A", "B"], "freeform");

    expect(result.content[0].text).toBe(
      [
        "No answer (dismissed): the user closed the dialog without confirming a choice.",
        "Options toggled before the dialog closed, but never submitted: A; B.",
        'Unsubmitted custom answer: "freeform".',
        "Proceed with your best judgment and clearly state the assumption you make.",
      ].join("\n"),
    );
    expect(result.details).toEqual({ answered: false, selected: ["A", "B"], reason: "dismissed", other: "freeform" });
  });

  test("other key omitted when no free text", () => {
    const result = Results.noAnswer("dismissed", ["A"], undefined);

    expect("other" in result.details).toBe(false);
  });
});

describe("Results.answered", () => {
  test("renders selected labels with descriptions", () => {
    const descriptions = new Map([["A", "alpha"]]);
    const result = Results.answered(["A", "B"], undefined, descriptions);

    expect(result.content[0].text).toBe("User selected: A (alpha); B");
    expect(result.details).toEqual({ answered: true, selected: ["A", "B"] });
    expect("reason" in result.details).toBe(false);
  });

  test("custom answer line and details.other", () => {
    const result = Results.answered([], "freeform", new Map());

    expect(result.content[0].text).toBe('Custom answer: "freeform"');
    expect(result.details).toEqual({ answered: true, selected: [], other: "freeform" });
  });

  test("empty submission text when neither labels nor other", () => {
    const result = Results.answered([], undefined, new Map());

    expect(result.content[0].text).toBe("User submitted without selecting any option.");
  });

  test("both labels and custom answer render on two lines", () => {
    const result = Results.answered(["A"], "extra", new Map());

    expect(result.content[0].text).toBe('User selected: A\nCustom answer: "extra"');
  });
});

describe("Results.abortError", () => {
  test("carries the verbatim message", () => {
    expect(Results.abortError().message).toBe("ask was cancelled before the user answered");
  });
});

describe("Engine single-select", () => {
  test("start prompt lists options then Other, title clipped to 120", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }, { label: "B" }] }, CONFIG);
    const step = engine.start();

    expect(step.kind).toBe("prompt");

    if (step.kind === "prompt" && step.prompt.kind === "select") {
      expect(step.prompt.title).toBe("Pick");
      expect(step.prompt.displays).toEqual(["A", "B", CONFIG.otherLabel]);
    }
  });

  test("omits Other when allowOther false", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }], allowOther: false }, CONFIG);

    expect(promptDisplays(engine.start())).toEqual(["A"]);
  });

  test("picking an option answers with that label and description", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A", description: "alpha" }] }, CONFIG);
    const displays = promptDisplays(engine.start());
    const step = engine.advance(pick(displays[0]));

    expect(step.kind).toBe("result");

    if (step.kind === "result") {
      expect(step.result.content[0].text).toBe("User selected: A (alpha)");
      expect(step.result.details).toEqual({ answered: true, selected: ["A"] });
    }
  });

  test("choosing Other opens input then non-empty answer resolves", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }] }, CONFIG);
    const displays = promptDisplays(engine.start());
    const otherStep = engine.advance(pick(displays[1]));

    expect(otherStep.kind === "prompt" && otherStep.prompt.kind === "input").toBe(true);

    const done = engine.advance(pick("  typed  "));

    expect(done.kind).toBe("result");

    if (done.kind === "result") {
      expect(done.result.content[0].text).toBe('Custom answer: "typed"');
    }
  });

  test("empty input loops back to the select prompt", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }] }, CONFIG);
    const displays = promptDisplays(engine.start());

    engine.advance(pick(displays[1]));

    const back = engine.advance(pick("   "));

    expect(back.kind === "prompt" && back.prompt.kind === "select").toBe(true);
  });

  test("undefined pick without timeout is dismissed", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }] }, CONFIG);

    engine.start();

    const step = engine.advance(empty(false, false));

    expect(step.kind === "result" && step.result.details.reason === "dismissed").toBe(true);
  });

  test("undefined pick with timeout reports timeout", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }] }, CONFIG);

    engine.start();

    const step = engine.advance(empty(true, false));

    expect(step.kind === "result" && step.result.details.reason === "timeout").toBe(true);
  });

  test("aborted pick throws the cancellation error", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }] }, CONFIG);

    engine.start();

    expect(() => engine.advance(empty(false, true))).toThrow("ask was cancelled before the user answered");
  });

  test("unknown display string is dismissed", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }] }, CONFIG);

    engine.start();

    const step = engine.advance(pick("ghost"));

    expect(step.kind === "result" && step.result.details.reason === "dismissed").toBe(true);
  });

  test("input timeout reports timeout", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }] }, CONFIG);
    const displays = promptDisplays(engine.start());

    engine.advance(pick(displays[1]));

    const step = engine.advance(empty(true, false));

    expect(step.kind === "result" && step.result.details.reason === "timeout").toBe(true);
  });

  test("exhausting single attempts ends in dismissed", () => {
    const engine = Engine.create({ question: "Pick", options: [{ label: "A" }] }, CONFIG);

    engine.start();

    let step: Step = { kind: "prompt", prompt: { kind: "select", title: "", displays: [] } };

    for (let i = 0; i < SINGLE_ATTEMPTS; i += 1) {
      const displays = i === 0 ? promptDisplays(engine.start()) : ["A", CONFIG.otherLabel];

      engine.advance(pick(displays[1]));
      step = engine.advance(pick(""));
    }

    expect(step.kind === "result" && step.result.details.reason === "dismissed").toBe(true);
  });
});

describe("Engine single-select duplicate display disambiguation", () => {
  test("identical option displays get numbered suffixes and map correctly", () => {
    const engine = Engine.create(
      { question: "Pick", options: [{ label: "Same" }, { label: "Same" }], allowOther: false },
      CONFIG,
    );
    const displays = promptDisplays(engine.start());

    expect(displays).toEqual(["Same", "Same (2)"]);

    const step = engine.advance(pick("Same (2)"));

    expect(step.kind === "result" && step.result.details.selected).toEqual(["Same"]);
  });
});

describe("Engine multi-select", () => {
  function build(): Engine {
    return Engine.create(
      { question: "Pick", options: [{ label: "A" }, { label: "B" }], multi: true },
      CONFIG,
    );
  }

  test("start prompt shows checkbox markers, Other, and Done with title suffix", () => {
    const engine = build();
    const step = engine.start();

    expect(step.kind === "prompt" && step.prompt.kind === "select").toBe(true);

    if (step.kind === "prompt" && step.prompt.kind === "select") {
      expect(step.prompt.title).toBe("Pick (multi-select)");
      expect(step.prompt.displays).toEqual([
        "[ ] A",
        "[ ] B",
        `[ ] ${CONFIG.otherLabel}`,
        `${CONFIG.doneLabel} — submit (none selected)`,
      ]);
    }
  });

  test("toggling marks the option and updates Done count", () => {
    const engine = build();
    const first = promptDisplays(engine.start());
    const second = promptDisplays(engine.advance(pick(first[0])));

    expect(second[0]).toBe("[x] A");
    expect(second[3]).toBe(`${CONFIG.doneLabel} — submit 1 selected`);
  });

  test("toggling twice clears selection", () => {
    const engine = build();
    const first = promptDisplays(engine.start());

    engine.advance(pick(first[0]));

    const third = promptDisplays(engine.advance(pick("[x] A")));

    expect(third[0]).toBe("[ ] A");
  });

  test("Done submits selected labels sorted by index", () => {
    const engine = build();
    const first = promptDisplays(engine.start());

    engine.advance(pick(first[1]));

    const afterB = promptDisplays(engine.advance(pick("[ ] A")));
    const done = engine.advance(pick(afterB[3]));

    expect(done.kind).toBe("result");

    if (done.kind === "result") {
      expect(done.result.details).toEqual({ answered: true, selected: ["A", "B"] });
    }
  });

  test("Other opens input, sets custom text, and shows it inline clipped", () => {
    const engine = build();
    const first = promptDisplays(engine.start());
    const input = engine.advance(pick(first[2]));

    expect(input.kind === "prompt" && input.prompt.kind === "input").toBe(true);

    const after = promptDisplays(engine.advance(pick("custom note")));

    expect(after[2]).toBe(`[x] ${CONFIG.otherLabel}: custom note`);
    expect(after[3]).toBe(`${CONFIG.doneLabel} — submit 1 selected`);
  });

  test("selecting Other while set clears the custom text", () => {
    const engine = build();
    const first = promptDisplays(engine.start());

    engine.advance(pick(first[2]));

    const after = promptDisplays(engine.advance(pick("note")));
    const cleared = promptDisplays(engine.advance(pick(after[2])));

    expect(cleared[2]).toBe(`[ ] ${CONFIG.otherLabel}`);
  });

  test("Done with custom text plus options reports both", () => {
    const engine = build();
    const first = promptDisplays(engine.start());

    engine.advance(pick(first[0]));

    const afterToggle = promptDisplays(engine.advance(pick("[ ] B")));

    engine.advance(pick(afterToggle[2]));

    const withOther = promptDisplays(engine.advance(pick("extra")));
    const done = engine.advance(pick(withOther[3]));

    expect(done.kind).toBe("result");

    if (done.kind === "result") {
      expect(done.result.content[0].text).toBe('User selected: A; B\nCustom answer: "extra"');
      expect(done.result.details).toEqual({ answered: true, selected: ["A", "B"], other: "extra" });
    }
  });

  test("undefined select pick reports timeout with chosen labels and confirmed other text", () => {
    const engine = build();
    const first = promptDisplays(engine.start());

    engine.advance(pick(first[1]));

    const inputStep = engine.advance(pick(first[2]));

    expect(inputStep.kind === "prompt" && inputStep.prompt.kind === "input").toBe(true);

    void promptDisplays(engine.advance(pick("kept")));

    const step = engine.advance(empty(true, false));

    expect(step.kind).toBe("result");

    if (step.kind === "result") {
      expect(step.result.details.reason).toBe("timeout");
      expect(step.result.details.selected).toEqual(["B"]);
      expect(step.result.details.other).toBe("kept");
    }
  });

  test("multi input timeout reports timeout with chosen labels but drops other text", () => {
    const engine = build();
    const first = promptDisplays(engine.start());

    engine.advance(pick(first[0]));

    const afterToggle = promptDisplays(engine.advance(pick("[ ] B")));
    const inputStep = engine.advance(pick(afterToggle[2]));

    expect(inputStep.kind === "prompt" && inputStep.prompt.kind === "input").toBe(true);

    const timeoutStep = engine.advance(empty(true, false));

    expect(timeoutStep.kind).toBe("result");

    if (timeoutStep.kind === "result") {
      expect(timeoutStep.result.details.reason).toBe("timeout");
      expect(timeoutStep.result.details.selected).toEqual(["A", "B"]);
      expect("other" in timeoutStep.result.details).toBe(false);
    }
  });

  test("undefined pick without timeout is dismissed", () => {
    const engine = build();

    engine.start();

    const step = engine.advance(empty(false, false));

    expect(step.kind === "result" && step.result.details.reason === "dismissed").toBe(true);
  });

  test("aborted pick throws", () => {
    const engine = build();

    engine.start();

    expect(() => engine.advance(empty(false, true))).toThrow("ask was cancelled before the user answered");
  });

  test("unknown display is dismissed with current selection", () => {
    const engine = build();

    engine.start();

    const step = engine.advance(pick("ghost"));

    expect(step.kind === "result" && step.result.details.reason === "dismissed").toBe(true);
  });
});

describe("Engine no-UI result", () => {
  test("delegates to Results.noUi", () => {
    const engine = Engine.create({ question: "Q", options: [{ label: "A" }] }, CONFIG);

    expect(engine.noUiResult().details.reason).toBe("noui");
  });
});

describe("Engine timeout resolution", () => {
  test("hasTimeout reflects resolved milliseconds", () => {
    const noTimeout = Engine.create({ question: "Q", options: [{ label: "A" }] }, CONFIG);

    expect(noTimeout.hasTimeout).toBe(false);
    expect(noTimeout.timeoutMs()).toBe(0);

    const withTimeout = Engine.create({ question: "Q", options: [{ label: "A" }], timeoutSec: 2 }, CONFIG);

    expect(withTimeout.hasTimeout).toBe(true);
    expect(withTimeout.timeoutMs()).toBe(2000);
  });

  test("constants match the original caps", () => {
    expect(SINGLE_ATTEMPTS).toBe(20);
    expect(MULTI_ATTEMPTS).toBe(200);
  });
});
