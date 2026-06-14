# pi-config operating guide

## Repository contract

This repository is configuration source, package source, templates, and install orchestration for pi-config.

The repository root is not a Pi package.

Do not add Pi package metadata to the repository root.

Every extension lives under `packages` as an independent Pi package.

Every extension package owns its manifest, entry point, configuration defaults, runtime services, and verification surface.

Every extension package must keep implementation files in deeply nested leaf folders; a package area must not mix implementation files with child folders.

Every file and folder name must be lowercase and single-word.

Do not use CamelCase, PascalCase, snake_case, kebab-case, spaces, punctuation separators, or multi-word names in file or folder paths.

Extension class names may still be PascalCase inside files, but file and folder paths must use lowercase single-word names.

The single-word rule governs package source under `packages/`; repo-root resources under `agents/`, `skills/`, and `prompts/` are exempt.

A resource's file name, folder name, and frontmatter `name:` may be multi-word to match its invocation identity; do not rename existing resources to satisfy the single-word rule.

Static prompts, skills, and themes are registered explicitly through package manifests.

Subagent definitions are registered explicitly by the subagents package.

Do not add dynamic prompt, skill, or agent discovery.

## Code architecture

Build cohesive objects.

Every file must own real behavior, real types used locally, a Pi entry adapter, a package manifest, configuration, resource, direct-value tests, or direct-value docs.

Do not create files whose only purpose is to re-export, alias, forward, or wrap another file, such as `export { X } from "../somewhere/X.ts"`.

Do not create a folder solely to contain one of those alias, re-export, or shim files.

If a file only forwards to another file, delete it and import the real file directly.

Class-first design is mandatory when possible.

Avoid free functions by default.

Free functions are allowed only for unavoidable framework entry points, typed adapters, or pure constants where a class would reduce clarity.

Pi extension default exports should delegate immediately to package-local classes.

Use constructors to make collaborators explicit.

Keep package boundaries intentional.

Do not couple extension packages through hidden root assumptions.

Do not introduce ambient mutable state unless the Pi extension API requires it.

Represent invalid states explicitly.

Validate untrusted input at package boundaries.

Propagate failures with enough context to diagnose the root cause.

Do not hide broken behavior behind broad catches, sleeps, retries, silent fallbacks, weakened assertions, or special-cased output.

## Formatting

Make the code breathe.

Put blank lines around control-flow blocks.

Apply this to `if`, `else`, `for`, `while`, `switch`, `try`, `catch`, `finally`, and early-return guard groups.

Keep related statements visually grouped.

Prefer short, direct methods with clear names.

Do not create formatting churn outside files touched for the task.

## Comments

No comments ever.

Do not add line comments.

Do not add block comments.

Do not add TODO comments.

Do not add explanatory docstrings.

Do not add change markers.

Do not add suppression comments unless the user explicitly approves the exact suppression.

If code needs explanation, improve the name, type, structure, boundary, or test.

## Performance

Design hot paths deliberately.

Avoid repeated filesystem discovery.

Avoid repeated parsing when data can be registered once.

Avoid unbounded repository scans on startup.

Cache only when ownership and invalidation are clear.

Keep deterministic ordering for package resources, registries, command lists, and tool descriptions.

Bound work that scales with repository size, transcript size, package count, file count, or model output size.

## Accuracy

Read the code before changing behavior.

Trace call chains through package boundaries.

Prefer structural search for code-shaped questions.

Preserve intended behavior unless the task requires a correctness change.

Back changed behavior with focused verification wherever the repo provides a harness.

Do not claim completion until verification has run and the result is observed.

## Implementation workflow

Use the harness tools first.

Large repo-wide implementation must run through workflow orchestration before edits.

Use workflows for large-scale orchestration and parallel recon.

Split package-wide refactors into independent agents with explicit ownership and verification.

Keep todos current for multi-step work.

Read the smallest relevant file set plus one neighboring example.

Stop exploring once the target and convention are clear.

Make the smallest correct diff that satisfies the task.

Run verification cheapest-first:

1. IDE diagnostics when available
2. focused unit checks
3. affected package checks
4. lint, typecheck, build
5. wider suite when blast radius warrants it

## Packaging workflow

Do not register the repository root as a Pi package.

Do not install the repository root with `pi install`.

Install and register extension packages from `packages/<name>`.

A new extension package is incomplete until its manifest, entry point, defaults, package-local logic, and verification path exist.

Resource packages must list prompts, skills, and themes explicitly in their manifests.

Do not rely on conventional-directory auto-discovery for prompts, skills, or agents.

## Reporting

Report changed paths.

Report rationale only where it explains a non-obvious design decision.

Report exact verification commands and observed results.

Report blockers by naming the blocked file, command, or missing decision.
