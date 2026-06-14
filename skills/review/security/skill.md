---
name: security
description: "Security review of pending changes — injection, authz gaps, secrets, deserialization, SSRF, dependency and crypto risks — each finding with an exploit scenario and fix. Use for audits or before merging code touching trust boundaries."
disable-model-invocation: true
---

# Security Review

Audit pending changes for exploitable weaknesses. The unit of analysis is not the changed line but the path from an attacker-controlled input to a sensitive sink — new code is frequently safe alone and unsafe once wired into existing routes, jobs, or handlers.

## Workflow

1. Scope the change set:

   ```bash
   base=$(git merge-base origin/main HEAD)
   git diff --name-only "$base"...HEAD
   git diff -M "$base"...HEAD
   ```

2. Map trust boundaries before hunting bugs. For each changed file, identify whether it handles external input (HTTP handlers, queue consumers, CLI args, file uploads, webhooks) and what sinks it can reach (database, shell, filesystem, outbound HTTP, deserializer). Use astsearch to find call sites of new functions if available; otherwise:

   ```bash
   grep -rn "parse_upload" --include="*.py" src/
   ```

   A helper only called from an admin-only code path is a different risk than the same helper on an unauthenticated route — record which it is.

3. Sweep each vulnerability class across the changed files. Grep narrows, reading confirms — never report on a grep hit alone:

   ```bash
   files=$(git diff --name-only --diff-filter=d "$base"...HEAD)
   grep -nE 'execute\(.*(\+|%s|f"|\$\{)' $files                  # SQL built by concatenation
   grep -nE 'shell=True|os\.system|child_process\.exec\b|eval\(' $files
   grep -nE 'open\(|sendFile|path\.join|os\.path\.join' $files    # path traversal candidates
   grep -nE 'pickle\.loads|yaml\.load\(|Marshal\.load|unserialize\(' $files
   grep -nE 'requests\.(get|post)\(|fetch\(|urlopen\(' $files     # SSRF if URL is user-influenced
   grep -nE 'md5|sha1\b|\bECB\b|Math\.random|random\.random' $files
   ```

   For each hit, trace whether the tainted value is attacker-reachable and whether validation happens before the sink, not after.

4. Secrets sweep. Check the diff itself and history on the branch, since a secret committed then deleted is still leaked:

   ```bash
   git diff "$base"...HEAD | grep -nEi '(api[_-]?key|secret|passw|token|private[_-]key)\s*[:=]'
   git log -p "$base"..HEAD | grep -nEi '(api[_-]?key|secret|passw|token|private[_-]key)\s*[:=]|BEGIN.*PRIVATE KEY'
   ```

   Values in `.env.example` or test fixtures with obviously fake shapes are fine; anything plausible-looking requires rotation, not just removal.

5. Dependency review. If manifests changed (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`), check new or bumped packages for known advisories: run `npm audit`, `pip-audit`, or `osv-scanner` when installed; otherwise use the websearch tool to query the package name plus version against advisories. Also flag typosquat-shaped names and brand-new packages with few releases. With no web access at all, list the new dependencies as unverified rather than silently passing them.

6. Authn/authz pass. For every new endpoint, mutation, or job: which middleware or decorator enforces identity, and is the object-level check present (can user A pass user B's id)? Diff the new route against a known-protected sibling route to spot missing guards.

7. Classify and report. Severity scale:
   - Critical: pre-auth RCE, SQL injection on a reachable route, leaked live credential.
   - High: authz bypass, post-auth injection, SSRF reaching internal metadata services.
   - Medium: weak crypto on non-critical data, SSRF behind strict auth, verbose error leakage.
   - Low: hardening gaps, missing rate limits, defense-in-depth suggestions.

   Each finding: severity, file:line, a concrete exploit scenario (the literal request, payload, or input an attacker sends), and the minimal fix — parameterize the query, add the one missing decorator — not a rewrite. Fan out per vulnerability class with the task tool on large diffs, then merge and re-grade severities yourself. Use the advisor tool for a second opinion on borderline Critical/High calls when available. End with an explicit verdict: ship, ship after fixing Critical/High items, or no-ship.

## Edge cases

- Test files and fixtures: injection patterns there are usually non-findings; flag only if test helpers leak into production builds.
- Vendored or generated code: report upstream provenance instead of line-level fixes.
- Framework auto-escaping (ORM parameterization, template engines): confirm the safe API is actually used on that line; `raw()` escape hatches reintroduce the bug.
- Crypto in non-security contexts (md5 for cache keys) is Low or a non-finding — say so explicitly to avoid noise.
- If the diff is empty, review the working tree with `git diff HEAD` and say that scope changed.

## Done criteria

- [ ] Trust-boundary map written before findings: inputs, sinks, and which routes are authenticated.
- [ ] All seven classes swept: injection, authn/authz, secrets, deserialization, SSRF, dependencies, crypto.
- [ ] Branch history checked for secrets, not just the final diff.
- [ ] Every finding has severity, file:line, a concrete exploit scenario, and a minimal fix.
- [ ] Composition with existing code assessed, not just new lines.
- [ ] Explicit closing verdict (ship / ship after fixes / no-ship) plus findings summary by severity, or a clean bill with scope caveats.
