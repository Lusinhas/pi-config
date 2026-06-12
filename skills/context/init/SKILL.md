---
name: init
description: "Generates or refreshes the root AGENTS.md with verified build/test/lint commands and observed conventions. Use when AGENTS.md is missing, stale, or the codebase is unfamiliar."
disable-model-invocation: true
---

Produce a short, high-signal AGENTS.md at the repo root that tells a coding agent what it cannot infer in five seconds: the exact commands that work, the architecture that is not obvious from the directory names, and the conventions the code actually follows. Document what is, not what should be. A 40-line file the agent trusts beats a 300-line wishlist it ignores.

## Workflow

1. Establish scope. Run `git rev-parse --show-toplevel` to find the root; if not a git repo, use the cwd. Inventory the surface before reading anything deeply:

```bash
  ls
  find . -maxdepth 2 -name "package.json" -o -name "pyproject.toml" -o -name "Cargo.toml" \
    -o -name "go.mod" -o -name "Makefile" -o -name "justfile" -o -name "*.csproj" \
    | grep -v node_modules
  ls .github/workflows/ 2>/dev/null
```

2. Harvest commands from manifests, in priority order: task runner (Makefile, justfile, `Taskfile.yml`) first, then language manifest scripts (`jq .scripts package.json`, `[tool.*]` sections of pyproject.toml, `cargo metadata`), then CI. CI is the ground truth for what the project considers passing — read `.github/workflows/*.yml` and copy the actual run steps, not your guess at them. Note the package manager from lockfiles: `pnpm-lock.yaml` means pnpm, `uv.lock` means uv; never write `npm install` into a pnpm repo.

3. Merge prior art. Check for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`, and `CONTRIBUTING.md`. Keep their project-specific rules (port numbers, "never touch X", commit conventions), drop generic advice ("write clean code"), and flag anything contradicting the code as observed. If `CLAUDE.md` exists and is current practice, fold it in and note the overlap to the user rather than silently duplicating.

4. Observe, do not aspire. Sample 3 to 5 representative source files plus the test directory. Record only conventions with evidence: test framework and file naming actually present, error-handling pattern used in most files, import style, formatter config that exists (`.prettierrc`, `ruff` section). If the suite's `astsearch` tool is available, use it to confirm a pattern is dominant rather than incidental; otherwise `grep -rc` a signature pattern across the source tree and compare counts.

5. Verify every command. This is non-negotiable: run each command you intend to list. For slow ones, verify cheaply — `pnpm test -- --listTests` or a single-file run, `cargo check` instead of full `cargo build`, `make -n target` to confirm a target exists. A command that fails gets fixed or cut; never ship "should work". Use the suite's `todo` tool to track the verification list if there are many; a scratch checklist in your reply works as the fallback.

6. Write the file with `write` (or `edit` when refreshing). Target 30 to 80 lines:

```markdown
  # AGENTS.md
  ## Commands
  - Build: `pnpm build`
  - Test: `pnpm test` (single file: `pnpm vitest run src/foo.test.ts`)
  - Lint/format: `pnpm lint && pnpm format:check`
  ## Architecture
  Two to six sentences on the non-obvious structure and data flow.
  ## Conventions
  Only observed, enforceable rules. One line each.
```

7. Confirm with the user before overwriting a hand-maintained AGENTS.md; if the suite's `ask` tool is available use it, otherwise state the diff summary and proceed only on approval.

## Edge cases

- Monorepo: document root-level orchestration (`turbo run test`, workspace filters) and point to per-package docs; do not inline every package. Suggest the `deepinit` skill for directory-scoped files.
- No manifests at all: say so in the file ("no build system detected; plain scripts in `bin/`") rather than inventing commands.
- Commands needing services (DB, docker): list them with the prerequisite stated inline, verified as far as possible (`docker compose config` parses, binary exists on PATH).
- Dirty working tree: never run commands that mutate state (`migrate`, `db:reset`) during verification.
- Existing file over ~150 lines: treat the refresh as a cut. Preserve verified facts, delete duplicated tool output, and report what was removed.

## Done criteria

- [ ] AGENTS.md exists at repo root, roughly 30 to 80 lines
- [ ] Every listed command was executed (or cheaply verified) in this session and its exit status checked
- [ ] Package manager and runner match the lockfiles and CI, not defaults
- [ ] Prior AGENTS.md / CLAUDE.md / .cursorrules content merged or consciously dropped, with drops reported
- [ ] Conventions section contains only patterns observed in the code, each traceable to a file
- [ ] No aspirational rules, no generic advice, no command the agent has not seen succeed
