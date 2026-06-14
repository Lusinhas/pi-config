const vscode = require("vscode");
const { HOST, ENV_PORT, ENV_TOKEN, APPROVAL_DIFF_CONTEXT, errorMessage } = require("../protocol");
const { BridgeServer } = require("../bridge");
const { DiffManager } = require("../diff");
const { EditorContext } = require("../editor");

class CompanionExtension {
  constructor(context) {
    this.context = context;
    this.diffManager = new DiffManager();
    this.editorContext = new EditorContext();
    this.bridge = new BridgeServer(this.diffManager, this.editorContext);
  }

  activate() {
    this.registerProviders();
    this.registerCommands();
    this.registerListeners();
    this.editorContext.markFocused(vscode.window.activeTextEditor);
    vscode.commands.executeCommand("setContext", APPROVAL_DIFF_CONTEXT, false);
    this.startBridge();
  }

  registerProviders() {
    for (const registration of this.diffManager.register()) {
      this.context.subscriptions.push(registration);
    }
  }

  registerCommands() {
    this.context.subscriptions.push(
      vscode.commands.registerCommand("piconfig.debug", () => {
        const port = this.bridge.port;
        const detail = port ? `listening on ${HOST}:${port}` : "not listening";
        vscode.window.showInformationMessage(`pi-config IDE Bridge: ${detail}`);
      }),
      vscode.commands.registerCommand("piconfig.acceptDiff", () => {
        this.diffManager.acceptActiveApproval().catch(() => {});
      }),
      vscode.commands.registerCommand("piconfig.rejectDiff", () => {
        this.diffManager.rejectActiveApproval().catch(() => {});
      }),
    );
  }

  registerListeners() {
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.diffManager.handleSavedApproval(document).catch(() => {});
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.diffManager.handleClosedDiffTabs().catch(() => {});
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.editorContext.markFocused(editor);
        this.editorContext.notify();
        this.diffManager.updateDiffVisibleContext().catch(() => {});
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.editorContext.recordSelection(event.textEditor);
        this.editorContext.notify();
      }),
      vscode.workspace.onDidOpenTextDocument(() => this.editorContext.notify()),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const filePath = document && document.uri && document.uri.fsPath;
        this.editorContext.removePath(filePath);
        this.editorContext.notify();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.bridge.writeConnectionFile().catch(() => {});
        this.editorContext.notify();
      }),
      { dispose: () => this.dispose() },
    );
  }

  startBridge() {
    this.bridge
      .start()
      .then(async ({ port }) => {
        await this.bridge.writeConnectionFile();
        this.context.environmentVariableCollection.replace(ENV_PORT, String(port));
        this.context.environmentVariableCollection.replace(ENV_TOKEN, this.bridge.authToken);
        vscode.window.showInformationMessage(`pi-config IDE Bridge listening on ${HOST}:${port}`);
      })
      .catch((error) => {
        vscode.window.showErrorMessage(`pi-config IDE Bridge failed: ${errorMessage(error)}`);
      });
  }

  dispose() {
    this.bridge.stop().catch(() => {});
    this.diffManager.dispose();
    this.context.environmentVariableCollection.delete(ENV_PORT);
    this.context.environmentVariableCollection.delete(ENV_TOKEN);
  }
}

module.exports = { CompanionExtension };
