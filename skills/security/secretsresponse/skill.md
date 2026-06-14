---
name: secrets-response
description: "Triage and remediation workflow for suspected leaked secrets in code, logs, commits, issues, or artifacts: identify without exposing values, revoke/rotate, remove safely, decide on history cleanup, add prevention, and verify."
disable-model-invocation: true
---

# Secrets Response

Handle suspected credential leaks without making exposure worse. The first fix is usually rotation, not deletion.

## Workflow

1. **Contain the secret value.** Do not paste, print, or quote the full value. Mask all but a short prefix/suffix if needed for identification. Avoid commands that dump surrounding files to chat when a secret might be present.

2. **Classify and scope.** Identify the credential type, owner/provider, environment, privileges, and where it appears:
   - Working tree, staged changes, committed history, logs, CI artifacts, issues, docs, screenshots.
   - Public remote, private remote, local-only branch, or generated artifact.

   Use targeted searches that print locations, not values:

   ```bash
   git status --porcelain
   git diff --name-only
   git log --all --name-only --oneline --decorate | head -200
   grep -RIlE '(api[_-]?key|secret|token|password|private[_-]?key)' . --exclude-dir=.git --exclude-dir=node_modules
   ```

3. **Rotate or revoke first.** If the credential may have left the local machine or reached a shared remote/artifact, tell the user rotation is required. Removing the string from git does not invalidate copies already fetched, indexed, cached, or logged.

4. **Remove from current files.** Replace with an environment variable, secret manager reference, fixture value, or `.env.example` placeholder. Preserve tests with obviously fake credentials. Never weaken a test by removing the assertion that caught the leak.

5. **History cleanup decision.** Rewriting history is destructive and requires explicit user approval. Present the options:
   - Rotate/revoke and leave history intact for low-risk private repos.
   - Use `git filter-repo` or provider-native secret removal for shared repos after coordinating force-push impact.
   - Treat public leaks as compromised even after history cleanup.

6. **Add prevention.** Use existing repo tooling first: secret scanners, pre-commit hooks, CI checks, ignore rules, safer config loading, and test fixtures with fake-looking values. New dependencies require approval.

7. **Verify.** Re-run the scanner or targeted searches against working tree and relevant history. Confirm the app/test path still works with non-secret placeholders or documented environment variables.

## Output template

```markdown
# Secrets response

## Scope
- Secret type:
- Locations:
- Exposure level: local-only / private remote / public / artifact

## Actions taken
- Rotation/revocation:
- Current-file removal:
- History decision:
- Prevention:

## Verification
- Commands run:
- Remaining findings:

## User action required
- Provider-side rotation, audit log review, or coordinated force-push steps.
```

## Done criteria

- [ ] Full secret value never appears in the transcript.
- [ ] Exposure level and credential privileges are stated.
- [ ] Rotation/revocation need is explicit before removal-only cleanup.
- [ ] Current files no longer contain the secret.
- [ ] History rewrite is not performed without explicit approval.
- [ ] Prevention and verification steps are reported.
