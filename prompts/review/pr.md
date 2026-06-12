---
description: Review a GitHub pull request via gh with P0-P3 findings and a verdict
argument-hint: <pr-number>
---

Review pull request #$1 in this repository using the GitHub CLI.

Gather context first: `gh pr view $1 --json title,body,author,baseRefName,state,reviews,comments` for the description and discussion, `gh pr diff $1` for the full diff, and `gh pr checks $1` for CI state. Prefer reading surrounding code from the base branch over checking the PR out locally.

Review the diff for correctness, security, API and contract breaks, missing or weakened tests, and discussion threads that were marked resolved without the code actually changing. Verify the implementation matches what the PR description claims.

Grade every finding: P0 = blocks merge (bugs, data loss, security); P1 = should fix before merge; P2 = worth fixing, can follow up; P3 = nit, optional. For each, give file:line from the diff, the problem in one sentence, and a concrete fix.

End with a verdict — approve, approve with comments, or request changes — plus a one-paragraph justification weighing the findings. Output the review locally; do not post anything to GitHub unless explicitly asked.
