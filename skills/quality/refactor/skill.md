---
name: refactor
description: "Behavior-preserving refactoring in small reversible steps, with tests characterizing behavior first and the build kept green. Use to restructure, decompose, or modernize working code."
disable-model-invocation: true
---

# refactor

Restructure code without changing what it does. The discipline: prove current behavior first, transform in atomic steps that each leave the build green and are individually revertible, and keep behavior changes strictly out of band.

## Workflow

1. Scope and motivation. State the target (file, module, class) and why it needs reshaping. If the request is vague ("clean this up"), use the `ask` tool to pin down the goal — extract for reuse, reduce coupling, prepare for a feature — since the goal determines which transformations are worth doing. Track the planned steps with the `todo` tool, or a numbered list if it is unavailable. For a large or risky plan, run it past the `advisor` tool before starting.

2. Characterize current behavior. Find what already covers the target:

  ```bash
  grep -rln 'OrderProcessor' tests/ spec/ __tests__/ 2>/dev/null
  npx vitest run --coverage src/orders/ 2>&1 | tail -10
  ```

  If coverage on the code you will touch is thin, write characterization tests first: feed representative inputs, assert on the actual current output — including outputs that look wrong. You are pinning behavior, not judging it. For code with no test harness, build a golden master:

  ```bash
  node src/cli.js --input fixtures/sample.json > /tmp/golden.txt 2>&1
  ```

  and re-diff against it after every step. Commit the characterization tests separately before any refactoring commit.

3. Record the green baseline. Run the full relevant test suite and the build; note the exact commands. Run flaky-looking suites twice so you know what "green" means. Ensure a clean working tree (`git status`); if the user has uncommitted work, ask before proceeding — every step relies on cheap revert.

4. Execute one atomic step at a time. Each step is a single named mechanical transformation:

  - rename symbol/file
  - extract function/method/module
  - inline function/variable
  - move declaration between files
  - replace conditional with polymorphism, introduce parameter object, etc.

  For renames and signature changes, prefer the `astrewrite` tool (structural find/replace) or `astsearch` to enumerate call sites; the fallback is word-boundary grep plus manual edits:

  ```bash
  grep -rnw 'fetchUserData' src/ tests/
  ```

  In dynamic languages also sweep string references — routes, mocks, `getattr`, config keys:

  ```bash
  grep -rn '"fetchUserData"\|'\''fetchUserData'\''' src/ tests/ config/
  ```

  After each step, run build plus tests, then commit with the step name:

  ```bash
  npm run build && npm test && git add -A && git commit -m "refactor: extract parseHeaders from handleRequest"
  ```

5. Recover from red. If a step breaks the build or tests, do not debug forward on top of it. Revert the step and retry smaller:

  ```bash
  git reset --hard HEAD
  ```

  A step that cannot be made green in two attempts is too big — split it (e.g., extract first with the old name, rename in a second step) or reorder the plan.

6. Quarantine behavior changes. If a step would require changing behavior (a bug surfaces, an API must change shape, dead code turns out to be live), stop that step. Record the finding, finish the refactor around it, and report it for a separate change. The one sanctioned exception: deleting provably dead code, verified by `grep -rnw` across the whole repo (including dynamic/string references) returning only the definition.

7. Summarize. Finish with a table mapping each commit/step to its motivation:

  ```text
  step                                        motivation
  rename OrderMgr -> OrderProcessor           name said nothing; matches domain term
  extract validateLineItems (3 call sites)    duplicated 18-line block
  move currency.ts into lib/money/            breaks orders -> ui import cycle
  ```

  Include the test command and final green result, plus any quarantined behavior findings; `git log --oneline main..HEAD` reconstructs the step order.

## Edge cases

- Public/exported API: keep a deprecated alias (`export const fetchUserData = loadUserData`) instead of renaming consumers you cannot see; note it in the summary.
- Formatter churn: run the project formatter inside each step's commit so later diffs stay readable.
- Cross-file moves breaking imports: move one file per step and let the compiler/test run enumerate broken importers; fix all of them within that same step.
- No commit rights or dirty tree the user will not clean: record checkpoints without touching the tree via `git stash store $(git stash create) -m 'step N'`, and explicitly warn that revert granularity is reduced.

## Done criteria

- [ ] Characterization tests or golden master existed and passed before the first transformation
- [ ] Every step is one transformation, individually committed, build and tests green after each
- [ ] Zero behavior changes in the net diff; discovered bugs reported, not fixed in-band
- [ ] All call sites updated, including string-based references, or a deprecated alias left in place
- [ ] Final summary maps every step to a motivation and shows the closing green test run
