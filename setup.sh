#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

SUITE_ITEMS="packages agents skills prompts themes companion AGENTS.md SYSTEM.md"

say() {
  printf '\033[1;36m[pi-config]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[pi-config]\033[0m %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found in PATH"
}

run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 120 "$@"
  else
    "$@"
  fi
}

move_config() {
  if [ "$ROOT" = "$AGENT_DIR" ]; then
    say "config already lives in $AGENT_DIR; not copying"
    return
  fi

  say "installing the pi-config suite into $AGENT_DIR"
  mkdir -p "$AGENT_DIR"

  local item
  for item in $SUITE_ITEMS; do
    if [ -e "$ROOT/$item" ]; then
      rm -rf "${AGENT_DIR:?}/$item"
      cp -R "$ROOT/$item" "$AGENT_DIR/$item"
    fi
  done

  find "$AGENT_DIR/packages" -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
}

install_dependencies() {
  local pkg
  say "installing package dependencies"
  for pkg in "$AGENT_DIR"/packages/*/; do
    [ -f "${pkg}package.json" ] || continue
    say "  ${pkg#"$AGENT_DIR"/}"
    npm install --omit=dev --no-audit --no-fund --package-lock=false --loglevel=error --prefix "$pkg" >/dev/null
  done
}

write_settings() {
  if [ -f "$AGENT_DIR/settings.json" ]; then
    cp "$AGENT_DIR/settings.json" "$AGENT_DIR/settings.json.bak"
    say "backed up existing settings.json to settings.json.bak"
  fi

  node -e '
    const fs = require("fs");
    const path = require("path");
    const agentDir = process.argv[1];
    const root = process.argv[2];
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8"));
    const pkgsDir = path.join(agentDir, "packages");
    cfg.packages = fs.readdirSync(pkgsDir)
      .filter((name) => fs.existsSync(path.join(pkgsDir, name, "package.json")))
      .sort()
      .map((name) => path.join(pkgsDir, name));
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(cfg, null, 2) + "\n");
  ' "$AGENT_DIR" "$ROOT"

  say "wrote $AGENT_DIR/settings.json (packages under $AGENT_DIR/packages)"
}

ensure_suite_config() {
  if [ ! -e "$AGENT_DIR/suite.json" ]; then
    printf '{}\n' > "$AGENT_DIR/suite.json"
    say "created empty suite.json"
  fi
}

register_in_editor() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    const pkgPath = process.argv[2];
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const id = pkg.publisher + "." + pkg.name;
    const rel = id + "-" + pkg.version;
    const file = path.join(root, "extensions.json");
    let list = [];
    let raw;

    try { raw = fs.readFileSync(file, "utf8"); } catch { raw = undefined; }

    if (raw !== undefined) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) process.exit(0);
      list = parsed;
    }

    list = list.filter((e) => !(e && e.identifier && typeof e.identifier.id === "string" && e.identifier.id.toLowerCase() === id.toLowerCase()));
    list.push({
      identifier: { id },
      version: pkg.version,
      location: { "$mid": 1, path: path.join(root, rel), scheme: "file" },
      relativeLocation: rel,
      metadata: { installedTimestamp: Date.now(), source: "vsix", pinned: true, updated: false, private: false, isPreReleaseVersion: false, hasPreReleaseVersion: false },
    });

    if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
    fs.writeFileSync(file, JSON.stringify(list));
  ' "$1" "$2"
}

pick_dir() {
  local dir
  for dir in "$@"; do
    if [ -d "$dir" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done

  printf '%s\n' "$1"
}

install_companion() {
  local src="$AGENT_DIR/companion"

  if [ ! -f "$src/package.json" ]; then
    say "no companion extension found; skipping IDE bridge install"
    return
  fi

  local id
  id="$(node -e 'const p = require(process.argv[1]); process.stdout.write(p.publisher + "." + p.name + "-" + p.version)' "$src/package.json")"

  local targets=()

  if command -v code >/dev/null 2>&1; then
    targets+=("$(pick_dir "$HOME/.vscode/extensions" "$HOME/.var/app/com.visualstudio.code/data/vscode/extensions")")
  fi

  if command -v code-insiders >/dev/null 2>&1; then
    targets+=("$(pick_dir "$HOME/.vscode-insiders/extensions")")
  fi

  if command -v codium >/dev/null 2>&1 || command -v code-oss >/dev/null 2>&1; then
    targets+=("$(pick_dir "$HOME/.vscode-oss/extensions" "$HOME/.vscodium/extensions" "$HOME/.var/app/com.vscodium.codium/data/vscode-oss/extensions")")
  fi

  if command -v cursor >/dev/null 2>&1; then
    targets+=("$(pick_dir "$HOME/.cursor/extensions")")
  fi

  if command -v windsurf >/dev/null 2>&1; then
    targets+=("$(pick_dir "$HOME/.windsurf/extensions")")
  fi

  if command -v flatpak >/dev/null 2>&1; then
    if ! command -v code >/dev/null 2>&1 && flatpak info com.visualstudio.code >/dev/null 2>&1; then
      targets+=("$HOME/.var/app/com.visualstudio.code/data/vscode/extensions")
    fi

    if ! command -v codium >/dev/null 2>&1 && ! command -v code-oss >/dev/null 2>&1 && flatpak info com.vscodium.codium >/dev/null 2>&1; then
      targets+=("$HOME/.var/app/com.vscodium.codium/data/vscode-oss/extensions")
    fi
  fi

  if [ "${#targets[@]}" -eq 0 ]; then
    say "no VS Code-family editor detected on PATH; run /ide install inside pi once your editor is installed"
    return
  fi

  local root
  for root in "${targets[@]}"; do
    mkdir -p "$root"
    rm -rf "${root:?}/$id"
    cp -R "$src" "$root/$id"
    register_in_editor "$root" "$src/package.json"
    say "installed IDE companion into $root/$id"
  done

  say "reload your editor window to activate the pi-config IDE Bridge, then /ide status to verify"
}

run_doctor() {
  if ! command -v pi >/dev/null 2>&1; then
    say "pi not on PATH; skipping /doctor (install @earendil-works/pi-coding-agent, then run 'pi -p /doctor' in $AGENT_DIR)"
    return
  fi

  say "verifying the suite with /doctor"
  local out

  if out="$(cd "$AGENT_DIR" && run_with_timeout env PI_CODING_AGENT_DIR="$AGENT_DIR" pi -p "/doctor" 2>&1)"; then
    printf '%s\n' "$out"
  else
    printf '%s\n' "$out"
    fail "pi failed to run /doctor; review the output above"
  fi
}

main() {
  need npm
  need node
  move_config
  install_dependencies
  write_settings
  ensure_suite_config
  install_companion
  run_doctor

  say "setup complete — the entire pi-config now lives in $AGENT_DIR"
}

main "$@"
