---
description: Run tests and fix failures at the root cause without weakening assertions
argument-hint: "[test file, suite, or pattern — defaults to all]"
---

Run ${1:-all} tests and fix every failure at the root cause.

Find the project's real test command (package.json scripts, Makefile, CI config) and run it; if an argument was given, treat it as a filter and pass it through the runner's native filtering. Capture the full output.

For each failure, diagnose before editing: read the failing test to learn the intended behavior, then read the code under test, and decide whether the bug is in the code or the test asserts something genuinely outdated. Default assumption: the test is right and the code is wrong. Never weaken assertions to get green — no broadening matchers, deleting asserts, raising tolerances, adding skips or retries, or mocking away the failing path. Change a test's expectation only when the underlying behavior was intentionally changed, and say so explicitly. For stubborn failures, use /skill:debug to instrument rather than guessing.

Fix one logical group at a time, re-running the affected tests after each fix. Finish with a full run of the original scope, paste the passing summary, and list each failure with its root cause.
