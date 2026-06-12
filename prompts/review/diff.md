---
description: Review the current diff for bugs and cleanups at a given effort level
argument-hint: "[low|medium|high|max]"
---

Review the current diff at effort level ${1:-medium}, following the conventions of the code review skill — invoke /skill:code with that effort level and apply its workflow.

Scope: the working-tree diff (`git diff` plus `git diff --cached`); if both are empty, review the latest commit via `git show HEAD` and state that this is what you reviewed. Read enough surrounding code in each touched file to judge the change in context — never review hunks in isolation.

Calibrate by effort: at low and medium, report only high-confidence, high-impact findings — real correctness bugs, broken edge cases, regressions. At high and max, widen to reuse, simplification, and efficiency cleanups, and you may include uncertain findings clearly flagged as uncertain. For every finding give file:line, a one-line problem statement, a severity, and a concrete suggested fix; distinguish bugs from style. Do not pad with nitpicks to seem thorough — an empty findings list is a valid result.

Do not modify any files. End with a short verdict on whether the diff is safe to commit as-is.
