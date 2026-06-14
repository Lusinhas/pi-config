const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { HOST, errorMessage } = require("../protocol");
const { RequestRouter } = require("./router");
const { ConnectionFile } = require("./connection");

class BridgeServer {
  constructor(diffManager, editorContext) {
    this.diffManager = diffManager;
    this.editorContext = editorContext;
    this.connectionFile = new ConnectionFile();
    this.router = new RequestRouter(diffManager, editorContext, () => this.port);
    this.server = undefined;
    this.port = undefined;
    this.authToken = undefined;
  }

  async start() {
    if (this.server) return { host: HOST, port: this.port, authToken: this.authToken };

    this.authToken = randomBytes(32).toString("hex");
    this.server = http.createServer((req, res) => this.onRequest(req, res));

    await new Promise((resolvePromise, rejectPromise) => {
      const onError = (error) => rejectPromise(error);
      this.server.once("error", onError);
      this.server.listen(0, HOST, () => {
        this.server.removeListener("error", onError);
        this.server.on("error", () => {});
        resolvePromise();
      });
    });

    this.port = this.server.address().port;
    return { host: HOST, port: this.port, authToken: this.authToken };
  }

  async onRequest(req, res) {
    try {
      if (!this.isValidHost(req)) {
        BridgeServer.sendJson(res, 403, { ok: false, error: "invalid host" });
        return;
      }
      if (!this.isAuthorized(req)) {
        BridgeServer.sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      await this.router.handle(req, res);
    } catch (error) {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        try {
          res.end();
        } catch {
          return;
        }
        return;
      }
      const statusCode = error && error.statusCode ? error.statusCode : 500;
      BridgeServer.sendJson(res, statusCode, { ok: false, error: errorMessage(error) });
    }
  }

  isValidHost(req) {
    const hostHeader = String(req.headers.host || "").toLowerCase();
    return hostHeader === `${HOST}:${this.port}` || hostHeader === `localhost:${this.port}`;
  }

  isAuthorized(req) {
    return String(req.headers.authorization || "") === `Bearer ${this.authToken}`;
  }

  writeConnectionFile() {
    if (!this.port || !this.authToken) return Promise.resolve(undefined);
    return this.connectionFile.write(this.port, this.authToken);
  }

  async stop() {
    await this.connectionFile.remove();
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
  }

  static sendJson(res, statusCode, payload) {
    RequestRouter.sendJson(res, statusCode, payload);
  }
}

module.exports = { BridgeServer };
