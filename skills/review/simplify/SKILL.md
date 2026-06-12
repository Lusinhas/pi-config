---
name: simplify
description: "Reuse and simplification pass that edits changed code in place: dedupe against existing utilities, collapse abstractions, reduce branching. Quality-only, no bug hunting. Use to simplify or clean up recent changes."
disable-model-invocation: true
---

# Simplify

Make the changed code smaller and more idiomatic without changing what it does. The two failure modes to avoid are silent behavior drift and over-abstraction in the other direction (merging code that merely looks similar). Behavior preservation is verified by running tests around every edit, not assumed.

## Workflow

1. Scope to the change set — never refactor untouched code:

   ```bash
   base=$(git merge-base origin/main HEAD)
   git diff --name-only "$base"...HEAD
   git diff "$base"...HEAD
   ```

   If the working tree is dirty, scope to `git diff HEAD` (plus `git diff --cached` for staged-only work) instead of the branch diff, and say so — freshly written, uncommitted code is the most common target. With the todo tool available, create one item per changed file so partial progress survives interruption.

2. Reuse pass. For every new helper, validator, formatter, or retry loop in the diff, search for an existing equivalent before accepting it. Look in `utils/`, `lib/`, `common/`, `helpers/`, and shared packages first:

   ```bash
   grep -rn "def slugify" --include="*.py" src/
   grep -rni "retry" --include="*.ts" src/lib/ src/utils/
   ```

   Use astsearch for structural duplicates that grep misses, such as two functions with the same shape but different names. When a duplicate exists, replace the new copy with a call to the old one — never the reverse, since the established utility has callers and battle scars.

3. Stdlib pass. Replace hand-rolled implementations with standard equivalents where behavior is provably identical: manual dedupe with `dict.fromkeys` or a set, string path surgery with `pathlib`, manual deep-copies with `copy.deepcopy`, custom argument parsing with the project's existing CLI framework, ad-hoc temp file naming with `tempfile`. In JS/TS prefer `Object.entries`, `Array.prototype.at`, `structuredClone`, and `URL` over regex parsing.

4. Structure pass.
   - Collapse single-use abstractions: a class with one method and no state becomes a function; a wrapper that only forwards arguments gets inlined.
   - Reduce branching: convert arrow-shaped nesting to early returns; replace if/elif chains keyed on a value with a dict dispatch or match statement.
   - Delete dead parameters, unused returns, and commented-out code introduced by the diff.

   Use astrewrite for mechanical multi-site transforms (renaming a call across files, swapping an API); fall back to edit per site when it is unavailable.

5. Verify each change, one at a time. Before editing, run the narrowest relevant tests; re-run after:

   ```bash
   pytest tests/test_orders.py -x -q
   npx vitest run src/orders --reporter=dot
   ```

   If no test covers the code, write a quick characterization check (`python -c` invoking old and new paths on a few inputs) or downgrade the edit to a written suggestion instead of applying it. Commit nothing; leave changes in the working tree for the user.

6. Report. For every applied change emit a before/after pair: file:line, the original snippet, the replacement, and one line on why it is equivalent. List skipped opportunities separately with the reason (no test coverage, behavior difference found, public API).

## Decision points

- Rule of three: two similar blocks that change for different reasons stay separate; deduplicate only on genuinely shared meaning.
- Never alter public or exported signatures, serialized formats, log lines that look machine-parsed, or error message text asserted in tests.
- An abstraction the author just added stays if it has three or more call sites or is clearly an extension point; otherwise inline it.
- Performance-sensitive loops: keep the "uglier" version if the simplification adds allocations in hot paths; note it instead.
- When unsure whether two branches are truly equivalent, ask the advisor tool if available, or run both paths on boundary inputs; never guess.

## Edge cases

- "Duplicates" that differ in error handling, logging, or rounding are not duplicates — diff them token by token before merging.
- Generated files, vendored code, and migration scripts are out of scope even when changed.
- If the test suite is already red on the base commit, record the pre-existing failures first (`pytest -q 2>&1 | tail -20`) so they are not attributed to your edits.
- If history shows the user just refactored in the opposite direction (`git log --oneline -5`), surface that with the history tool or git log before undoing their intent.

## Done criteria

- [ ] Only files in the diff were modified.
- [ ] Relevant tests pass after every applied change; pre-existing failures documented.
- [ ] Every applied change reported as a before/after pair with an equivalence rationale.
- [ ] Skipped opportunities listed with reasons.
- [ ] No public signatures, wire formats, or asserted messages changed.
- [ ] Net result is less code or strictly simpler code; nothing was committed.
