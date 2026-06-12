import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

interface StylesConfig {
  active: string;
  userDir: string;
}

type StyleSource = "preset" | "user";

interface Style {
  name: string;
  description: string;
  body: string;
  source: StyleSource;
  path: string;
}

interface StyleError {
  path: string;
  message: string;
}

interface Catalog {
  styles: Map<string, Style>;
  errors: StyleError[];
}

interface Frontmatter {
  data: Record<string, string>;
  body: string;
  error: string | null;
}

const DEFAULTS: StylesConfig = {
  active: "default",
  userDir: "~/.pi/agent/styles",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errnoCode(cause: unknown): string | undefined {
  return isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;
}

function coerceName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function loadConfig(): StylesConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "piconfig.json"));
  if (globalConfig && isRecord(globalConfig.styles)) merged = deepMerge(merged, globalConfig.styles);
  const projectConfig = readJson(join(process.cwd(), ".pi", "piconfig.json"));
  if (projectConfig && isRecord(projectConfig.styles)) merged = deepMerge(merged, projectConfig.styles);
  return {
    active: coerceName(merged.active, DEFAULTS.active),
    userDir: coerceName(merged.userDir, DEFAULTS.userDir),
  };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseFrontmatter(raw: string): Frontmatter {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { data: {}, body: "", error: "missing frontmatter opening delimiter" };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { data: {}, body: "", error: "missing frontmatter closing delimiter" };
  }
  const data: Record<string, string> = {};
  for (let i = 1; i < close; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      return { data: {}, body: "", error: `invalid frontmatter line ${i + 1}: "${trimmed}"` };
    }
    const key = trimmed.slice(0, colon).trim();
    data[key] = unquote(trimmed.slice(colon + 1).trim());
  }
  return { data, body: lines.slice(close + 1).join("\n").trim(), error: null };
}

function parseStyleFile(path: string, source: StyleSource): { style: Style | null; error: StyleError | null } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    return { style: null, error: { path, message: `unreadable: ${describeError(cause)}` } };
  }
  const parsed = parseFrontmatter(raw);
  if (parsed.error !== null) {
    return { style: null, error: { path, message: parsed.error } };
  }
  const name = parsed.data.name ?? "";
  if (name === "") {
    return { style: null, error: { path, message: 'frontmatter "name" is required and must be non-empty' } };
  }
  if (!/^\S+$/.test(name)) {
    return { style: null, error: { path, message: 'frontmatter "name" must be a single word without whitespace' } };
  }
  if (name.toLowerCase() === "off") {
    return { style: null, error: { path, message: '"off" is a reserved style name' } };
  }
  const description = parsed.data.description ?? "";
  if (description === "") {
    return { style: null, error: { path, message: 'frontmatter "description" is required and must be non-empty' } };
  }
  if (parsed.body === "") {
    return { style: null, error: { path, message: "style body is empty" } };
  }
  return { style: { name, description, body: parsed.body, source, path }, error: null };
}

function listMarkdown(dir: string): { files: string[]; error: StyleError | null } {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
      .map((name) => join(dir, name));
    return { files, error: null };
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === "ENOENT" || code === "ENOTDIR") return { files: [], error: null };
    return { files: [], error: { path: dir, message: `unreadable directory: ${describeError(cause)}` } };
  }
}

function discover(userDir: string): Catalog {
  const styles = new Map<string, Style>();
  const errors: StyleError[] = [];
  const tiers: { dir: string; source: StyleSource }[] = [
    { dir: fileURLToPath(new URL("presets", import.meta.url)), source: "preset" },
    { dir: userDir, source: "user" },
  ];
  for (const tier of tiers) {
    const listing = listMarkdown(tier.dir);
    if (listing.error !== null) errors.push(listing.error);
    for (const file of listing.files) {
      const result = parseStyleFile(file, tier.source);
      if (result.error !== null) {
        errors.push(result.error);
        continue;
      }
      if (result.style === null) continue;
      const key = result.style.name.toLowerCase();
      const existing = styles.get(key);
      if (existing !== undefined && existing.source === tier.source) {
        errors.push({
          path: file,
          message: `duplicate style name "${result.style.name}" (already defined by ${existing.path})`,
        });
        continue;
      }
      styles.set(key, result.style);
    }
  }
  return { styles, errors };
}

