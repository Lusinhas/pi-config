const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");
const {
  BEFORE_SCHEME,
  AFTER_SCHEME,
  DIFF_VISIBLE_CONTEXT,
  APPROVAL_DIFF_CONTEXT,
  DEFAULT_CLOSE_DECISION,
  LIMITS,
} = require("../protocol");
const { ContentProvider } = require("./provider");

const LANGUAGE_BY_EXTENSION = {
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".json": "json",
  ".md": "markdown",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".fish": "fish",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".sql": "sql",
};

class DiffManager {
  constructor() {
    this.beforeProvider = new ContentProvider(BEFORE_SCHEME);
    this.afterProvider = new ContentProvider(AFTER_SCHEME);
    this.diffByRequestId = new Map();
    this.pendingApprovals = new Map();
  }

  register() {
    return [this.beforeProvider.register(), this.afterProvider.register()];
  }

  async openPayloadDiff(payload, requestId, options = {}) {
    if (!payload || !payload.filePath) throw new Error("missing filePath in payload");

    const key = String(requestId || Date.now());
    await this.closeDiffByRequestId(key, { decision: DEFAULT_CLOSE_DECISION });

    const reviewOnly = options.reviewOnly === true;
    const fileUri = vscode.Uri.file(String(payload.filePath));
    const left = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: fileUri.path, query: `rid=${encodeURIComponent(key)}` });
    const right = vscode.Uri.from({ scheme: AFTER_SCHEME, path: fileUri.path, query: `rid=${encodeURIComponent(key)}` });

    this.beforeProvider.set(left, String(payload.beforeText || ""));
    this.afterProvider.set(right, String(payload.afterText || ""));

    const titlePrefix = reviewOnly ? "[Pi]" : "*[Pi]";
    const title = `${titlePrefix} ${path.basename(String(payload.filePath))} (${DiffManager.shortId(key)})`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: false, preserveFocus: true });

    while (this.diffByRequestId.size >= LIMITS.maxOpenDiffs) {
      const oldest = this.diffByRequestId.keys().next().value;
      if (oldest === undefined) break;
      await this.closeDiffByRequestId(oldest, { decision: "rejected" });
    }

    this.diffByRequestId.set(key, {
      requestId: key,
      filePath: String(payload.filePath),
      left: left.toString(),
      right: right.toString(),
      reviewOnly,
    });

    await this.updateDiffVisibleContext();
    return key;
  }

  async openApprovalDiff(payload, requestId) {
    if (!payload || !payload.filePath) throw new Error("missing filePath in payload");

    const key = String(requestId || Date.now());
    await this.cancelApproval(key);

    const filePath = String(payload.filePath);
    const afterText = String(payload.afterText || "");
    const fileUri = vscode.Uri.file(filePath);
    const leftUri = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: fileUri.path, query: `rid=${encodeURIComponent(key)}` });

    this.beforeProvider.set(leftUri, String(payload.beforeText || ""));

    const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, "");
    const tempPath = path.join(os.tmpdir(), `piconfig-approval-${safeKey}-${path.basename(filePath)}`);
    fs.writeFileSync(tempPath, afterText);
    const rightDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(tempPath));

    const title = `Approve: ${path.basename(filePath)} — Save or Accept to apply, Reject to cancel`;
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightDoc.uri, title, { preview: false });
    await vscode.commands.executeCommand("setContext", APPROVAL_DIFF_CONTEXT, true);

    return new Promise((resolve) => {
      this.pendingApprovals.set(key, {
        requestId: key,
        resolve,
        leftUri,
        rightUri: rightDoc.uri,
        left: leftUri.toString(),
        right: rightDoc.uri.toString(),
        afterText,
        tempPath,
      });
    });
  }

  async acceptActiveApproval() {
    const entry = this.firstPendingApproval();
    if (!entry) return;

    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === entry.rightUri.toString());
    const content = doc ? doc.getText() : entry.afterText;
    await this.resolveApproval(entry, { decision: "accept", content });
  }

  async handleSavedApproval(document) {
    if (!document || !document.uri) return;

    const uriString = document.uri.toString();

    for (const entry of [...this.pendingApprovals.values()]) {
      if (entry.rightUri.toString() === uriString) {
        await this.resolveApproval(entry, { decision: "accept", content: document.getText() });
        return;
      }
    }
  }

  async rejectActiveApproval() {
    const entry = this.firstPendingApproval();
    if (!entry) return;

    await this.resolveApproval(entry, { decision: "reject", content: entry.afterText });
  }

  async cancelApproval(requestId) {
    const key = String(requestId || "");
    const entry = this.pendingApprovals.get(key);
    if (!entry) return;

    await this.resolveApproval(entry, { decision: "reject", content: entry.afterText });
  }

  async resolveApproval(entry, result) {
    if (!this.pendingApprovals.has(entry.requestId)) return;

    this.pendingApprovals.delete(entry.requestId);
    entry.resolve(result);
    await this.closeApprovalTabs(entry);
    this.beforeProvider.delete(entry.left);
    this.cleanupTemp(entry);
    await this.updateApprovalContext();
  }

  cleanupTemp(entry) {
    if (!entry.tempPath) return;

    try {
      fs.unlinkSync(entry.tempPath);
    } catch {
      void 0;
    }
  }
  async closeApprovalTabs(entry) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === entry.rightUri.toString());

    if (doc && doc.isDirty) {
      try {
        await doc.save();
      } catch {
        void 0;
      }
    }

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (DiffManager.isApprovalTab(tab.input, entry)) {
          try {
            await vscode.window.tabGroups.close(tab, true);
          } catch {
            void 0;
          }
        }
      }
    }
  }

  async handleClosedApprovalTabs() {
    for (const entry of [...this.pendingApprovals.values()]) {
      if (DiffManager.isApprovalStillOpen(entry)) continue;
      this.pendingApprovals.delete(entry.requestId);
      entry.resolve({ decision: "reject", content: entry.afterText });
      this.beforeProvider.delete(entry.left);
      this.cleanupTemp(entry);
    }
    await this.updateApprovalContext();
  }

  firstPendingApproval() {
    const value = this.pendingApprovals.values().next().value;
    return value || undefined;
  }

  async updateApprovalContext() {
    await vscode.commands.executeCommand("setContext", APPROVAL_DIFF_CONTEXT, this.pendingApprovals.size > 0);
  }

  async closeDiffByRequestId(requestId, options = {}) {
    const key = String(requestId || "");
    const target = this.diffByRequestId.get(key);
    if (!target) return;

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (DiffManager.isDiffTab(tab.input, target)) await vscode.window.tabGroups.close(tab, true);
      }
    }

    void options.decision;
    this.beforeProvider.delete(target.left);
    this.afterProvider.delete(target.right);
    this.diffByRequestId.delete(key);
    await this.updateDiffVisibleContext();
  }

  async handleClosedDiffTabs() {
    for (const [requestId, info] of [...this.diffByRequestId.entries()]) {
      if (DiffManager.isDiffStillOpen(info)) continue;
      this.beforeProvider.delete(info.left);
      this.afterProvider.delete(info.right);
      this.diffByRequestId.delete(requestId);
    }
    await this.updateDiffVisibleContext();
    await this.handleClosedApprovalTabs();
  }

  async updateDiffVisibleContext() {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    const activeInput = active && active.input;
    const editorUri = DiffManager.activeEditorUriString();
    let visible = false;

    for (const info of this.diffByRequestId.values()) {
      if (info.reviewOnly) continue;
      if (DiffManager.isDiffTab(activeInput, info)) {
        visible = true;
        break;
      }
      if (editorUri && (info.left === editorUri || info.right === editorUri)) {
        visible = true;
        break;
      }
    }

    await vscode.commands.executeCommand("setContext", DIFF_VISIBLE_CONTEXT, visible);
  }

  dispose() {
    for (const entry of [...this.pendingApprovals.values()]) {
      this.pendingApprovals.delete(entry.requestId);
      entry.resolve({ decision: "reject", content: entry.afterText });
    }
    this.diffByRequestId.clear();
    this.beforeProvider.dispose();
    this.afterProvider.dispose();
  }

  static isApprovalTab(input, entry) {
    const original = input && input.original && input.original.toString && input.original.toString();
    const modified = input && input.modified && input.modified.toString && input.modified.toString();
    return original === entry.left && modified === entry.right;
  }

  static isApprovalStillOpen(entry) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (DiffManager.isApprovalTab(tab.input, entry)) return true;
      }
    }
    return false;
  }

  static languageForPath(filePath) {
    const ext = path.extname(String(filePath || "")).toLowerCase();
    return LANGUAGE_BY_EXTENSION[ext] || "plaintext";
  }

  static isDiffStillOpen(info) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (DiffManager.isDiffTab(tab.input, info)) return true;
      }
    }
    return false;
  }

  static isDiffTab(input, info) {
    const original = input && input.original && input.original.toString && input.original.toString();
    const modified = input && input.modified && input.modified.toString && input.modified.toString();
    return original === info.left && modified === info.right;
  }

  static activeEditorUriString() {
    const editor = vscode.window.activeTextEditor;
    return editor && editor.document ? editor.document.uri.toString() : undefined;
  }

  static shortId(raw) {
    const cleaned = String(raw || "").replace(/^call[_-]?/i, "").replace(/[^a-zA-Z0-9]/g, "");
    return (cleaned || "000000").slice(0, 6).padEnd(6, "0");
  }
}

module.exports = { DiffManager };
