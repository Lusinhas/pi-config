const vscode = require("vscode");
const { LIMITS } = require("../protocol");

class EditorContext {
  constructor() {
    this.focusTimestamps = new Map();
    this.selectionStateByPath = new Map();
    this.subscribers = new Set();
    this.lastActivePath = undefined;
  }

  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  notify() {
    const next = this.snapshot();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(next);
      } catch {
        continue;
      }
    }
  }

  markFocused(editor) {
    const filePath = EditorContext.fileFsPath(editor);
    if (!filePath) return;
    EditorContext.touch(this.focusTimestamps, filePath, Date.now());
    this.lastActivePath = filePath;
    this.recordSelection(editor);
  }

  recordSelection(editor) {
    const filePath = EditorContext.fileFsPath(editor);
    if (!filePath) return;
    const state = EditorContext.selectionState(editor);
    if (!state) return;
    EditorContext.touch(this.selectionStateByPath, filePath, state);
  }

  removePath(filePath) {
    if (!filePath) return;
    this.focusTimestamps.delete(filePath);
    this.selectionStateByPath.delete(filePath);
    if (this.lastActivePath === filePath) this.lastActivePath = undefined;
  }

  snapshot() {
    const active = vscode.window.activeTextEditor;
    this.markFocused(active);
    const openPaths = EditorContext.openFilePaths();
    const fallbackActivePath = openPaths
      .slice()
      .sort((a, b) => (this.focusTimestamps.get(b) || 0) - (this.focusTimestamps.get(a) || 0))[0];
    const activeFsPath = EditorContext.fileFsPath(active);
    const activePath = activeFsPath || this.lastActivePath || fallbackActivePath;

    const openFiles = openPaths.map((filePath) => {
      const isActive = Boolean(activePath && activePath === filePath);
      const state = isActive
        ? (active && active.document && active.document.uri.fsPath === filePath
          ? EditorContext.selectionState(active)
          : this.selectionStateByPath.get(filePath))
        : undefined;
      return {
        path: filePath,
        timestamp: this.focusTimestamps.get(filePath) || 0,
        isActive,
        selectedText: state && state.selectedText,
        cursor: state && state.cursor,
      };
    });

    return { openFiles: EditorContext.normalizeOpenFiles(openFiles), isTrusted: Boolean(vscode.workspace.isTrusted) };
  }

  static normalizeOpenFiles(openFiles) {
    const sorted = [...openFiles].sort((a, b) => b.timestamp - a.timestamp);
    const activeIndex = sorted.findIndex((file) => file.isActive);

    sorted.forEach((file, index) => {
      if (activeIndex !== -1 && index === activeIndex) {
        file.isActive = true;
        return;
      }
      delete file.isActive;
      delete file.cursor;
      delete file.selectedText;
    });

    return sorted.slice(0, LIMITS.maxOpenFiles);
  }

  static openFilePaths() {
    const paths = new Set();

    for (const group of vscode.window.tabGroups.all || []) {
      for (const tab of group.tabs || []) {
        const filePath = EditorContext.tabFsPath(tab);
        if (filePath) paths.add(filePath);
      }
    }

    if (paths.size === 0) {
      for (const editor of vscode.window.visibleTextEditors || []) {
        const filePath = EditorContext.fileFsPath(editor);
        if (filePath) paths.add(filePath);
      }
    }

    return [...paths];
  }

  static tabFsPath(tab) {
    const input = tab && tab.input;
    const uri = input && (input.uri || input.modified || input.original);
    if (!uri || uri.scheme !== "file") return undefined;
    return uri.fsPath;
  }

  static fileFsPath(editor) {
    const uri = editor && editor.document && editor.document.uri;
    return uri && uri.scheme === "file" ? uri.fsPath : undefined;
  }

  static selectionState(editor) {
    const selection = editor && editor.selection;
    if (!selection) return undefined;
    const selectedText = selection.isEmpty ? undefined : EditorContext.truncate(editor.document.getText(selection));
    return {
      selectedText,
      cursor: { line: selection.active.line + 1, character: selection.active.character + 1 },
    };
  }

  static truncate(text) {
    if (!text) return undefined;
    if (text.length <= LIMITS.maxSelectedTextLength) return text;
    return `${text.slice(0, LIMITS.maxSelectedTextLength)}... [TRUNCATED]`;
  }

  static touch(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > LIMITS.maxContextEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

module.exports = { EditorContext };
