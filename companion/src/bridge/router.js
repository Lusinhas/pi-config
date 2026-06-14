const {
  SHOW_DIFF_PATH,
  CLOSE_DIFF_PATH,
  REQUEST_DIFF_APPROVAL_PATH,
  HEALTH_PATH,
  CONTEXT_STREAM_PATH,
  DIAGNOSTICS_PATH,
  DEFAULT_CLOSE_DECISION,
  LIMITS,
  isRecord,
} = require("../protocol");
const { DiagnosticsCollector } = require("../editor/diagnostics");

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

class RequestRouter {
  constructor(diffManager, editorContext, getPort) {
    this.diffManager = diffManager;
    this.editorContext = editorContext;
    this.getPort = getPort;
    this.diagnostics = new DiagnosticsCollector(editorContext);
    this.activeSseConnections = 0;
  }

  async handle(req, res) {
    if (req.method === "POST" && req.url === SHOW_DIFF_PATH) return this.handleShowDiff(req, res);
    if (req.method === "POST" && req.url === CLOSE_DIFF_PATH) return this.handleCloseDiff(req, res);
    if (req.method === "POST" && req.url === REQUEST_DIFF_APPROVAL_PATH) return this.handleRequestDiffApproval(req, res);
    if (req.method === "GET" && req.url === HEALTH_PATH) return this.handleHealth(res);
    if (req.method === "GET" && req.url === CONTEXT_STREAM_PATH) return this.handleContextStream(req, res);
    if (req.method === "POST" && req.url === DIAGNOSTICS_PATH) return this.handleDiagnostics(req, res);

    return RequestRouter.sendJson(res, 404, { ok: false, error: "not found" });
  }

  async handleShowDiff(req, res) {
    const message = await RequestRouter.readJson(req);
    const requestId = String(message.requestId || Date.now());
    await this.diffManager.openPayloadDiff(message, requestId, { reviewOnly: true });
    RequestRouter.sendJson(res, 200, { ok: true, requestId, decision: "opened" });
  }

  async handleCloseDiff(req, res) {
    const message = await RequestRouter.readJson(req);
    const requestId = String(message.requestId || "");
    const decision = String(message.decision || DEFAULT_CLOSE_DECISION);
    await this.diffManager.closeDiffByRequestId(requestId, { decision });
    RequestRouter.sendJson(res, 200, { ok: true, requestId: message.requestId });
  }

  async handleRequestDiffApproval(req, res) {
    const message = await RequestRouter.readJson(req);
    const requestId = String(message.requestId || Date.now());

    const onAbort = () => {
      this.diffManager.cancelApproval(requestId).catch(() => {});
    };

    req.on("close", onAbort);
    req.on("aborted", onAbort);
    req.on("error", onAbort);

    try {
      const result = await this.diffManager.openApprovalDiff(message, requestId);
      RequestRouter.sendJson(res, 200, { ok: true, requestId, decision: result.decision, content: result.content });
    } catch {
      RequestRouter.sendJson(res, 200, { ok: true, requestId, decision: "reject", content: String(message.afterText || "") });
    }
  }

  handleHealth(res) {
    RequestRouter.sendJson(res, 200, { ok: true, port: this.getPort() });
  }

  async handleDiagnostics(req, res) {
    const message = await RequestRouter.readJson(req);
    const scope = typeof message.scope === "string" ? message.scope : "active";
    const filePath = typeof message.filePath === "string" ? message.filePath : "";

    if (scope === "file" && !filePath) {
      RequestRouter.sendJson(res, 400, { ok: false, error: "filePath is required when scope is 'file'" });
      return;
    }

    RequestRouter.sendJson(res, 200, this.diagnostics.collect({ scope, filePath }));
  }

  handleContextStream(req, res) {
    if (this.activeSseConnections >= LIMITS.maxSseConnections) {
      RequestRouter.sendJson(res, 429, { ok: false, error: "too many context streams" });
      return;
    }

    this.activeSseConnections += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

    const write = (chunk) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(chunk);
    };
    const sendSnapshot = (snapshot) => write(`data: ${JSON.stringify(snapshot)}\n\n`);

    try {
      sendSnapshot(this.editorContext.snapshot());
    } catch {
      void 0;
    }

    const unsubscribe = this.editorContext.subscribe(sendSnapshot);
    const keepAlive = setInterval(() => write(": keepalive\n\n"), LIMITS.keepAliveMs);
    keepAlive.unref?.();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      unsubscribe();
      clearInterval(keepAlive);
      this.activeSseConnections = Math.max(0, this.activeSseConnections - 1);
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  static readJson(req) {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks = [];
      let total = 0;

      req.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > LIMITS.maxBodyBytes) {
          rejectPromise(new HttpError(413, "request body too large"));
          req.destroy();
          return;
        }
        chunks.push(buf);
      });

      req.on("end", () => {
        try {
          const raw = chunks.length ? Buffer.concat(chunks).toString("utf8") : "{}";
          const parsed = JSON.parse(raw);
          resolvePromise(isRecord(parsed) ? parsed : {});
        } catch {
          rejectPromise(new HttpError(400, "invalid JSON"));
        }
      });

      req.on("error", rejectPromise);
    });
  }

  static sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

module.exports = { RequestRouter, HttpError };
