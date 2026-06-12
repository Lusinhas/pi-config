# pi-config — agent operating guide

This environment runs the pi-config suite. Prefer its tools and skills over ad-hoc bash; they are faster, safer, and tracked.

## Tools — when to reach for what

- **task** — delegate scoped work to a subagent. Agents: `explorer`/`librarian` (repo/web research), `architect`/`critic` (plan and plan-review), `coder`/`tester` (implement and test), `reviewer`/`security` (review), `oracle` (judgment calls). Fan out parallel tasks for independent units; give each exact files and acceptance criteria. When the user asks for large-scale orchestration, the **workflow** tool runs a deterministic JavaScript script that fans out many subagents via agent()/parallel()/pipeline() and returns only its final value.
- **advisor** — read-only second opinion from a high-reasoning model. Use when stuck, going in circles, or weighing an expensive tradeoff. Pass the full context gathered so far.
- **todo** — any work with 3+ steps: write the list first, keep exactly one item in_progress, mark items done as they finish — never batch-complete at the end.
- **ask** — when a real decision belongs to the user, present 2-8 concrete options instead of guessing.
- **websearch / webfetch** — anything depending on current or external information: library APIs, versions, error messages, docs. Do not answer such questions from memory.
- **astsearch / astrewrite** — structural code search and rewrite with `$METAVAR` patterns. Prefer over grep/sed for code-shaped queries and mechanical multi-file changes.
- **idediagnostics** — language diagnostics straight from the connected VS Code window (requires /ide). When connected, check it after edits instead of running a build to see type errors.
- **history** — search and read past sessions ("what did we decide about X", earlier approaches, prior fixes).
- **artifact** — when tool output notes it was truncated and spilled, retrieve the named artifact instead of re-running the command.
- **jobs** — long bash commands auto-background after ~30s; use jobs to wait on, poll, or kill them. Do not re-run a command that is still running.
- **memory** — durable cross-session project facts. The topic index is injected at session start; read a topic before re-deriving it, write one when you learn something durable.
- **read / edit** — hashline variants: read prints `anchor lineno: text`; edit addresses lines by anchor. Always edit with anchors from your most recent read of the file.
- **bash** — everything else. Prefer the dedicated tools above for search, fetch, and structural edits.

## Skills — workflow playbooks (`/skill:<name>`)

- git: `commit` (atomic commits), `rebase` (history surgery), `pr` (open/update/respond), `conflicts` (semantic resolution)
- review: `code` (effort-tiered, P0-P3 + verdict), `security` (vulnerability audit), `simplify` (reuse/dedup pass)
- testing: `unit`, `integration`, `coverage`
- research: `codebase` (repo recon before changes), `deep` (cited multi-source web research)
- context: `init` (root AGENTS.md), `deepinit` (per-directory AGENTS.md for monorepos)
- workflows: `debug` (reproduce → bisect → root cause), `verify` (run the app, observe), `batch` (many-file mechanical changes), `ci` (drive CI green), `release` (semver + changelog + tag)
- quality: `deslop` (strip AI slop), `refactor` (behavior-preserving restructuring)
- planning: `spec` (interview → explore → draft → critique → approve)
- frontend: `design` (UI audit and polish), `browser` (Playwright visual verification)

Use the matching skill instead of improvising its workflow. Chain them: spec → coder/tester → code review → commit → pr.

## Conventions

- **Plan mode**: when active, only read-only tools work. Explore, then end with a numbered plan under a "Plan" heading and stop. Never work around blocked tools.
- **Todos**: keep the list current; the suite surfaces open todos and may enforce completion before stopping.
- **Goals/loops**: when a goal is armed, a judge checks the transcript. Emit `<goal-met/>` only when the condition is genuinely, verifiably satisfied — it ends the loop.
- **Comments**: the comments extension blocks narrating/filler comments on write/edit. Write self-explanatory code; comment only non-obvious *why*, never *what*.
- **Edits**: hashline anchors go stale once the file changes — re-read before further edits to the same region.
- **Checkpoints**: file mutations are checkpointed automatically and `/rewind` exists; still prefer minimal, reviewable diffs.
- **Permissions**: a denied tool call is a user decision — adapt your approach rather than retrying the same call.
- **Output**: oversized tool output is spilled to artifacts; do not paste huge logs into the conversation.
- **Done means verified**: build/tests/lint actually ran and passed. When tests are insufficient proof, use the verify skill and observe the behavior.
