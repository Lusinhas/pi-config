#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

say() {
  printf '\033[1;36m[pi-config]\033[0m %s\n' "$1"
}

fail() {
  printf '\033[1;31m[pi-config]\033[0m %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node is required but was not found in PATH"
command -v npm >/dev/null 2>&1 || fail "npm is required but was not found in PATH"

say "installing package dependencies in $ROOT"
npm install --omit=dev --no-audit --no-fund --prefix "$ROOT" >/dev/null

PI_BIN=""
if command -v pi >/dev/null 2>&1; then
  PI_BIN="$(command -v pi)"
  say "found pi at $PI_BIN"
else
  say "pi not found in PATH; installing @earendil-works/pi-coding-agent globally"
  if npm install -g @earendil-works/pi-coding-agent >/dev/null 2>&1 && command -v pi >/dev/null 2>&1; then
    PI_BIN="$(command -v pi)"
    say "installed pi at $PI_BIN"
  else
    PI_BIN="$ROOT/node_modules/.bin/pi"
    [ -x "$PI_BIN" ] || fail "global install failed and no local pi binary exists; run: npm install -g @earendil-works/pi-coding-agent"
    say "global install not possible; using local binary at $PI_BIN (add it to PATH or install globally later)"
  fi
fi

say "preparing config dir $AGENT_DIR"
mkdir -p "$AGENT_DIR"

ROOT="$ROOT" AGENT_DIR="$AGENT_DIR" node <<'EOF'
const { readFileSync, writeFileSync, existsSync, realpathSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

const root = process.env.ROOT;
const agentDir = process.env.AGENT_DIR;
const target = join(agentDir, "settings.json");

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const merge = (base, override) => {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isObject(value) && isObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
};

const resolves = (entry) => {
  const source = typeof entry === "string" ? entry : isObject(entry) ? entry.source : null;
  if (typeof source !== "string") return null;
  const expanded = source.startsWith("~") ? join(homedir(), source.slice(1)) : source;
  try {
    return realpathSync(expanded);
  } catch {
    return null;
  }
};

const defaults = readJson(join(root, "settings.json")) ?? {};
const existing = existsSync(target) ? readJson(target) : null;
if (existsSync(target) && existing === null) {
  console.error(`[pi-config] ${target} exists but is not valid JSON; fix or remove it first`);
  process.exit(1);
}

const merged = merge(defaults, existing ?? {});
const rootReal = realpathSync(root);
const relative = (entry) => {
  const source = typeof entry === "string" ? entry : isObject(entry) ? entry.source : null;
  return typeof source === "string" && (source === "." || source.startsWith("./") || source.startsWith("../"));
};
const packages = (Array.isArray(merged.packages) ? merged.packages : []).filter((entry) => !relative(entry));
const registered = packages.some((entry) => resolves(entry) === rootReal);
if (!registered) {
  const homeReal = realpathSync(homedir());
  const entry = rootReal.startsWith(homeReal + "/") ? "~" + rootReal.slice(homeReal.length) : rootReal;
  packages.push(entry);
}
merged.packages = packages;

const next = JSON.stringify(merged, null, 2) + "\n";
if (existing !== null) {
  const current = readFileSync(target, "utf8");
  if (current !== next) {
    writeFileSync(target + ".bak", current);
    console.log(`[pi-config] existing settings backed up to ${target}.bak`);
  }
}
writeFileSync(target, next);
console.log(`[pi-config] settings merged into ${target}`);
EOF

for doc in AGENTS.md APPEND_SYSTEM.md; do
  if [ -e "$AGENT_DIR/$doc" ]; then
    say "$doc already exists in $AGENT_DIR; left untouched (template: $ROOT/$doc)"
  else
    cp "$ROOT/$doc" "$AGENT_DIR/$doc"
    say "installed $doc into $AGENT_DIR"
  fi
done

if [ ! -e "$AGENT_DIR/piconfig.json" ]; then
  printf '{}\n' > "$AGENT_DIR/piconfig.json"
  say "created empty $AGENT_DIR/piconfig.json"
fi

say "verifying package load with /doctor"
DOCTOR_OUT=""
if DOCTOR_OUT="$(cd "$AGENT_DIR" && timeout 120 env PI_CODING_AGENT_DIR="$AGENT_DIR" "$PI_BIN" -p "/doctor" 2>&1)"; then
  printf '%s\n' "$DOCTOR_OUT"
  case "$DOCTOR_OUT" in
    *"0 error(s)"*) say "doctor reports a clean load" ;;
    *) say "doctor reported problems above; review before using" ;;
  esac
else
  printf '%s\n' "$DOCTOR_OUT"
  fail "pi failed to run /doctor; see output above"
fi

say "setup complete"
say "next steps:"
say "  1. export EXA_API_KEY=<key> (or set web.apiKey in $AGENT_DIR/piconfig.json) for websearch/webfetch"
say "  2. start pi and run /setup for the guided wizard (theme, approval mode)"
say "  3. run /doctor inside pi anytime to re-check the suite"
