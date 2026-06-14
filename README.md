# pi-config

A batteries-included configuration suite for the [pi](https://pi.dev) coding agent: the capabilities of ~30 classic extensions consolidated into **10 domain extensions**, plus 27 skills, 13 subagent definitions, 16 prompt templates, 5 themes, and a VS Code companion. It ports the workflows people miss from Claude Code, Codex, oh-my-pi, and oh-my-openagent — plan mode, permissions, subagents, todos, checkpoints, memory, MCP, hooks, web access, the VS Code IDE bridge, AST-aware editing, and more — onto upstream pi.

The repository root is not a Pi package. Each domain extension is an independent package under `packages/<domain>/`, with its entrypoint at `src/extension/index.ts`, its `config.json` at the package root, pi-free logic in `src/<concern>/` folders, and tests. The suite's resources live at the repo root (`agents/`, `skills/`, `prompts/`, `themes/`) and are registered explicitly through the `packages/core` manifest; the subagent definitions under `agents/` are loaded by the `agents` extension.

## What's inside

| Category | Contents |
| --- | --- |
| Extensions (10 domains) | **core** (loader, router, resource registration) · **context** (memory, compaction, sessions, rules) · **editing** (hashline, astgrep, comments) · **agents** (subagents, workflows, goals) · **tasks** (todos, plan, keywords) · **interface** (statusline, toolview, styles, usage, ask) · **guard** (permissions, checkpoint) · **bridges** (shell, web, mcp, ide, worktrees, hooks, artifacts) · **skills** (external Claude Code skill loading) · **auth** (Anthropic subscription/OAuth provider) |
| Skills | commit, rebase, pr, conflicts, code, security, simplify, unit, integration, coverage, deep, codebase, init, deepinit, debug, verify, batch, ci, release, deslop, refactor, design, browser, spec, threatmodel, whiteboxpentest, secretsresponse |
| Agents | reviewer, security, explorer, librarian, architect, critic, coder, tester, oracle, attacksurface, vulntracer, pentestrunner, reporter (used by the `agents` extension's `task` tool) |
| Prompts | commit, branch, changelog, amend, diff, pr, explain, document, summarize, types, lint, tests, build, brief, continue, recap |
| Themes | midnight, ember, abyss (dark); paper, dawn (light) |
| Companion | `companion/` — the "idebridge" VS Code extension powering the `bridges/ide` editor context, diagnostics, and diff previews |

## Install

Clone the repo, then run the installer:

```sh
git clone https://github.com/Lusinhas/pi-config.git
cd pi-config
./setup.sh
```

`setup.sh` copies the entire suite into `~/.pi/agent` — `packages/`, `agents/`, `skills/`, `prompts/`, `themes/`, the VS Code `companion/`, and the `AGENTS.md`/`SYSTEM.md` templates — then installs each package's dependencies there, writes `~/.pi/agent/settings.json` with the `packages` array pointing at `~/.pi/agent/packages/*` (any existing `settings.json` is backed up to `settings.json.bak`), installs the IDE-bridge companion into your editor (see [IDE bridge](#ide-bridge)), creates an empty `suite.json` if missing, and runs `/doctor`. Because everything lives under `~/.pi/agent` afterward, the clone is no longer referenced and can be deleted. (`PI_CODING_AGENT_DIR` overrides the target dir.)

### Manual install

If you would rather not run the script, copy the suite into your agent dir, install each package's dependencies there, and point your settings at the moved packages:

```sh
mkdir -p ~/.pi/agent
cp -R packages agents skills prompts themes companion AGENTS.md SYSTEM.md ~/.pi/agent/
for d in ~/.pi/agent/packages/*/; do npm install --omit=dev --prefix "$d"; done
```

```json
{
  "packages": [
    "~/.pi/agent/packages/core", "~/.pi/agent/packages/context", "~/.pi/agent/packages/editing",
    "~/.pi/agent/packages/agents", "~/.pi/agent/packages/tasks", "~/.pi/agent/packages/interface",
    "~/.pi/agent/packages/guard", "~/.pi/agent/packages/bridges", "~/.pi/agent/packages/skills",
    "~/.pi/agent/packages/auth"
  ]
}
```

(`~/.pi/agent/settings.json` for all projects, `.pi/settings.json` per project.) Each package's manifest registers its own extension; `packages/core` additionally registers the `prompts/`, `skills/`, and `themes/` resources sitting next to it. There is no conventional-directory auto-discovery.

### IDE bridge

`setup.sh` also installs the `companion/` extension ("pi-config IDE Bridge") into every VS Code-family editor it finds (`~/.vscode`, `~/.vscode-oss`/VSCodium, `~/.cursor`, `~/.windsurf`, and Flatpak variants) by copying it into the editor's `extensions/` directory **and registering it in that directory's `extensions.json`** — modern VS Code/VSCodium only loads extensions listed there, so a bare folder copy is silently ignored. Reload your editor window after setup, then run `/ide status` inside pi to confirm the connection. You can re-run the install at any time from inside pi with `/ide install`.

## Copy-in templates

Two files in this repo are templates, not package resources — pi only reads them from your config directories. `setup.sh` copies them for you; to do it by hand from the cloned repo:

```sh
mkdir -p ~/.pi/agent
cp AGENTS.md ~/.pi/agent/AGENTS.md
cp SYSTEM.md ~/.pi/agent/SYSTEM.md
```

- `AGENTS.md` — operational guide the agent reads as native context. Global at `~/.pi/agent/AGENTS.md`, or place a copy at a repo root for per-project context (pi walks up from the cwd).
- `SYSTEM.md` — behavioral addendum appended to pi's system prompt. Lives at `~/.pi/agent/SYSTEM.md`.
- `settings.json` — `setup.sh` writes `~/.pi/agent/settings.json` from the repo's `settings.json` with the `packages` array pointed at `~/.pi/agent/packages/*` (any existing one is backed up to `settings.json.bak`).

## First run: /setup and /doctor

- `/setup` — interactive first-run wizard (TUI only). Picks a theme (applied immediately and saved to pi's `settings.json`) and a permission mode (written to the `permissions` section of `~/.pi/agent/suite.json`).
- `/doctor` — health check. Re-runs resource discovery and reports broken skill/prompt/agent frontmatter, invalid theme JSON, name collisions, and config problems with file paths for each finding.

## Configuration: suite.json

All extensions read one file: `~/.pi/agent/suite.json` (global), deep-merged with `.pi/suite.json` (project wins). Every top-level key is an extension section and every key inside it is optional — omitted keys keep the shipped defaults, which live in each extension's `extensions/<name>/config.json`. The example below shows every section with its most useful keys at their default values (except `mcp.servers`, which shows the entry shape; long default lists such as `checkpoint.bashPatterns`, `comments.ignore`, and `astgrep.protectGlobs`/`langMap` are omitted — see the respective `config.json`).

```json
{
  "loader": {
    "prompts": true,
    "skills": true,
    "exclude": []
  },
  "skills": {
    "global": true,
    "project": true,
    "dirs": []
  },
  "auth": {
    "enabled": false,
    "longContext": false
  },
  "permissions": {
    "mode": "ask",
    "allow": [],
    "deny": [],
    "ask": [],
    "headless": "deny",
    "subagentBridge": true,
    "ideDiff": true,
    "judge": { "enabled": false, "model": "anthropic/claude-haiku-4-5", "maxRisk": "safe" }
  },
  "toolview": {
    "maxLines": 12,
    "maxLineChars": 160,
    "compactChars": 100,
    "viewportLines": 16
  },
  "plan": {
    "readonlyTools": ["read", "grep", "find", "ls"],
    "extraAllowed": ["websearch", "webfetch", "astsearch", "history", "task", "advisor"],
    "blockedTools": ["write", "edit", "bash"],
    "showWidget": true,
    "review": { "enabled": true, "timeoutMs": 120000 }
  },
  "todos": {
    "mirror": true,
    "widget": true,
    "inject": true,
    "widgetLimit": 8
  },
  "goals": {
    "judgeModel": "anthropic/claude-haiku-4-5",
    "metMarker": "<goal-met/>",
    "maxIterations": 25,
    "enforceTodos": false
  },
  "subagents": {
    "maxConcurrent": 4,
    "maxDepth": 2,
    "maxTokens": 0,
    "advisorModel": "",
    "advisorThinking": "xhigh",
    "widget": true,
    "widgetLimit": 4,
    "transcriptLimit": 60,
    "keepFinished": 20,
    "teams": {}
  },
  "workflows": {
    "timeoutSec": 1800,
    "maxAgents": 250
  },
  "router": {
    "roles": {
      "default": "claude-opus-4-8",
      "smol": "claude-haiku-4-5",
      "plan": { "model": "claude-opus-4-8", "thinking": "high" },
      "commit": { "model": "claude-haiku-4-5", "thinking": "off" },
      "review": { "model": "claude-opus-4-8", "thinking": "medium" }
    },
    "fallback": { "enabled": true, "threshold": 2, "restoreAfterMin": 10 },
    "profiles": {
      "deep": { "model": "claude-opus-4-8", "thinking": "xhigh" },
      "fast": { "model": "claude-haiku-4-5", "thinking": "off" }
    },
    "maxBudgetTokens": 100000
  },
  "memory": {
    "injectBudget": 2000,
    "recallBudget": 6000,
    "consolidateEvery": 0,
    "consolidateOnQuit": true,
    "model": "",
    "maxTopicBytes": 65536
  },
  "rules": {
    "formats": { "pi": true, "claude": true, "cursor": true, "copilot": true, "windsurf": true, "cline": true },
    "alwaysBudget": 8000,
    "scopedBudget": 6000
  },
  "compaction": {
    "strategy": "supersede",
    "dropOverBytes": 20480,
    "keepRecentTokens": 20000,
    "preemptPct": 85,
    "promotePct": 90,
    "shakeOverBytes": 10240,
    "handoffPath": ".pi/handoff.md"
  },
  "checkpoint": {
    "maxMb": 200,
    "maxAgeDays": 30,
    "maxFileMb": 25,
    "maxBashFiles": 20
  },
  "sessions": {
    "listLimit": 20,
    "readLimit": 60,
    "searchLimit": 50,
    "excerptChars": 160,
    "allowSwitch": false,
    "btwBudget": 12000
  },
  "styles": {
    "active": "default",
    "userDir": "~/.pi/agent/styles"
  },
  "shell": {
    "shell": "",
    "widget": true,
    "sandbox": { "enabled": false, "mode": "loose", "network": "full", "writePaths": [] },
    "jobs": { "autoBackgroundMs": 30000, "capBytes": 2097152, "defaultWaitSec": 30, "keepFinished": 20 }
  },
  "web": {
    "endpoint": "https://search.parallel.ai/mcp",
    "numResults": 8,
    "maxChars": 40000,
    "cacheTtlMin": 30,
    "timeoutSec": 30
  },
  "ide": {
    "autoConnect": true,
    "selection": true,
    "diff": true,
    "atMentions": true,
    "lockDir": "",
    "maxSelectionChars": 2000,
    "maxDiagnostics": 50
  },
  "astgrep": {
    "fileLimit": 2000,
    "defaultLimit": 50,
    "contextLines": 2,
    "maxHunks": 20,
    "maxFileBytes": 1048576,
    "execTimeout": 10000
  },
  "mcp": {
    "servers": {
      "github": { "command": "github-mcp-server", "args": ["stdio"] },
      "linear": { "url": "https://mcp.linear.app/mcp" },
      "warm": { "command": "needs-warmup", "lazy": false }
    },
    "lazy": true,
    "outputLimit": 25600,
    "inlineLimit": 8192,
    "requestTimeoutMs": 60000,
    "idleMs": 300000
  },
  "hashline": {
    "compat": true,
    "defaultMode": "hashline",
    "maxLines": 2000,
    "maxBytes": 51200
  },
  "artifacts": {
    "spillBytes": 30720,
    "headLines": 40,
    "tailLines": 20,
    "maxAgeDays": 7,
    "retrieveLines": 200
  },
  "ask": {
    "defaultTimeoutSec": 0
  },
  "comments": {
    "mode": "block",
    "maxFindings": 10,
    "allowMarker": "@allow-comment",
    "detectors": { "narration": true, "fillerdoc": true, "changemarker": true, "todo": true, "separator": true }
  },
  "keywords": {
    "keywords": { "ultrathink": "xhigh", "think harder": "high", "quickthink": "low" },
    "orchestrate": true,
    "ultrawork": true,
    "adaptive": false
  },
  "worktrees": {
    "dir": ".worktrees",
    "branchPrefix": "wt/",
    "includeFile": ".worktreeinclude",
    "confirmRemove": true
  },
  "hooks": {
    "shell": "/bin/sh",
    "defaultTimeoutMs": 60000,
    "eventBudgetMs": 120000,
    "maxOutputBytes": 16384
  },
  "statusline": {
    "order": ["model", "mode", "role", "git", "context", "usage", "todos", "cwd", "clock"],
    "separator": " │ ",
    "warnPercent": 80,
    "errorPercent": 95
  },
  "usage": {
    "statsDays": 30,
    "costDecimals": 4
  }
}
```

### Section reference

| Section | Commands | Tools | What it does |
| --- | --- | --- | --- |
| loader | /doctor, /setup | — | Discovers the package's skills/prompts (themes load through the package manifest), applies excludes, first-run wizard and health check |
| skills | — | — | Loads Claude Code skills: `~/.claude/skills` globally and `.claude/skills` from the cwd and ancestors up to the git root (trusted projects only); `dirs` adds extra skill directories such as `~/.codex/skills` |
| auth | — | — | Optional Claude Code-style Anthropic provider (off by default — set `enabled`): registers a model provider that signs requests with stored subscription/OAuth credentials (auto-refreshed), a Claude-Code billing transform, and a model catalog, with streaming and an optional `longContext` mode |
| subagents | /agents (view, tasks, kill) | task, advisor | Delegation to the 13 `agents/*.md` subagents with a depth cap and an optional per-agent token cap (`maxTokens`, off by default); subagents run to completion with no turn cap (like Claude Code), and token accounting counts new work (input + output + cache writes), excluding cache reads. Live task widget (activity lines sized to the terminal width) plus `/agents view` viewer with transcripts and kill, and advisor for read-only second opinions |
| workflows | /workflows (view, show, kill) | workflow | Deterministic JavaScript orchestration scripts (agent/parallel/pipeline fan-out with phases, budgets, and caps, saved under `.pi/workflows/` or `~/.pi/agent/workflows/`) with a live run viewer and background runs (`background: true` returns the run id immediately and delivers the result as a follow-up message, like the task tool). The workflow tool accepts per-run `maxTokens` (per-agent token ceiling) and `maxAgents` overrides set at launch; agents run through the subagents runner, sharing its concurrency slots, viewer, and permission bridge |
| permissions | /permissions, /mode | — | ask/write/yolo modes with allow/deny/ask rules and optional LLM risk judge; subagent tool calls are bridged to the main session for approval (subagentBridge); approval prompts use toolview's scrollable preview when available. When the IDE bridge is connected, edit/write approvals (in ask mode) open an editable diff in VS Code — Accept/Reject is the decision and hand-edits are written back (`ideDiff`, on by default; falls back to the terminal prompt when no IDE is connected) |
| toolview | — | — | Human-readable tool-call previews (bash commands, edit diffs, write contents, paths) instead of raw JSON, sized to the terminal width with `maxLineChars`/`compactChars` as fallbacks when the width is unknown, with a scrollable approval dialog (PgUp/PgDn) used by the permissions extension and compact previews for subagent activity lines; other extensions can register per-tool renderers via the `piconfig.toolview` global registry |
| hooks | /hooks | — | Claude-compatible lifecycle command hooks from `~/.pi/agent/hooks.json` and `.pi/hooks.json`, plus background monitors |
| plan | /plan | — | Read-only plan mode: blocks mutating tools, reviews the presented plan, approve/refine flow |
| todos | /todos | todo | Persistent todo list with widget, context injection, and a `piconfig:todos` bus feed; mirrors live under `~/.pi/agent/todos/`, never inside the project |
| goals | /goal, /loop | — | Judge-checked goal conditions (`<goal-met/>`) and interval-driven prompt loops |
| memory | /memory | memory | Per-project topic memory under `~/.pi/agent/memory/`, index injected each session |
| checkpoint | /checkpoint, /rewind | — | Content-addressed snapshots of every file mutation (including risky bash), restore by label or time |
| compaction | /handoff, /shake | — | Supersede-style context compaction, oversized-entry dropping, handoff briefs to `.pi/handoff.md` |
| rules | /rules | — | Loads pi/Claude/Cursor/Copilot/Windsurf/Cline rule files under char budgets and injects them |
| statusline | /statusline | — | Footer with model, mode, role, git, context %, usage, todos, cwd, clock segments |
| usage | /usage, /stats | — | Token/cost accounting per turn, session report, and multi-day stats |
| mcp | /mcp (+ dynamic `mcp:<server>:<prompt>`) | dynamic `mcp<server><tool>` | JSON-RPC MCP client: stdio and Streamable HTTP servers, tool/prompt discovery, auth, restarts; servers are lazy by default — tools register from a cached tool list (`~/.pi/agent/mcp/`), the server starts on first call and stops after `idleMs` idle (opt out per server with `"lazy": false`; first-ever run starts once to discover) |
| artifacts | — | artifact | Spills oversized tool output to disk (head/tail kept inline) and retrieves it on demand |
| comments | /comments | — | Blocks or warns on AI-slop comments (narration, filler docstrings, change markers) at write/edit time |
| hashline | /hashline | read, edit (overrides) | Line-anchor hashes in read output; edits address anchors instead of fragile string matches |
| ask | — | ask | Structured multiple-choice questions to the user with optional free-text and timeout |
| keywords | /keywords | — | Thinking-level trigger words (ultrathink, quickthink, ...), orchestrate/ultrawork modes |
| worktrees | /worktree | — | Git worktree lifecycle under `.worktrees/` with branch prefixes and include-file copying |
| shell | /jobs, /sandbox | bash (override), jobs | Commands run under bash explicitly (not the user's `$SHELL`); supported commands (git, cargo, npm, pytest, docker, …) are routed through `rtk` (Rust Token Killer) to compact output when it is on PATH, falling back to plain bash otherwise. Auto-backgrounding after 30s, job control, output caps, optional sandbox |
| web | — | websearch, webfetch | search plus page fetch via Parallel's Search MCP server (search.parallel.ai, free, no API key) with caching, size limits, and a direct-fetch fallback |
| ide | /ide | idediagnostics | Claude Code-compatible VS Code bridge: discovers the Claude Code extension's lock files (`~/.claude/ide`), connects to its WebSocket MCP server, injects the live editor selection as context each turn, pastes IDE at-mentions into the input, opens native diff tabs after every edit/write, gates edit/write approvals through an editable Accept/Reject diff when `permissions.ideDiff` is on, and serves language diagnostics to the model without a build |
| astgrep | — | astsearch, astrewrite | ast-grep structural search and staged, preview-first structural rewrites |
| sessions | /search, /btw | history | Search and read past session transcripts; `/btw` asks a side question with session context |
| styles | /style | — | Output styles appended to the system prompt, user-defined styles in `~/.pi/agent/styles` |
| router | /role, /profile, /effort | — | Named model roles and profiles, failure-driven fallback chains, and a reasoning-effort dial (off→xhigh plus a `max` tier that forces token-budget providers to `maxBudgetTokens`) |

## Credits

pi-config is a porting effort. Lineage is approximate — many of these features now exist in several tools — but the primary inspirations are:

| Feature | Inspired by |
| --- | --- |
| Skills format and catalog, plan mode, hooks, checkpoints//rewind, todo tool, subagents/task, auto-memory, output styles, statusline, /usage, ask tool, background bash jobs, worktrees, websearch/webfetch, thinking keywords (ultrathink), VS Code IDE bridge | Claude Code |
| Sandboxed shell, approval-mode influence on permissions, compaction behavior | Codex |
| Hashline read/edit anchors, AST-grep tools, session search/history, multi-format rules loading, artifact spill/retrieval, /shake | oh-my-pi |
| Goals and judge-checked loops, ultrawork/orchestrate keywords, comment policing, model router (roles/profiles/fallback), advisor/oracle second opinions, handoff briefs | oh-my-openagent |

## License

MIT
