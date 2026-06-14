---
name: deslop
description: "Removes AI slop — narrating comments, restating docstrings, single-use helpers, error-swallowing try/catch, inconsistent naming — with behavior unchanged. Use after merging AI-written code."
disable-model-invocation: true
---

# deslop

Strip the telltale residue of AI code generation from a diff or codebase. Every edit must preserve success-path behavior; error-path changes are allowed only under the swallowed-errors rule in step 3, and each one is flagged in the report. The deliverable is cleaner code plus a report listing each slop category with counts and locations.

## Workflow

1. Establish scope. Default to the current branch diff; fall back to a directory scan when no VCS context exists.

  ```bash
  git diff --name-only main...HEAD -- '*.ts' '*.tsx' '*.py' '*.go' '*.rs' '*.js'
  git rev-parse --git-dir 2>/dev/null || find . -name '*.py' -not -path '*/node_modules/*' -not -path '*/.venv/*'
  ```

  Exclude vendored, generated, and lock files (`dist/`, `*_pb2.py`, `*.lock`, `*.min.js`). If the `todo` tool is available, create one item per category below so nothing is skipped; otherwise track categories in a scratch list.

2. Capture a behavior baseline before editing. Find the project's test command (`package.json` scripts, `Makefile`, `pyproject.toml`) and record the result:

  ```bash
  npm test 2>&1 | tail -5
  ```

  If no tests exist, snapshot observable output of the touched entry points (CLI run, build artifact hash) so you can diff it afterwards.

3. Hunt each category in order, fixing as you go.

  Narrating comments — comments that describe the next line instead of explaining why:

  ```bash
  grep -rnE '^\s*(//|#)\s*(Now |First,|Next,|Then |Finally|Loop (over|through)|Check if|Initialize|Create (a|the)|Get the|Set the|Call the|Return the|Define|Import)' src/
  ```

  Delete them. Keep any comment that encodes intent, a workaround, a spec reference, or a non-obvious constraint — when unsure whether a comment is narration or rationale, keep it or use the `ask` tool to confirm with the user.

  Restating docstrings — docstrings/JSDoc whose content is only the signature in prose ("Gets the user by id. @param id the id. @returns the user"). Review every docstring in scope (`git diff main...HEAD | grep -B2 -A4 '"""'`). Delete pure restatements; keep docstrings on public API that document units, errors raised, or invariants.

  Single-use helpers — for each function or class added in the diff, count call sites:

  ```bash
  grep -rnw 'buildUserDisplayName' src/ tests/ | grep -vE '(def |function |const |func |fn |import |from )' | wc -l
  ```

  If exactly one caller, the helper is private, and inlining does not duplicate logic or cross a layer boundary, inline it. Prefer the `astsearch` tool to find definitions and call sites structurally; grep with `-w` is the fallback. Do not inline helpers that exist for testability, are exported, or are referenced by string (reflection, DI containers, route tables) — check with `grep -rn '"helperName"\|'\''helperName'\'''`.

  Swallowed errors — try/catch or try/except that hides failures:

  ```bash
  grep -rnE 'catch\s*\([a-zA-Z_]*\)\s*\{\s*\}' src/
  grep -rn -A1 'except Exception' src/ | grep -E '(pass|continue|return None)$'
  ```

  Remove the wrapper and let the error propagate, unless the call site genuinely cannot fail upward (top-level loop, fire-and-forget telemetry). A catch that logs and rethrows is fine; a catch that logs and continues is slop unless a comment justifies it. When removal changes control flow on the error path, that is allowed — the contract is identical behavior on the success path and honest failure on the error path; flag each such case in the report.

  Inconsistent naming — generator-introduced style drift relative to the surrounding file:

  ```bash
  grep -rnE 'def [a-z]+[A-Z]' src/        # camelCase defs in a snake_case Python codebase
  grep -rnE 'const [a-z]+_[a-z]+ =' src/  # snake_case consts in a camelCase TS codebase
  ```

  Rename only file-private symbols to match local convention, using `astrewrite` for the mechanical rewrite where available, else `grep -rlw old | xargs sed -i 's/\bold\b/new/g'` followed by a manual review of each hit. Never rename exported/public symbols without asking.

4. Re-verify. Re-run the exact baseline command from step 2 and confirm identical results — any difference must trace to a flagged error-path change. Read the final `git diff` end to end: every hunk must be a deletion, an inline, a rename, or a flagged error-path change — no other logic edits.

5. Report. End with a table: category, count removed, count intentionally kept (with one-line reasons), representative file:line examples. State explicitly that the test baseline matched.

## Edge cases

- Mixed slop and real bugs: if you find a genuine bug while deslopping, do not fix it here — record it in the report and leave behavior intact.
- No tests and no runnable entry point: restrict yourself to comment/docstring deletion and report that helpers and catch blocks were identified but left untouched.
- Linters/formatters: run the project formatter on just the files you edited (`npx prettier -w <files>`, `ruff format <files>`) so the diff is not polluted with style noise from untouched files.

## Done criteria

- [ ] Baseline test or output check passes identically after edits; any difference traces to a flagged error-path change
- [ ] Every hunk in the final diff maps to one of the five categories
- [ ] No exported or string-referenced symbol was renamed or inlined without confirmation
- [ ] Vendored and generated files untouched
- [ ] Per-category report delivered with counts, locations, and kept-on-purpose items
