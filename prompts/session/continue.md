---
description: Resume work from a previous session's handoff brief
---

Resume the work from a previous session.

Read `.pi/handoff.md` first if it exists — it holds the goal, state, decisions, and next steps from last time; treat its decisions as binding unless new evidence contradicts them. If it does not exist, reconstruct context from `git log --oneline -10`, the branch name, and TODO or FIXME markers in recently modified files.

Then reconcile the brief against reality, because work may have moved since it was written: run `git status` and `git diff --stat` and compare with the brief's State section. Where the working tree shows progress beyond the brief, the tree wins — update your understanding before acting. Verify the baseline before continuing: does the project build, and do any tests the brief mentions still pass?

Continue from the first unfinished item in Next steps. Do not redo completed work, do not relitigate recorded decisions without new information, and do not start refactors outside the plan. If the brief is too stale to reconcile, say so and propose an updated plan before proceeding. As steps complete, keep `.pi/handoff.md` current.
