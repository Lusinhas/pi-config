import { describe, expect, test } from "bun:test";
import { Dialog, type LayoutInput, type PreviewSelectParams } from "../../src/view/dialog.ts";

function layoutInput(over: Partial<LayoutInput> = {}): LayoutInput {
  return {
    titleRows: ["Approve?"],
    footerRows: [],
    bodyRows: ["a", "b", "c"],
    optionCount: 2,
    width: 80,
    terminalRows: 24,
    viewport: 16,
    scroll: 0,
    ...over,
  };
}

describe("Dialog.plural", () => {
  test("singular for one", () => {
    expect(Dialog.plural(1)).toBe("line");
  });

  test("plural otherwise", () => {
    expect(Dialog.plural(0)).toBe("lines");
    expect(Dialog.plural(2)).toBe("lines");
  });
});

describe("Dialog.usableWidth", () => {
  test("clamps to a minimum of 24", () => {
    expect(Dialog.usableWidth(10)).toBe(24);
    expect(Dialog.usableWidth(80)).toBe(80);
  });
});

describe("Dialog.terminalRows", () => {
  test("floors a positive finite number", () => {
    expect(Dialog.terminalRows(30.7)).toBe(30);
  });

  test("falls back to 24 for invalid values", () => {
    expect(Dialog.terminalRows(0)).toBe(24);
    expect(Dialog.terminalRows(-5)).toBe(24);
    expect(Dialog.terminalRows(Number.NaN)).toBe(24);
    expect(Dialog.terminalRows("rows")).toBe(24);
    expect(Dialog.terminalRows(undefined)).toBe(24);
  });
});

describe("Dialog.fallbackString", () => {
  function params(over: Partial<PreviewSelectParams> = {}): PreviewSelectParams {
    return { title: "Title", preview: ["x", "y"], footer: ["foot"], options: ["a"], viewport: 16, ...over };
  }

  test("indents the body and appends the footer", () => {
    const out = Dialog.fallbackString(params(), 16);

    expect(out).toBe("Title\n  x\n  y\nfoot");
  });

  test("adds a more-lines indicator when preview exceeds the viewport", () => {
    const out = Dialog.fallbackString(params({ preview: ["a", "b", "c"], footer: [] }), 2);

    expect(out).toBe("Title\n  a\n  b\n  … (+1 more line)");
  });

  test("pluralizes the more-lines indicator", () => {
    const out = Dialog.fallbackString(params({ preview: ["a", "b", "c", "d"], footer: [] }), 2);

    expect(out).toBe("Title\n  a\n  b\n  … (+2 more lines)");
  });

  test("uses a no-arguments placeholder when the preview is empty", () => {
    const out = Dialog.fallbackString(params({ preview: [], footer: [] }), 16);

    expect(out).toBe("Title\n  (no arguments)");
  });
});

describe("Dialog.computeLayout sizing", () => {
  test("keeps all chrome and clamps scroll on a roomy terminal", () => {
    const layout = Dialog.computeLayout(layoutInput());

    expect(layout.chrome).toEqual({ showBlanks: true, showHints: true, showFooter: true, truncateTitle: false });
    expect(layout.pageRows).toBe(6);
    expect(layout.maxScroll).toBe(0);
    expect(layout.scroll).toBe(0);
  });

  test("clamps an out-of-range scroll down to maxScroll", () => {
    const layout = Dialog.computeLayout(layoutInput({ bodyRows: Array.from({ length: 30 }, (_, i) => `l${i}`), scroll: 100 }));

    expect(layout.maxScroll).toBe(30 - layout.pageRows);
    expect(layout.scroll).toBe(layout.maxScroll);
  });

  test("respects the viewport ceiling on pageRows", () => {
    const layout = Dialog.computeLayout(layoutInput({ bodyRows: Array.from({ length: 100 }, (_, i) => `l${i}`), viewport: 4 }));

    expect(layout.pageRows).toBe(4);
  });

  test("single body line yields no indicator rows", () => {
    const roomy = Dialog.computeLayout(layoutInput({ bodyRows: ["only"] }));

    expect(roomy.pageRows).toBe(8);
    expect(roomy.maxScroll).toBe(0);
  });
});

describe("Dialog.computeLayout chrome reduction order", () => {
  test("drops blanks first when the dialog is tight", () => {
    const layout = Dialog.computeLayout(
      layoutInput({ terminalRows: 24, optionCount: 9, footerRows: ["f1", "f2"], bodyRows: ["a", "b"] }),
    );

    expect(layout.chrome.showBlanks).toBe(false);
    expect(layout.chrome.showHints).toBe(true);
    expect(layout.chrome.showFooter).toBe(true);
  });

  test("drops blanks then hints when tighter", () => {
    const layout = Dialog.computeLayout(
      layoutInput({ terminalRows: 24, optionCount: 10, footerRows: ["f1", "f2"], bodyRows: ["a", "b"] }),
    );

    expect(layout.chrome.showBlanks).toBe(false);
    expect(layout.chrome.showHints).toBe(false);
    expect(layout.chrome.showFooter).toBe(true);
  });

  test("drops blanks, hints, then footer when tighter still", () => {
    const layout = Dialog.computeLayout(
      layoutInput({ terminalRows: 24, optionCount: 11, footerRows: ["f1", "f2"], bodyRows: ["a", "b"] }),
    );

    expect(layout.chrome.showBlanks).toBe(false);
    expect(layout.chrome.showHints).toBe(false);
    expect(layout.chrome.showFooter).toBe(false);
    expect(layout.chrome.truncateTitle).toBe(false);
  });

  test("truncates a multi-row title only after all other chrome is dropped", () => {
    const layout = Dialog.computeLayout(
      layoutInput({ terminalRows: 24, optionCount: 12, footerRows: [], titleRows: ["t1", "t2", "t3"], bodyRows: ["a", "b"] }),
    );

    expect(layout.chrome.showBlanks).toBe(false);
    expect(layout.chrome.showHints).toBe(false);
    expect(layout.chrome.showFooter).toBe(false);
    expect(layout.chrome.truncateTitle).toBe(true);
  });

  test("never truncates a single-row title", () => {
    const layout = Dialog.computeLayout(
      layoutInput({ terminalRows: 24, optionCount: 16, footerRows: [], titleRows: ["t1"], bodyRows: ["a", "b"] }),
    );

    expect(layout.chrome.truncateTitle).toBe(false);
  });

  test("pageRows stays at least one even when extremely tight", () => {
    const layout = Dialog.computeLayout(
      layoutInput({ terminalRows: 24, optionCount: 16, footerRows: ["f1", "f2"], titleRows: ["t1", "t2"], bodyRows: ["a", "b", "c", "d"] }),
    );

    expect(layout.pageRows).toBe(1);
    expect(layout.maxScroll).toBe(3);
  });
});
