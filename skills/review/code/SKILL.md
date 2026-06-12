---
name: code
description: "Effort-tiered code review of a diff, branch, or PR with P0-P3 findings, file:line references, and a ship verdict. Use to review code before merging or vet pending work."
disable-model-invocation: true
---

# Code Review

Review pending changes at a caller-chosen effort tier and produce a ranked, verdict-bearing report. The tier controls breadth and confidence threshold, not thoroughness per finding: every reported finding must be verified against the actual code, never inferred from the diff alone.

## Workflow

1. Resolve the target and tier. Accept an explicit ref, PR number, or "staged"; if ambiguous, use the ask tool to confirm, otherwise infer: dirty working tree means review `git diff HEAD`, clean tree on a feature branch means review the branch against its merge base. Default tier is medium.

2. Collect the diff and its shape:

   ```bash
   git fetch origin --quiet
   base=$(git merge-base origin/main HEAD)
   git diff --stat "$base"...HEAD
   git diff -M -C "$base"...HEAD
   git log --oneline "$base"..HEAD
   ```

   Use `git diff --cached` for staged-only review. Skip lockfiles, snapshots, and generated files (check for `@generated` markers and paths like `dist/`, `*.lock`, `*_pb2.py`) but note if generated output changed without a source change.

3. Map tier to scope and confidence bar:
   - low: changed lines only; report findings you would bet on; cap at roughly 5.
   - medium: changed files plus their direct callers; high-confidence findings only.
   - high: also review tests, configs, and migrations touched; include likely-but-unverified findings labeled "uncertain".
   - max: additionally trace data flow across module boundaries and check for missing changes (callers not updated, docs/tests lagging the code).

4. Fan out if the task tool exists: spawn one reviewer agent each for correctness, security, performance, and test coverage, giving each the diff, the tier, and only its dimension. Merge results, dedupe by file:line, map security severities onto the P-scale (Critical→P0, High→P1, Medium→P2, Low→P3), and re-rank yourself — sub-agents inflate severity. Fallback without task: do sequential passes over the diff yourself, one dimension at a time at high/max, a single combined pass at low/medium.

5. Verify each candidate finding before it goes in the report. Read the surrounding code with read, locate callers with `grep -rn "functionName(" src/` (or astsearch for structural queries like call sites of an overloaded name), confirm the bad path is reachable, and check whether an existing test already pins the behavior. Drop anything you cannot substantiate at low/medium; mark it "uncertain" at high/max.

6. Rank and write the report:
   - P0: data loss, security hole, or guaranteed crash on a mainline path — blocks merge.
   - P1: real bug on an edge case, race, or wrong result that users will hit.
   - P2: risky pattern, missing error handling, or untested critical branch.
   - P3: style, naming, dead code — listed in a separate "Style" section, never mixed with bugs.

   Every finding gets `path/to/file.py:123`, a one-line claim, evidence (what you read that proves it), and a suggested fix. On very long reports, lead with the verdict and the P0/P1 findings.

7. End with a verdict: "ship", "ship after fixing P0/P1 items", or "no-ship" with the one or two findings that drive it. Never end without a verdict.

## Edge cases

- Huge diffs (over ~2000 lines): review file-by-file ordered by `--stat` churn, and say which files got reduced attention. Track per-file progress with the todo tool if available.
- Merge commits in range: use the three-dot diff above so you only review the branch's own work.
- Renames: rely on `-M -C`; a "new file" that is 95% identical to a deleted one is a move, review only the delta.
- No upstream remote or detached HEAD: diff against the merge base with a local `main`/`master` if one exists; only with no usable base fall back to `git diff HEAD~1` and state that only the last commit was reviewed.
- Unfamiliar framework idioms: check with websearch/webfetch before flagging them as bugs; without web tools, downgrade to "uncertain" rather than asserting.
- Behavior questions you cannot settle by reading: run the code (`python -c`, `node -e`, or the test suite) instead of guessing.

## Done criteria

- [ ] Diff collected with the correct base; generated files excluded and noted.
- [ ] Tier stated at the top of the report along with what was in and out of scope.
- [ ] Every finding has a P-rank, file:line, evidence, and a suggested fix.
- [ ] Correctness findings and style nits are in separate sections.
- [ ] No finding was reported without reading the surrounding source.
- [ ] Report ends with an explicit ship / ship-with-fixes / no-ship verdict.