function persistActive(active: string): boolean {
  const dir = join(homedir(), ".pi", "agent");
  const file = join(dir, "piconfig.json");
  let raw: string | null = null;
  try {
    raw = readFileSync(file, "utf8");
  } catch (cause) {
    if (errnoCode(cause) !== "ENOENT") return false;
  }
  let root: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isRecord(parsed)) return false;
    root = { ...parsed };
  }
  const section: Record<string, unknown> = isRecord(root.styles) ? { ...root.styles } : {};
  section.active = active;
  root.styles = section;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, Math.max(0, max - 3))}...`;
}

function formatNotices(catalog: Catalog, active: string): string | null {
  const lines: string[] = [];
  if (catalog.errors.length > 0) {
    lines.push(`Styles: skipped ${catalog.errors.length} invalid style file${catalog.errors.length === 1 ? "" : "s"}:`);
    for (const error of catalog.errors) {
      lines.push(`  ${error.path}: ${error.message}`);
    }
  }
  if (active.toLowerCase() !== "off" && !catalog.styles.has(active.toLowerCase())) {
    lines.push(`Styles: active style "${active}" was not found; no style addendum is being applied.`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export default function styles(pi: ExtensionAPI): void {
  const initial = loadConfig();
  const state = {
    active: initial.active,
    userDir: expandHome(initial.userDir),
    catalog: discover(expandHome(initial.userDir)),
  };

  const refreshCatalog = (): void => {
    state.catalog = discover(state.userDir);
  };

  pi.on("session_start", () => {
    const fresh = loadConfig();
    state.active = fresh.active;
    state.userDir = expandHome(fresh.userDir);
    refreshCatalog();
  });

  pi.on("resources_discover", (event) => {
    if (event.reason === "reload") refreshCatalog();
    return undefined;
  });

  pi.on("before_agent_start", (event) => {
    if (state.active.toLowerCase() === "off") return undefined;
    const style = state.catalog.styles.get(state.active.toLowerCase());
    if (style === undefined) return undefined;
    const incoming = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
    const addendum = `## Output style: ${style.name}\n\n${style.body}`;
    return { systemPrompt: incoming === "" ? addendum : `${incoming}\n\n${addendum}` };
  });

  pi.registerCommand("style", {
    description: 'Select the active output style ("/style <name>" applies directly, "/style off" disables)',
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      const prefix = argumentPrefix.trim().toLowerCase();
      const items: AutocompleteItem[] = [];
      for (const style of state.catalog.styles.values()) {
        items.push({ value: style.name, label: style.name, description: clip(style.description, 80) });
      }
      items.push({ value: "off", label: "off", description: "Disable the output style addendum" });
      const filtered = items.filter((item) => item.value.toLowerCase().startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx): Promise<void> => {
      refreshCatalog();
      const apply = (requested: string): void => {
        const key = requested.toLowerCase();
        if (key === "off") {
          state.active = "off";
          const persisted = persistActive("off");
          if (ctx.hasUI) {
            ctx.ui.notify(
              persisted
                ? "Output style disabled."
                : "Output style disabled for this session; could not persist to ~/.pi/agent/piconfig.json.",
              persisted ? "info" : "warning",
            );
          }
          return;
        }
        const style = state.catalog.styles.get(key);
        if (style === undefined) {
          if (ctx.hasUI) {
            const available = [...state.catalog.styles.values()].map((entry) => entry.name).join(", ");
            ctx.ui.notify(
              available === ""
                ? `Unknown style "${requested}" and no styles are available.`
                : `Unknown style "${requested}". Available: ${available}, off`,
              "error",
            );
          }
          return;
        }
        state.active = style.name;
        const persisted = persistActive(style.name);
        if (ctx.hasUI) {
          ctx.ui.notify(
            persisted
              ? `Output style: ${style.name} (${style.source})`
              : `Output style ${style.name} applied for this session; could not persist to ~/.pi/agent/piconfig.json.`,
            persisted ? "info" : "warning",
          );
        }
      };

      const requested = typeof args === "string" ? args.trim() : "";
      const notices = formatNotices(state.catalog, state.active);
      if (notices !== null && ctx.hasUI) ctx.ui.notify(notices, "warning");
      if (requested !== "") {
        apply(requested);
        return;
      }
      if (!ctx.hasUI) return;
      const options: string[] = [];
      const values: string[] = [];
      for (const style of state.catalog.styles.values()) {
        const marker = style.name.toLowerCase() === state.active.toLowerCase() ? "* " : "  ";
        options.push(`${marker}${style.name} (${style.source}) - ${clip(style.description, 100)}`);
        values.push(style.name);
      }
      const offMarker = state.active.toLowerCase() === "off" ? "* " : "  ";
      options.push(`${offMarker}off - disable output style`);
      values.push("off");
      const choice = await ctx.ui.select("Output style", options);
      if (choice === undefined) return;
      const index = options.indexOf(choice);
      if (index === -1) return;
      apply(values[index]);
    },
  });
}
