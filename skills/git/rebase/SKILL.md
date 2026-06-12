---
name: rebase
description: "Safe non-interactive history surgery — rebase --onto, autosquash, split, reorder — behind a backup branch, verified with range-diff. Use to rewrite local history or rebase a branch."
disable-model-invocation: true
---

# History surgery

Rewrite local history deterministically and reversibly. Interactive editors are unavailable to an agent, so every recipe here is non-interactive: `GIT_SEQUENCE_EDITOR` scripts the todo list, `--fixup` commits encode squash intent, and a backup branch plus a post-rewrite diff make every operation provable and undoable.

## Invariants (do these every time)

1. Clean tree first: `git status --porcelain` must be empty; otherwise `git stash push -u -m pre-rebase` and pop at the end.
2. Backup before any rewrite:

  ```sh
  git branch backup/feature-$(date +%Y%m%d-%H%M%S)
  old=$(git rev-parse HEAD)
  ```

3. Verify after. For pure squash/reorder/reword the tree must be byte-identical:

  ```sh
  git diff $old..HEAD          # must print nothing
  git range-diff $old...HEAD   # review what changed commit-by-commit
  ```

  If the rewrite intentionally drops or edits content, `git diff $old..HEAD` will be non-empty — then `range-diff` is the verification tool, and the only acceptable differences are the intended ones.
4. Recovery: `git rebase --abort` mid-flight; `git reset --hard backup/...` after the fact; `git reflog` if the backup was skipped. If the `history` tool is available, note the backup name there; otherwise tell the user the backup branch name explicitly.

## Recipes

Rebase onto a new base (the branch forked from `old-base`, should sit on `main`):

  ```sh
  git rebase --onto main old-base feature
  ```

Transplant only the last 3 commits onto another branch:

  ```sh
  git rebase --onto release-2.4 feature~3 feature
  ```

Autosquash — fold fixes into earlier commits without an editor. First create fixups against the targets:

  ```sh
  git commit --fixup=a1b2c3d                 # squash content into a1b2c3d
  git commit --fixup=amend:a1b2c3d           # also reword a1b2c3d
  GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash main
  ```

  `GIT_SEQUENCE_EDITOR=true` accepts git's auto-generated todo unmodified, so the "interactive" rebase runs untouched by any editor.

Reorder or drop commits by scripting the todo:

  ```sh
  GIT_SEQUENCE_EDITOR='sed -i "/typo in comment/d"' git rebase -i main   # drop a commit
  ```

  For complex reorders, write the todo with a small script: print `pick <sha>` lines in the desired order into the file `$1`. Inspect what git would generate first with `git log --reverse --format="pick %h %s" main..HEAD`.

Split a commit (here, the parent of the tip, `HEAD~1` — todo line 1):

  ```sh
  GIT_SEQUENCE_EDITOR='sed -i "1s/^pick/edit/"' git rebase -i HEAD~2
  git reset HEAD^                # commit's changes back to working tree
  git add -p ...                 # stage and commit piece by piece (see the commit skill)
  git commit -m 'first half'
  git add . && git commit -m 'second half'
  git rebase --continue
  ```

Reuse conflict resolutions across repeated rebases:

  ```sh
  git config rerere.enabled true
  git config rerere.autoUpdate true
  ```

  After resolving a conflict once, rerere replays it on the next rebase of the same commits. Check what it recorded with `git rerere status` and `git rerere diff`. If rerere replays a now-wrong resolution: `git rerere forget path/to/file` to drop the recording, `git checkout --merge -- path/to/file` to re-conflict the file, fix it, then `git add` — the corrected resolution is recorded when the rebase continues.

## Edge cases and failure handling

- Pushed branches: after rewriting, push with `git push --force-with-lease` only — never bare `--force` — and only if the user confirmed the branch is theirs to rewrite. Use the `ask` tool for that confirmation; without it, stop and ask in your reply before pushing.
- Merge commits are flattened by default; preserve them with `git rebase --rebase-merges`.
- Mid-rebase conflicts: resolve (see the conflicts skill), `git add`, `git rebase --continue`. Repeated identical conflicts mean you should have enabled rerere — abort, enable, restart.
- Empty commits after rebase (change already upstream): rebase stops; `git rebase --skip` is usually right, but check `git show` of the skipped commit first.
- GPG/sign-off requirements: rewritten commits are re-signed with your key; if the repo requires the original author's signature, do not rewrite — say why.
- Stacked branches on top of the rewritten one must be rebased too: `git rebase --onto feature backup/feature-... stacked-branch` (the backup branch is exactly the old base you need — a second reason it is mandatory).

## Done criteria

- [ ] Backup branch created before the first rewriting command and reported to the user
- [ ] Tree verified: `git diff $old..HEAD` empty, or every difference intended and shown via `git range-diff`
- [ ] No rebase left mid-flight (`git status` shows no "rebase in progress")
- [ ] Force-push, if any, used `--force-with-lease` after explicit user confirmation
- [ ] Stacked/dependent branches rebased or the user warned they now dangle
