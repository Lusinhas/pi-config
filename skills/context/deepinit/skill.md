---
name: deepinit
description: "Generates directory-scoped AGENTS.md files across a repository tree. Use on monorepos or large codebases where the root file cannot carry per-package commands and conventions."
disable-model-invocation: true
---

Large repos defeat a single AGENTS.md: the root file either bloats with per-package detail or stays silent about it. This skill writes a small AGENTS.md into each significant subdirectory, scoped strictly to that directory, so an agent working in `services/billing/` picks up billing-specific commands without scrolling past frontend conventions. Pi walks AGENTS.md files up from the cwd, so nested files layer on top of the root one — never repeat global rules locally.

## Workflow

1. Ensure the root file exists first. If there is no root AGENTS.md, run the `init` skill (or its procedure) before anything else — the root file is the authority for global conventions, and every local file is written as a delta against it.

2. Decide the candidate set. Default max depth is 2 from the repo root; accept a user override. A directory is significant when it has its own manifest or clear ownership boundary:

```bash
  find . -maxdepth 2 -type d \
    \( -name node_modules -o -name .git -o -name dist -o -name build -o -name target \
       -o -name vendor -o -name .venv -o -name __pycache__ -o -name coverage \
       -o -name .next -o -name generated \) -prune -o -type d -print
  find . -maxdepth 3 -name "package.json" -not -path "*/node_modules/*"
```

  Workspace globs are the best signal: read `pnpm-workspace.yaml`, the `workspaces` field, `Cargo.toml [workspace] members`, or `go.work`. Also respect `.gitignore` — anything ignored is generated and gets no file. Skip directories with fewer than roughly five source files unless they carry a manifest.

3. Plan before writing. List the candidate directories and what each file will cover; with the suite's `todo` tool, make one item per directory, otherwise keep a plain checklist. If the candidate count exceeds ~15, confirm the list with the user (`ask` tool if available, otherwise print it and wait) — 40 stub files are worse than none.

4. For each directory, gather only local facts:
  - Local commands: scripts in the local manifest, run through the workspace runner (`pnpm --filter @app/billing test`, `cargo test -p billing`, `make -C services/billing test`). Verify each one runs, from the repo root, exactly as written.
  - Local architecture: entry points, what this package exposes, which sibling packages it depends on (`jq .dependencies package.json` filtered to workspace names).
  - Local conventions that differ from root: a different test framework, stricter lint config, a "do not edit, see codegen" warning. If the suite's `astsearch` is available, use it to confirm divergent patterns; `grep -rc` counts are the fallback.
  If the suite's `task` (subagent) tool is available, fan out one task per directory with this gathering brief and assemble the results; otherwise process directories sequentially with built-ins (`ls`, `read`, `grep`, `bash`).

5. Write each file with `write`, 10 to 30 lines, in a fixed shape: one-line purpose, local commands, local-only conventions, pointers to deeper docs. Open with a scope line such as "Scope: this directory only; root AGENTS.md governs globals." Never restate the root file's content — if a fact applies to two or more areas, move it up to the root instead.

6. Reconcile the root. Add a short "Areas" index to the root AGENTS.md (path plus one-line description per area) using `edit`, and remove any per-package detail that now lives locally.

7. Report the tree of files written, with line counts and any directories skipped and why:

```bash
  find . -name AGENTS.md -not -path "*/node_modules/*" -exec wc -l {} +
```

## Edge cases

- Existing local AGENTS.md files: merge, do not clobber. Preserve hand-written rules, refresh commands, and report each merge.
- Symlinked or git-submodule directories: skip submodules (their repos own their docs); note the skip in the report.
- A directory whose commands only work from the repo root (shared lockfile, root-level toolchain): write the command with its required cwd stated explicitly rather than a form that fails locally.
- Generated-but-committed trees (protobuf output, OpenAPI clients): write a two-line AGENTS.md saying it is generated, naming the regeneration command, and nothing else.
- Verification too slow across many packages: verify a representative package per toolchain fully, existence-check the rest (`make -n`, `jq '.scripts.test' path/package.json`) without executing them, and mark which ones got the cheap path in the report.

## Done criteria

- [ ] Root AGENTS.md exists, holds all global conventions, and gained an Areas index
- [ ] One AGENTS.md per significant directory within the depth limit; vendored, generated, and ignored dirs untouched
- [ ] Every local file is 10 to 30 lines and contains zero content duplicated from the root
- [ ] Every listed command verified (or cheaply syntax-checked, and flagged as such)
- [ ] Pre-existing local files merged with their hand-written content intact
- [ ] Final report shows the tree of files written, line counts, and skipped directories with reasons
