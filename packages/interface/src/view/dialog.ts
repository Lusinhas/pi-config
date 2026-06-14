export interface PreviewSelectParams {
  title: string;
  preview: string[];
  footer: string[];
  options: string[];
  viewport: number;
  signal?: AbortSignal;
}

export interface LayoutInput {
  titleRows: string[];
  footerRows: string[];
  bodyRows: string[];
  optionCount: number;
  width: number;
  terminalRows: number;
  viewport: number;
  scroll: number;
}

export interface Chrome {
  showBlanks: boolean;
  showHints: boolean;
  showFooter: boolean;
  truncateTitle: boolean;
}

export interface Layout {
  chrome: Chrome;
  pageRows: number;
  maxScroll: number;
  scroll: number;
}

const HEIGHT_RATIO = 0.6;
const BOTTOM_MARGIN = 5;
const MIN_HEIGHT = 16;
const TERMINAL_ROWS_FALLBACK = 24;

export class Dialog {
  static plural(count: number): string {
    return count === 1 ? "line" : "lines";
  }

  static usableWidth(width: number): number {
    return Math.max(24, width);
  }

  static terminalRows(rows: unknown): number {
    if (typeof rows === "number" && Number.isFinite(rows) && rows > 0) {
      return Math.floor(rows);
    }

    return TERMINAL_ROWS_FALLBACK;
  }

  static fallbackString(params: PreviewSelectParams, viewport: number): string {
    const visible = params.preview.slice(0, viewport);

    if (params.preview.length > visible.length) {
      const more = params.preview.length - visible.length;
      visible.push(`… (+${more} more ${Dialog.plural(more)})`);
    }

    const body = visible.length > 0 ? visible : ["(no arguments)"];

    return [params.title, ...body.map((line) => `  ${line}`), ...params.footer].join("\n");
  }

  static computeLayout(input: LayoutInput): Layout {
    const rows = input.terminalRows;
    const cap = Math.max(Math.floor(rows * HEIGHT_RATIO), MIN_HEIGHT);
    const margin = Math.min(BOTTOM_MARGIN, Math.max(0, rows - cap));
    const budget = Math.max(1, Math.min(cap, rows - margin));
    const indicatorRows = input.bodyRows.length > 1 ? 2 : 0;

    const chrome: Chrome = {
      showBlanks: true,
      showHints: true,
      showFooter: true,
      truncateTitle: false,
    };

    let titleRowCount = input.titleRows.length;

    const consumed = (): number => {
      return (
        titleRowCount +
        (chrome.showFooter ? input.footerRows.length : 0) +
        input.optionCount +
        (chrome.showBlanks ? 4 : 0) +
        (chrome.showHints ? 1 : 0)
      );
    };

    const overflows = (): boolean => {
      return consumed() + indicatorRows + 1 > budget;
    };

    if (overflows()) {
      chrome.showBlanks = false;
    }

    if (overflows()) {
      chrome.showHints = false;
    }

    if (overflows()) {
      chrome.showFooter = false;
    }

    if (overflows() && titleRowCount > 1) {
      chrome.truncateTitle = true;
      titleRowCount = 1;
    }

    const pageRows = Math.max(1, Math.min(input.viewport, budget - consumed() - indicatorRows));
    const maxScroll = Math.max(0, input.bodyRows.length - pageRows);
    const scroll = input.scroll > maxScroll ? maxScroll : input.scroll;

    return { chrome, pageRows, maxScroll, scroll };
  }
}
