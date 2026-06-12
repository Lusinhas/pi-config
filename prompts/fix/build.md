---
description: Make the build pass, bisecting between config and code causes
---

Make the project build successfully.

Identify the canonical build command (package.json scripts, Makefile, CI workflow, README) and run it, capturing the complete output. Focus on the first error — later errors are usually cascade noise.

Bisect the cause between configuration and code. Configuration suspects: dependency or lockfile drift (try a clean install), toolchain version mismatches (.nvmrc, rust-toolchain, engines fields), stale caches or build artifacts (clean the output dirs), broken paths or aliases in build config, and environment variables that CI sets but the local shell does not. Code suspects: real compile errors, broken imports, and codegen that needs re-running. A quick discriminator: if the build still fails after `git stash` (or on the last known-good commit), the problem is environment or config, not the recent code — restore the stash afterwards either way.

Fix the root cause, not the symptom: do not pin random versions, delete failing modules, or weaken compiler settings to force green. Re-run the full build after each fix until it completes cleanly, paste the success output, and state the root cause and which category it fell into.
