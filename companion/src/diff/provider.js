const vscode = require("vscode");

class ContentProvider {
  constructor(scheme) {
    this.scheme = scheme;
    this.contents = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  register() {
    return vscode.workspace.registerTextDocumentContentProvider(this.scheme, this);
  }

  provideTextDocumentContent(uri) {
    return this.contents.get(uri.toString()) || "";
  }

  set(uri, content) {
    this.contents.set(uri.toString(), String(content || ""));
    this.emitter.fire(uri);
  }

  delete(uriString) {
    this.contents.delete(uriString);
  }

  dispose() {
    this.contents.clear();
    this.emitter.dispose();
  }
}

module.exports = { ContentProvider };
