const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const { CONNECTION_DIR } = require("../protocol");

class ConnectionFile {
  constructor() {
    this.filePath = undefined;
  }

  async write(port, authToken) {
    await fs.mkdir(CONNECTION_DIR, { recursive: true, mode: 0o700 });
    await fs.chmod(CONNECTION_DIR, 0o700).catch(() => {});

    const filePath = path.join(CONNECTION_DIR, `piconfig-${process.pid}-${port}.json`);
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
    const payload = {
      pid: process.pid,
      port,
      authToken,
      ideName: vscode.env.appName || "VS Code",
      workspaceFolders,
    };

    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(filePath, 0o600).catch(() => {});
    this.filePath = filePath;
    return filePath;
  }

  async remove() {
    if (!this.filePath) return;
    const filePath = this.filePath;
    this.filePath = undefined;
    await fs.unlink(filePath).catch(() => {});
  }
}

module.exports = { ConnectionFile };
