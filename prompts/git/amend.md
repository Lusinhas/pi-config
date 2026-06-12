---
description: "Safely amend or fixup staged changes into a previous commit (default: HEAD)"
argument-hint: "[target-commit]"
---

Fold the currently staged changes into ${1:-HEAD}, safely.

Verify safety first: run `git diff --cached --stat` to confirm something is staged — if nothing is, stop and say so rather than staging anything yourself. Then check whether the target commit has been pushed (`git branch -r --contains <target>`); if it exists on a shared remote branch, stop and warn that rewriting it requires a force-push and explicit confirmation.

If the target is HEAD: run `git commit --amend --no-edit`, keeping the existing message unless the staged change makes it inaccurate, in which case update it. If the target is an older commit: create a fixup with `git commit --fixup=<target>`, then ask whether to squash immediately; if yes, run `GIT_SEQUENCE_EDITOR=true git rebase --autosquash <target>~1` so no interactive editor opens — consult /skill:rebase for the workflow and /skill:conflicts if the rebase stops on conflicts.

Never use `-a` or `--all`; only what is already staged goes in. Finish by showing `git log --oneline -3` and `git status` to confirm the result.
