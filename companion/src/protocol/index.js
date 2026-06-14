const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
const ENV_PORT = "PI_IDE_BRIDGE_SERVER_PORT";
const ENV_TOKEN = "PI_IDE_BRIDGE_AUTH_TOKEN";

const SHOW_DIFF_PATH = "/showDiff";
const CLOSE_DIFF_PATH = "/closeDiff";
const LEGACY_OPEN_DIFF_PATH = "/openDiff";
const REQUEST_DIFF_APPROVAL_PATH = "/requestDiffApproval";
const HEALTH_PATH = "/health";
const CONTEXT_STREAM_PATH = "/context/stream";
const DIAGNOSTICS_PATH = "/diagnostics";

const BEFORE_SCHEME = "piconfig-before";
const AFTER_SCHEME = "piconfig-after";
const DIFF_VISIBLE_CONTEXT = "piconfig.diffVisible";
const APPROVAL_DIFF_CONTEXT = "piconfig.approvalDiffVisible";

const CONNECTION_DIR = path.join(os.homedir(), ".pi", "ide");

const DEFAULT_CLOSE_DECISION = "closed_by_pi";

const LIMITS = {
  maxBodyBytes: 10 * 1024 * 1024,
  maxOpenDiffs: 256,
  maxSseConnections: 5,
  maxOpenFiles: 10,
  maxSelectedTextLength: 16384,
  maxContextEntries: 256,
  maxVisibleDiagnosticFiles: 10,
  maxDiagnosticsPerVisibleFile: 50,
  maxDiagnosticsForSingleFile: 500,
  keepAliveMs: 15000,
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

module.exports = {
  HOST,
  ENV_PORT,
  ENV_TOKEN,
  SHOW_DIFF_PATH,
  CLOSE_DIFF_PATH,
  LEGACY_OPEN_DIFF_PATH,
  REQUEST_DIFF_APPROVAL_PATH,
  HEALTH_PATH,
  CONTEXT_STREAM_PATH,
  DIAGNOSTICS_PATH,
  BEFORE_SCHEME,
  AFTER_SCHEME,
  DIFF_VISIBLE_CONTEXT,
  APPROVAL_DIFF_CONTEXT,
  CONNECTION_DIR,
  DEFAULT_CLOSE_DECISION,
  LIMITS,
  isRecord,
  errorMessage,
};
