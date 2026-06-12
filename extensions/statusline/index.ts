import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import {
  GitWatcher,
  SEGMENT_IDS,
  SegmentState,
  computeSegments
} from "./segments";
import type {
  SegmentId,
  SegmentPart,
  SegmentToggle,
  StatuslineConfig
} from "./segments";
import { FooterController } from "./render";
import type { FooterHost } from "./render";

const FALLBACK: StatuslineConfig = {
  order: [...SEGMENT_IDS],
  separator: " │ ",
  segments: {
    model: { enabled: true },
    mode: { enabled: true },
    role: { enabled: true },
    git: { enabled: true },
    context: { enabled: true },
    usage: { enabled: true },
    todos: { enabled: true },
    cwd: { enabled: true },
    clock: { enabled: true }
  },
  gitIntervalMs: 5000,
  gitTimeoutMs: 3000,
  refreshMs: 30000,
  warnPercent: 80,
  errorPercent: 95
};

function deepMerge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const existing = out[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function overlayFrom(source: unknown): unknown {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    return (source as Record<string, unknown>)["statusline"];
  }
  return undefined;
}

function sanitizeOrder(value: unknown): SegmentId[] {
  const seen = new Set<SegmentId>();
  const order: SegmentId[] = [];
  const source = Array.isArray(value) ? value : [];
  for (const entry of source) {
    if (typeof entry === "string" && (SEGMENT_IDS as readonly string[]).includes(entry)) {
      const id = entry as SegmentId;
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  for (const id of SEGMENT_IDS) {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  return order;
}

function sanitizeSegments(value: unknown): Record<SegmentId, SegmentToggle> {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const out = {} as Record<SegmentId, SegmentToggle>;
  for (const id of SEGMENT_IDS) {
    const entry = record[id];
    const enabled =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).enabled
        : undefined;
    out[id] = { enabled: typeof enabled === "boolean" ? enabled : FALLBACK.segments[id].enabled };
  }
  return out;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function percent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : fallback;
}

function sanitizeConfig(raw: Record<string, unknown>): StatuslineConfig {
  return {
    order: sanitizeOrder(raw.order),
    separator: typeof raw.separator === "string" && raw.separator !== "" ? raw.separator : FALLBACK.separator,
    segments: sanitizeSegments(raw.segments),
    gitIntervalMs: positive(raw.gitIntervalMs, FALLBACK.gitIntervalMs),
    gitTimeoutMs: positive(raw.gitTimeoutMs, FALLBACK.gitTimeoutMs),
    refreshMs: positive(raw.refreshMs, FALLBACK.refreshMs),
    warnPercent: percent(raw.warnPercent, FALLBACK.warnPercent),
    errorPercent: percent(raw.errorPercent, FALLBACK.errorPercent)
  };
}

function loadConfig(): StatuslineConfig {
  let merged: Record<string, unknown> = { ...FALLBACK };
  try {
    const shipped = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    merged = deepMerge(merged, shipped);
  } catch {}
  merged = deepMerge(merged, overlayFrom(readJson(join(homedir(), ".pi", "agent", "piconfig.json"))));
  merged = deepMerge(merged, overlayFrom(readJson(join(process.cwd(), ".pi", "piconfig.json"))));
  return sanitizeConfig(merged);
}

function modelIdOf(model: unknown): string | null {
  if (typeof model === "string" && model.trim() !== "") return model.trim();
  if (model && typeof model === "object") {
    const record = model as Record<string, unknown>;
    for (const key of ["id", "name"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  return null;
}

function contextPercentOf(ctx: ExtensionContext): number | null {
  try {
    const usage = ctx.getContextUsage();
    if (!usage) return null;
    const record = usage as { tokens?: number | null; contextWindow?: number; percent?: number | null };
    if (typeof record.percent === "number" && Number.isFinite(record.percent)) return record.percent;
    if (
      typeof record.tokens === "number" &&
      Number.isFinite(record.tokens) &&
      typeof record.contextWindow === "number" &&
      record.contextWindow > 0
    ) {
      return (record.tokens / record.contextWindow) * 100;
    }
    return null;
  } catch {
    return null;
  }
}

function persistSegments(segments: Record<SegmentId, SegmentToggle>): { ok: boolean; message: string } {
  const dir = join(homedir(), ".pi", "agent");
  const file = join(dir, "piconfig.json");
  let root: Record<string, unknown> = {};
  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== null && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { ok: false, message: `Statusline not saved: ${file} contains invalid JSON` };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    } else {
      return { ok: false, message: `Statusline not saved: ${file} is not a JSON object` };
    }
  }
  const current = root.statusline;
  const section =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  section.segments = Object.fromEntries(
    SEGMENT_IDS.map(id => [id, { enabled: segments[id].enabled }])
  );
  root.statusline = section;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    return { ok: true, message: `Statusline preferences saved to ${file}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Statusline not saved: ${reason}` };
  }
}

export default function statusline(pi: ExtensionAPI): void {
  const config = loadConfig();
  const state = new SegmentState();
  const git = new GitWatcher(
    (command, args, options) => pi.exec(command, args, options),
    config.gitIntervalMs,
    config.gitTimeoutMs
  );
  let latestCtx: ExtensionContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const buildParts = (): SegmentPart[] => {
    const ctx = latestCtx;
    return computeSegments(config.order, config.segments, {
      modelId: ctx ? modelIdOf(ctx.model) : null,
      contextPercent: ctx ? contextPercentOf(ctx) : null,
      cwd: ctx?.cwd ?? process.cwd(),
      git: git.current(),
      state,
      warnPercent: config.warnPercent,
      errorPercent: config.errorPercent,
      now: new Date()
    });
  };

  const controller = new FooterController(config.separator, buildParts);

  const pollGit = (): void => {
    const ctx = latestCtx;
    if (!ctx || !controller.installed) return;
    git.poll(ctx.cwd ?? process.cwd(), () => controller.refresh());
  };

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  pi.events.on("piconfig:usage", (payload: unknown) => {
    state.applyUsage(payload);
    controller.refresh();
  });

  pi.events.on("piconfig:mode", (payload: unknown) => {
    state.applyMode(payload);
    controller.refresh();
  });

  pi.events.on("piconfig:role", (payload: unknown) => {
    state.applyRole(payload);
    controller.refresh();
  });

  pi.events.on("piconfig:todos", (payload: unknown) => {
    state.applyTodos(payload);
    controller.refresh();
  });

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    latestCtx = ctx;
    if (!ctx.hasUI) return;
    controller.install(ctx.ui as unknown as FooterHost);
    stopTimer();
    timer = setInterval(() => {
      controller.refresh();
      pollGit();
    }, config.refreshMs);
    timer.unref?.();
    pollGit();
  });

  pi.on("model_select", (_event: unknown, ctx: ExtensionContext) => {
    latestCtx = ctx;
    controller.refresh();
  });

  pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
    latestCtx = ctx;
    controller.refresh();
    pollGit();
  });

  pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
    stopTimer();
    if (ctx.hasUI) controller.uninstall(ctx.ui as unknown as FooterHost);
  });

  pi.registerCommand("statusline", {
    description: "Toggle statusline segments on or off and persist the layout",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      latestCtx = ctx;
      let changed = false;
      for (;;) {
        const options = config.order.map(
          id => `${id}: ${config.segments[id].enabled ? "on" : "off"}`
        );
        const picked = await ctx.ui.select("Statusline segments", [...options, "done"]);
        if (picked === undefined || picked === "done") break;
        const id = picked.split(":")[0] as SegmentId;
        if (!(SEGMENT_IDS as readonly string[]).includes(id)) continue;
        const choice = await ctx.ui.select(`Segment "${id}"`, ["on", "off"]);
        if (choice !== "on" && choice !== "off") continue;
        const enabled = choice === "on";
        if (config.segments[id].enabled !== enabled) {
          config.segments[id] = { enabled };
          changed = true;
          controller.refresh();
        }
      }
      if (!changed) return;
      const outcome = persistSegments(config.segments);
      ctx.ui.notify(outcome.message, outcome.ok ? "info" : "error");
    }
  });
}
