import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatFindings,
  isMode,
  isRecord,
  MODES,
  runCheck,
  type CheckResult,
  type CommentsConfig,
  type DetectorToggles,
  type Mode,
} from "./check.ts";

const ENTRY_TYPE = "piconfig:comments";
const HISTORY_LIMIT = 5;

const FALLBACK: CommentsConfig = {
  mode: "block",
  maxFindings: 10,
  allowMarker: "@allow-comment",
  ignore: [
    "**/vendor/**",
    "**/vendored/**",
    "**/node_modules/**",
    "**/third_party/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/target/**",
    "**/.next/**",
    "**/coverage/**",
    "**/__generated__/**",
    "**/*.gen.*",
    "**/*.generated.*",
    "**/*_generated.*",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.md",
    "**/*.markdown",
    "**/*.mdx",
    "**/*.lock",
    "**/package-lock.json",
  ],
  detectors: {
    narration: true,
    fillerdoc: true,
    changemarker: true,
    todo: true,
    separator: true,
  },
};

const MODE_DESCRIPTIONS: Record<Mode, string> = {
  block: "slop comments block the write/edit until rewritten",
  warn: "slop comments pass but trigger a follow-up notice",
  off: "comment policing disabled",
};

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) {
      merged[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeDetectors(value: unknown): DetectorToggles {
  const detectors = { ...FALLBACK.detectors };
  if (isRecord(value)) {
    for (const key of Object.keys(detectors) as Array<keyof DetectorToggles>) {
      const candidate = value[key];
      if (typeof candidate === "boolean") {
        detectors[key] = candidate;
      }
    }
  }
  return detectors;
}

function normalizeIgnore(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...FALLBACK.ignore];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeConfig(raw: Record<string, unknown>): CommentsConfig {
  const maxFindings =
    typeof raw.maxFindings === "number" && Number.isFinite(raw.maxFindings) && raw.maxFindings >= 1
      ? Math.floor(raw.maxFindings)
      : FALLBACK.maxFindings;
  const allowMarker =
    typeof raw.allowMarker === "string" && raw.allowMarker.trim().length > 0
      ? raw.allowMarker.trim()
      : FALLBACK.allowMarker;
  return {
    mode: isMode(raw.mode) ? raw.mode : FALLBACK.mode,
    maxFindings,
    allowMarker,
    ignore: normalizeIgnore(raw.ignore),
    detectors: normalizeDetectors(raw.detectors),
  };
}

function loadConfig(): CommentsConfig {
  let merged: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) {
      merged = parsed;
    }
  } catch {
    merged = {};
  }
  const overridePaths = [join(homedir(), ".pi", "agent", "suite.json"), join(process.cwd(), ".pi", "suite.json")];
  for (const path of overridePaths) {
    const overrides = readJsonFile(path);
    if (overrides !== undefined && isRecord(overrides.comments)) {
      merged = deepMerge(merged, overrides.comments);
    }
  }
  return normalizeConfig(merged);
}

