---
name: conflicts
description: "Resolves merge, rebase, and cherry-pick conflicts by reconstructing the intent of both sides, then verifies. Use when a git operation stops on conflicts."
disable-model-invocation: true
---

# Conflict resolution

A conflict marker shows where two patches collided, not what either author meant. The job is to recover both intents and produce code that satisfies both — a semantic merge — and to abort rather than guess when the intents genuinely contradict. Textually picking "ours" or "theirs" is the last resort, used only when one side is provably obsolete.

## Workflow

1. Identify the operation and orientation first:

  ```sh
  ls .git/MERGE_HEAD .git/REBASE_HEAD .git/CHERRY_PICK_HEAD 2>/dev/null
  git status
  ```

  Critical: during `merge`, "ours" is your branch; during `rebase`, sides swap — "ours" is the branch you are rebasing onto, "theirs" is your own commit being replayed. Getting this backwards silently destroys your own work.

2. Enumerate conflicts and improve marker quality before reading any:

  ```sh
  git diff --name-only --diff-filter=U
  git config merge.conflictStyle zdiff3   # show the common-ancestor lines in markers
  git checkout --merge -- src/app.py     # re-materialize markers in zdiff3 for already-touched files
  ```

  `git status --porcelain` codes matter: `UU` both modified, `DU`/`UD` delete-vs-modify, `AA` both added — each needs a different strategy (below).

3. Reconstruct intent per file. For each side, find the commits that touched the conflicted region and read why:

  ```sh
  git log --merge --oneline -- src/app.py        # only commits on both sides touching this file
  git log -p MERGE_HEAD -3 -- src/app.py         # what theirs was doing (use REBASE_HEAD when rebasing)
  git show :1:src/app.py > /tmp/base.py          # stage 1 = common ancestor
  git show :2:src/app.py > /tmp/ours.py          # stage 2 = ours
  git show :3:src/app.py > /tmp/theirs.py        # stage 3 = theirs
  diff /tmp/base.py /tmp/ours.py                 # exactly what we changed
  diff /tmp/base.py /tmp/theirs.py               # exactly what they changed
  ```

  The two base-diffs are the actual question: change A and change B both applied to base. Commit messages from `git log --merge` state the intent; `git blame` the surrounding lines when a hunk's purpose is still unclear.

4. Resolve semantically. Common patterns:
  - One side renamed a symbol, the other added a use of the old name: apply the rename to the new use. Find every affected site with the `astsearch` tool if available; fall back to `grep -rn 'old_name' --include='*.py'`. Mechanical renames across many files go faster with `astrewrite` when present; otherwise scripted `grep` + `edit`.
  - Both sides added items to the same list/registry/import block: keep both, in the file's existing ordering convention.
  - One side refactored a function the other side bug-fixed: re-apply the fix inside the refactored shape, not the old one.
  - Both sides changed the same constant/logic differently: this is a true intent contradiction — step 6.

5. Verify before declaring victory. Remove every marker, stage, and run the cheapest meaningful check:

  ```sh
  grep -rn '^<<<<<<<\|^>>>>>>>' --include='*' . && echo MARKERS-REMAIN
  git add src/app.py
  npm run build && npm test    # or the repo's equivalent; at minimum compile/typecheck
  git merge --continue          # or: git rebase --continue / git cherry-pick --continue
  ```

  A merge that compiles but merges two half-features is still wrong — re-read your resolution against both base-diffs from step 3. If the `task` tool is available and tests are slow, run them as a background task while resolving the next file.

6. When intent is ambiguous or contradictory, do not guess. Abort cleanly and ask:

  ```sh
  git merge --abort      # or: git rebase --abort / git cherry-pick --abort
  ```

  Use the `ask` tool with a concrete question ("ours caps retries at 3, theirs makes them unlimited — which behavior wins?") including both base-diffs. Without `ask`, stop after aborting and put the same question, with the evidence, in your reply. An aborted merge costs minutes; a guessed one costs a production incident. One caution: mid-rebase with earlier commits already resolved, `git rebase --abort` discards those resolutions too (unless rerere was on) — prefer staying paused on the conflict and asking before aborting.

## Edge cases

- Delete vs modify (`DU`/`UD`): find why it was deleted (`git log --diff-filter=D --oneline -- path`). If deleted because moved, apply the modification at the new location; if truly removed, the modification may belong elsewhere or nowhere — ask if unclear.
- Lockfiles (`package-lock.json`, `Cargo.lock`, `poetry.lock`): never hand-merge the lockfile. Resolve the manifest (`package.json`) semantically — usually keep both sides' dependency changes, per step 4 — then regenerate: `rm package-lock.json && npm install`, stage both.
- Binary files: no textual merge exists — `git checkout --ours -- logo.png` or `--theirs`, chosen by intent, and say which you picked and why.
- Generated files: resolve the source, regenerate, stage both.
- Dozens of identical trivial conflicts across a long rebase: enable `git config rerere.enabled true` before continuing so each resolution is recorded once.

## Done criteria

- [ ] Operation type identified and ours/theirs orientation stated correctly
- [ ] Every conflicted file resolved from both base-diffs, not by side-picking — or the pick justified
- [ ] No conflict markers remain anywhere in the tree (grep-verified)
- [ ] Build/tests (or at minimum a compile/typecheck) pass on the merged result
- [ ] Ambiguous intent led to a clean abort plus a specific question to the user, never a guess
