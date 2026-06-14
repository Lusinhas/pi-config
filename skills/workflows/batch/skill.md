---
name: batch
description: "Repetitive multi-file changes at scale: enumerate the full work list, perfect the transform on one file, apply everywhere, verify project-wide. Use for renames, migrations, import rewrites, or config rollouts."
disable-model-invocation: true
---

Batch edits fail in two ways: missing instances (the list was incomplete) and breaking instances (the transform did not fit every file). This skill prevents both by separating enumeration, design, application, and verification into distinct, checkable phases. Never start editing before the full list exists.

## Workflow

1. **Enumerate the complete work list first.** Write the matcher, save the list, count it:

   ```bash
   grep -rln "fetchUser(" --include="*.ts" src/ packages/ | sort > /tmp/batch-list.txt
   wc -l /tmp/batch-list.txt
   ```

   Probe for variants the naive pattern misses: aliased imports, re-exports, string references, tests, docs, generated code:

   ```bash
   grep -rn "fetchUser" --include="*.md" docs/
   grep -rln "from './user'" src/ | grep -vFf /tmp/batch-list.txt
   ```

   Prefer `astsearch` for structural matches (`fetchUser($ARG)` as a call expression) since grep cannot distinguish a call from a comment. Exclude generated directories (`dist/`, `*.gen.ts`, lockfiles) explicitly and say so. Load the list into the `todo` tool so progress survives interruptions; without it, mark progress by annotating `/tmp/batch-list.txt`.

2. **Design the transform once, on one representative file.** Pick a file that exercises the most variants (multiple call sites, an edge case). Apply the change by hand, run that file's tests, and write down the exact rule including what to do with each known variant. If the transform is mechanical, encode it now:
   - Structural: `astrewrite` with pattern `fetchUser($ID)` to `fetchUser($ID, { cache: true })` — survives formatting differences.
   - Textual:

     ```bash
     perl -pi -e 's/\bfetchUser\(([^)]+)\)/fetchUser($1, { cache: true })/g' src/api/orders.ts
     git diff src/api/orders.ts
     ```

   Review the diff of the representative file character by character before scaling up. A bad transform applied 200 times is 200 bugs.

3. **Apply across the list.** Precondition for any bulk pass: a clean working tree (commit or stash unrelated work first), so `git diff` shows exactly the batch and a bad pass reverts cleanly.
   - Structural: run `astrewrite` over the list's paths, review the staged diff preview file by file, then apply with the returned applyId — never apply unreviewed.
   - With the `task` tool: shard `/tmp/batch-list.txt` into chunks of 10-20 files and dispatch parallel agents, each given the written transform rule verbatim, the representative diff as the example, and the instruction to *skip and report* any file the rule does not cleanly fit rather than improvise.
   - Scripted fallback for mechanical transforms:

     ```bash
     xargs perl -pi -e 's/\bfetchUser\(([^)]+)\)/fetchUser($1, { cache: true })/g' < /tmp/batch-list.txt
     ```

   - Manual fallback: edit sequentially in list order, committing every 15-25 files so a bad stretch is cheaply revertible (`git commit -m "batch: fetchUser cache arg (1/4)"`).

   Files where the rule does not fit go to a divergence list — do not force them in the bulk pass.

4. **Verify project-wide, two directions:**
   - **Nothing missed** — the counter-grep must return zero (excluding the divergence list):

     ```bash
     grep -rn "fetchUser([^,)]*)" --include="*.ts" src/ packages/ || echo "clean"
     ```

   - **Nothing broken** — full typecheck/build and test suite, not just touched files:

     ```bash
     npx tsc --noEmit && npm test
     git diff --stat
     ```

   Compare `git diff --stat` file count against `wc -l /tmp/batch-list.txt`; explain any mismatch.

5. **Handle divergent files deliberately.** For each file in the divergence list, make the bespoke edit, note in one line *why* it diverged (dynamic call, different overload, vendored copy), and re-run its tests.

6. **Report.** Total files enumerated, files changed mechanically, files changed with divergence (with reasons), files intentionally skipped (generated/vendored), and the verification commands that passed.

## Edge cases

- **The list is huge (500+ files):** confirm scope with the `ask` tool before proceeding; consider whether a compatibility shim (deprecated wrapper that forwards) makes the migration incremental instead.
- **Pattern appears in strings, comments, or i18n files:** decide the policy explicitly (usually: update docs/comments, never touch translation values) and state it.
- **Transform changes behavior, not just shape:** the per-chunk commits plus full-suite run are mandatory, and the representative file needs a test asserting the new behavior.
- **Concurrent agents touch shared files** (a barrel `index.ts`): handle shared files yourself in a final serial pass; never assign one file to two agents.
- **sed/perl differences:** GNU `sed -i` vs BSD `sed -i ''` — prefer `perl -pi -e` for portability.

## Done when

- [ ] Complete work list saved with a count, variants probed, exclusions stated
- [ ] Transform validated on a representative file and its diff reviewed
- [ ] Bulk application done with skip-and-report semantics, committed in revertible chunks
- [ ] Counter-grep returns zero hits; build and full test suite pass
- [ ] Divergent files fixed individually with one-line reasons
- [ ] Report lists enumerated vs changed vs diverged vs skipped counts
