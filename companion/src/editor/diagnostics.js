const vscode = require("vscode");
const { LIMITS } = require("../protocol");

class DiagnosticsCollector {
  constructor(editorContext) {
    this.editorContext = editorContext;
  }

  collect(request) {
    const scope = request && typeof request.scope === "string" ? request.scope : "active";
    const filePath = request && typeof request.filePath === "string" ? request.filePath : "";
    const uris = this.resolveUris(scope, filePath);
    const limit = scope === "all" ? LIMITS.maxDiagnosticsPerVisibleFile : LIMITS.maxDiagnosticsForSingleFile;

    const files = [];
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const uri of uris) {
      const entries = DiagnosticsCollector.serialize(vscode.languages.getDiagnostics(uri), limit);
      if (entries.length === 0) continue;
      files.push({ path: uri.fsPath, diagnostics: entries });
      for (const entry of entries) {
        if (entry.severity === "error") totalErrors += 1;
        if (entry.severity === "warning") totalWarnings += 1;
      }
    }

    return { ok: true, files, totalErrors, totalWarnings };
  }

  resolveUris(scope, filePath) {
    if (scope === "all") return this.openFileUris();
    if (scope === "file") return [vscode.Uri.file(filePath)];
    return this.activeFileUris();
  }

  openFileUris() {
    const uris = [];
    const seen = new Set();
    const snapshot = this.editorContext.snapshot();
    const openFiles = Array.isArray(snapshot.openFiles) ? snapshot.openFiles : [];

    for (const file of openFiles) {
      const openPath = file && typeof file.path === "string" ? file.path : "";
      if (!openPath || seen.has(openPath)) continue;
      seen.add(openPath);
      uris.push(vscode.Uri.file(openPath));
      if (uris.length >= LIMITS.maxVisibleDiagnosticFiles) break;
    }

    return uris;
  }

  activeFileUris() {
    const snapshot = this.editorContext.snapshot();
    const active = Array.isArray(snapshot.openFiles) ? snapshot.openFiles.find((file) => file && file.isActive) : undefined;
    if (active && active.path) return [vscode.Uri.file(active.path)];

    const editor = vscode.window.activeTextEditor;
    const uri = editor && editor.document && editor.document.uri;
    if (uri && uri.scheme === "file") return [uri];

    return [];
  }

  static serialize(diagnostics, limit) {
    return (diagnostics || [])
      .filter((diag) => diag && (diag.severity === vscode.DiagnosticSeverity.Error || diag.severity === vscode.DiagnosticSeverity.Warning))
      .sort((a, b) => {
        if (a.severity !== b.severity) return a.severity - b.severity;
        if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
        return a.range.start.character - b.range.start.character;
      })
      .slice(0, limit)
      .map((diag) => ({
        severity: diag.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
        message: String(diag.message || ""),
        line: diag.range.start.line + 1,
        character: diag.range.start.character + 1,
        source: diag.source ? String(diag.source) : undefined,
        code: DiagnosticsCollector.codeToString(diag.code),
      }));
  }

  static codeToString(code) {
    if (typeof code === "string" || typeof code === "number") return String(code);
    if (code && typeof code === "object" && "value" in code) {
      const value = code.value;
      if (typeof value === "string" || typeof value === "number") return String(value);
    }
    return undefined;
  }
}

module.exports = { DiagnosticsCollector };
