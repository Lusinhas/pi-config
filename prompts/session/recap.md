---
description: Recap what happened this session in 10 lines
---

Recap this session in at most 10 lines.

Ground it in evidence: scan the conversation for what was asked and decided, and verify against `git status` and `git diff --stat` so the recap reflects what actually happened to the code, not just what was talked about. Cover, one line each and roughly in this order: the session's goal; what was accomplished, with key file names; what was changed but left unfinished; decisions made and the compressed why; problems hit and how they were resolved or dodged; anything still broken or untested; and the single most useful next action.

Format as a plain dashed list, one line per item — no headings, no preamble, no code blocks, no closing remarks. Every line must carry information: drop a line rather than pad it, and omit any category where nothing happened instead of writing "none". Prefer concrete nouns — paths, commands, error names — over abstractions. Ten lines is the ceiling, not the target; six dense lines beat ten thin ones. Do not modify any files; this is output only.