export default function comments(pi: ExtensionAPI): void {
  const config = loadConfig();
  const state: { mode: Mode; history: CheckResult[]; lastWarnKey: string } = {
    mode: config.mode,
    history: [],
    lastWarnKey: "",
  };

  const blockReason = (result: CheckResult): string => {
    const count = result.findings.length;
    return [
      `comments: blocked ${result.tool} to ${result.path} — ${count} low-value comment finding${count === 1 ? "" : "s"} (line numbers refer to the new content):`,
      formatFindings(result.findings, config.maxFindings),
      `Retry the ${result.tool} with these comments removed or rewritten to explain why rather than what. To intentionally keep one, include ${config.allowMarker} in that comment line.`,
    ].join("\n");
  };

  const warnNotice = (result: CheckResult): string => {
    const count = result.findings.length;
    return [
      `comments: found ${count} low-value comment finding${count === 1 ? "" : "s"} in ${result.path} (warn mode, change was applied; line numbers refer to the new content):`,
      formatFindings(result.findings, config.maxFindings),
      `Please remove or rewrite them; include ${config.allowMarker} in any comment that should stay.`,
    ].join("\n");
  };

  const warnKey = (result: CheckResult): string =>
    `${result.path}|${result.findings.map((finding) => `${finding.rule}:${finding.text}`).join("|")}`;

  const recordResult = (result: CheckResult): void => {
    state.history.unshift(result);
    if (state.history.length > HISTORY_LIMIT) {
      state.history = state.history.slice(0, HISTORY_LIMIT);
    }
  };

  const applyMode = (mode: Mode, ctx: ExtensionContext, announce: boolean): void => {
    const changed = mode !== state.mode;
    state.mode = mode;
    if (changed) {
      try {
        pi.appendEntry(ENTRY_TYPE, { mode });
      } catch {
        void 0;
      }
    }
    if (announce && ctx.hasUI) {
      ctx.ui.notify(`comments mode: ${mode} (${MODE_DESCRIPTIONS[mode]})`, "info");
    }
  };

  const buildReport = (): string => {
    const lines = [`mode: ${state.mode} (${MODE_DESCRIPTIONS[state.mode]})`];
    const active = (Object.entries(config.detectors) as Array<[string, boolean]>)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    lines.push(`detectors: ${active.length > 0 ? active.join(", ") : "(none)"}`);
    lines.push(`allow marker: ${config.allowMarker}`);
    lines.push(`ignore globs: ${config.ignore.length}`);
    lines.push(`max findings reported: ${config.maxFindings}`);
    if (state.history.length === 0) {
      lines.push("last findings: (none this session)");
    } else {
      const latest = state.history[0];
      lines.push(
        `last findings: ${latest.findings.length} in ${latest.path} via ${latest.tool}; run /comments last for details`,
      );
    }
    return lines.join("\n");
  };

  const buildHistory = (): string => {
    if (state.history.length === 0) {
      return "comments: no findings recorded this session.";
    }
    const sections = state.history.map((result, index) =>
      [`${index + 1}) ${result.path} (${result.tool}, ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}):`, formatFindings(result.findings, config.maxFindings)].join("\n"),
    );
    return sections.join("\n\n");
  };

  pi.on("session_start", (_event, ctx) => {
    state.history = [];
    state.lastWarnKey = "";
    let mode: Mode = config.mode;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        const candidate = entry as { type?: string; customType?: string; data?: unknown };
        if (
          candidate.type === "custom" &&
          candidate.customType === ENTRY_TYPE &&
          isRecord(candidate.data) &&
          isMode(candidate.data.mode)
        ) {
          mode = candidate.data.mode;
        }
      }
    } catch {
      mode = config.mode;
    }
    state.mode = mode;
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      if (state.mode === "off") {
        return undefined;
      }
      if (event.toolName !== "write" && event.toolName !== "edit") {
        return undefined;
      }
      const result = runCheck(event.toolName, event.input, ctx.cwd, config);
      if (result === null) {
        return undefined;
      }
      recordResult(result);
      if (state.mode === "block") {
        return { block: true, reason: blockReason(result) };
      }
      const key = warnKey(result);
      if (key !== state.lastWarnKey) {
        state.lastWarnKey = key;
        pi.sendMessage(
          { customType: "commentsnotice", content: warnNotice(result), display: true },
          { deliverAs: "followUp" },
        );
      }
      return undefined;
    } catch {
      return undefined;
    }
  });

  pi.registerCommand("comments", {
    description: "Show comment-police mode, set block | warn | off, or list last findings with /comments last",
    getArgumentCompletions: (argumentPrefix: string): Array<{ value: string; label: string }> | null => {
      const needle = argumentPrefix.trim().toLowerCase();
      const items = [
        { value: "block", label: "block — reject writes/edits that add slop comments" },
        { value: "warn", label: "warn — allow but send a follow-up notice" },
        { value: "off", label: "off — disable comment policing" },
        { value: "last", label: "last — list findings from recent checks" },
      ].filter((item) => item.value.startsWith(needle));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const request = (args ?? "").trim().toLowerCase();
      if (request.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify(buildReport(), "info");
        }
        return;
      }
      if (isMode(request)) {
        applyMode(request, ctx, true);
        return;
      }
      if (request === "last" || request === "findings") {
        if (ctx.hasUI) {
          ctx.ui.notify(buildHistory(), "info");
        }
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `comments: unknown argument "${request}" (usage: /comments | /comments ${MODES.join(" | ")} | /comments last)`,
          "error",
        );
      }
    },
  });
}
