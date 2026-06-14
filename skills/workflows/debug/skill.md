---
name: debug
description: "Systematic debugging: reproduce first, bisect the cause space, test one falsifiable hypothesis at a time, fix the root cause, add a regression test. Use when a bug's cause is unknown or a fix already failed."
disable-model-invocation: true
---

Debugging is a search problem. The goal is to shrink the space of possible causes as fast as possible, not to stare at code hoping for insight. Never edit code before you can reproduce the failure on demand, and never hold more than one hypothesis at a time.

## Workflow

1. **Reproduce deterministically.** Capture the exact failing command and make it cheap to rerun:

   ```bash
   npm test -- -t "imports csv with BOM" 2>&1 | tee /tmp/repro.log
   ```

   If the failure is flaky, loop it to measure the failure rate before changing anything:

   ```bash
   for i in $(seq 1 20); do npm test -- -t "csv" >/dev/null 2>&1 || echo "fail $i"; done
   ```

   No repro means no debugging — instrument first (logging, a failing test that encodes the report) until you have one. Use the `todo` tool to record the repro command and each hypothesis as you go; with `todo` disabled, keep notes in `/tmp/debug-notes.md`.

2. **Bisect the cause space.** Pick the cheapest axis that halves it:
   - **Time**: if it worked before, `git bisect` with the repro as the oracle:

     ```bash
     git bisect start HEAD v2.3.0
     git bisect run npm test -- -t "csv"
     git bisect reset
     ```

   - **Space**: binary-search with logging. Log at the midpoint of the data flow (request handler vs. DB layer), confirm which half holds the corruption, recurse.
   - **Input**: delta-reduce the repro. Halve the input file/config/fixture until removing anything makes the bug vanish.

   Use `astsearch` to find every call site of the suspect function; fall back to `grep -rn "parseCsv(" src/`.

3. **One hypothesis, cheapest falsifying experiment.** State it precisely ("the BOM survives `stripHeader` because the check runs after slicing") and design the experiment that could prove it *wrong* in under a minute — a one-line log, an assertion, a REPL call. If the experiment doesn't falsify it, only then act on it. If you have burned three hypotheses, stop and widen: re-read the repro log end to end, check environment differences (`node --version`, env vars, dirty working tree), and consider the `advisor` tool or a `websearch` for the exact error string. Use `history` to check whether this codebase hit the same failure before.

4. **Fix the root cause.** Ask "why was the system able to get into this state?" and fix there. A symptom patch (null check at the crash site) is acceptable only as an explicitly labeled stopgap with the real fix filed. Prefer the smallest diff that makes the invariant true everywhere, not just on the repro path.

5. **Add a regression test.** Convert the minimal repro into a test that fails on the pre-fix commit and passes after:

   ```bash
   git stash push -- src/            # stash only the fix, keep the new test in the tree
   npm test -- -t "BOM"              # must FAIL: the test pins the bug
   git stash pop
   npm test -- -t "BOM"              # must PASS: the fix closes it
   ```

   Stash only the files the fix touched (never the test file itself, or the "before" run proves nothing). The first run must fail, the second must pass — otherwise the test does not pin the bug.

6. **Summarize the causal chain.** Report in one paragraph: trigger → mechanism → observable symptom → fix → test. Example: "A UTF-8 BOM in uploaded CSVs survived header stripping because the BOM check ran after `slice(1)`; the first column name became `﻿id`, so lookups returned undefined and the import silently dropped rows. Moved the strip before slicing; added `imports csv with BOM` test."

## Edge cases

- **Bisect lands on a merge or a huge refactor commit:** bisect within it using `git bisect` on the branch's own commits, or binary-search the diff by reverting hunks.
- **Repro only fails in CI:** match the environment first (same Node/Python version, `CI=true`, fresh clone in `/tmp`) before concluding the code differs.
- **Heisenbug that disappears under logging:** suspect timing/races; replace logs with post-hoc state capture (write to a buffer, dump on exit) or run under `--repeat`/stress.
- **Two bugs masking each other:** if the fix makes a *different* failure appear, treat it as progress — re-enter the loop at step 1 with the new repro.

## Done when

- [ ] Failing repro command recorded and was run before any code change
- [ ] Root cause identified at a specific line/commit, not a vague subsystem
- [ ] Fix addresses the cause; any stopgap is labeled as such
- [ ] Regression test fails before the fix and passes after (verified, not assumed)
- [ ] Full test suite still green
- [ ] Causal-chain summary delivered (trigger → mechanism → symptom → fix → test)
