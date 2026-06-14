---
name: spec
description: "Turns a vague request into an approved implementation spec: interview, explore, draft, hostile critique, revise. Use for large, ambiguous, or risky work before coding starts; not for small fixes."
disable-model-invocation: true
---

Produce a spec the user can approve with confidence, then stop. The failure mode this skill prevents is plausible-sounding plans built on unverified assumptions: every claim about existing code must carry a file:line reference, and the draft must survive a deliberate attempt to break it before the user ever sees it.

## Workflow

### 1. Interview

Use the `ask` tool to run one batched question round covering three areas:

- Goals: observable behavior when done ("what command or click proves this works?")
- Constraints: compatibility floors, performance budgets, dependencies that must not change, deadlines
- Non-goals: what is explicitly out of scope, so the critique pass can flag scope creep

Ask 3-6 specific questions, never a generic "any preferences?". If `ask` is unavailable, end the turn with the numbered questions as plain text and resume when the user replies. Never invent answers; if the user replies "whatever you think", choose defaults and record each as an `ASSUMPTION:` line in the spec so step 4 attacks it.

### 2. Explore for ground truth

Do not trust the user's description of the code; verify it.

```
grep -rn "createSession" src/ --include="*.ts" | head -30
find . -name "*.test.*" -path "*auth*" -not -path "*/node_modules/*"
git log --oneline -10 -- src/auth/
```

Prefer `astsearch` for structural questions (call sites, implementations of an interface) when the extension is loaded; fall back to `grep` plus reading the surrounding file with `read`. For unfamiliar third-party libraries, check the installed version in the lockfile first, then use `websearch`/`webfetch` for its docs; without those tools, read the package's README under `node_modules`. Record every finding as `path:line — fact`. When code reality contradicts the user's framing (the feature half-exists, the API they named was removed), surface it immediately in a follow-up `ask` round rather than planning around it silently.

### 3. Draft the spec

`write` the draft to `.pi/spec-draft.md` (add it to `.gitignore` if untracked files would pollute the repo). Required sections:

- Goal and Non-goals, copied from interview answers, assumptions marked
- Phases: each independently shippable and verifiable, with an exit-check command per phase, for example `npm test -- --grep "session"` or `curl -s localhost:3000/healthz`
- File-level changes per phase: exact path, what changes, why; new files marked `(new)`
- Test plan and rollback notes
- Open questions, if any survived step 1

### 4. Hostile critique

Spawn a reviewer with the `task` tool using the `critic` agent (or get a second opinion from the standalone `advisor` tool), passing the full draft and this brief: attack missing requirements, untested assumptions, phases without a verification command, files listed that do not exist, hidden coupling between phases, and anything violating a stated non-goal. If `task` and `advisor` are unavailable, self-critique in a separate pass: re-verify every cited path with `ls` and every cited line with `grep -n`, confirm each phase exit-check actually runs, and write out the strongest argument that the plan fails.

Decision points: requirement gaps send you back to step 1 for one more `ask` round; code-reality gaps send you back to step 2. Cap at two critique cycles — after the second, ship the spec with remaining concerns listed under Open questions instead of looping.

### 5. Revise and present

Apply the critique fixes, then present. If the plan extension is present, submit the spec through it so the user gets a structured accept/revise prompt; otherwise paste the spec and request explicit approval via `ask`, or end the turn asking "approve, or what should change?". Do not write implementation code before approval. After approval, register each phase with the `todo` tool (fallback: a checklist at the top of the spec file) and record the approved decisions as a `memory` topic so later sessions inherit them.

## Edge cases and failure handling

- Greenfield repo: replace step 2 with a conventions survey — `cat package.json`, the lockfile, CI config under `.github/workflows/` — and state chosen conventions in the spec.
- Spec exceeds roughly two pages: split into a milestone spec plus per-phase mini-specs; seek approval at milestone level only.
- User abandons the interview: proceed with documented assumptions, but mark the spec DRAFT and require approval before any code.
- Critique agent times out or errors: fall back to the self-critique procedure; never skip step 4.

## Done criteria

- Goals, constraints, and non-goals confirmed by the user or marked as assumptions
- Every existing-code claim has a verified file:line reference
- Every phase has an exit-check command that was confirmed runnable
- Draft survived at least one full critique pass with fixes applied
- Spec presented and explicit approval received before implementation began
