---
description: Summarize changes for a teammate
argument-hint: "[ref range, PR, or topic — defaults to current changes]"
---

Summarize ${1:-the current changes} for a teammate who knows the project but not this work.

Determine the scope: if the argument names a ref range, PR, or topic, use that; otherwise inspect the working tree (`git status`, `git diff`, `git diff --cached`) plus commits on this branch that are not on the default branch. Read the diffs themselves, not just the file names.

Write the summary as: one headline sentence stating the overall purpose; a short bulleted list of concrete changes grouped by area, each naming the key files; a "why" note for any change whose motivation is not obvious from the code; and a final section flagging what a teammate should know before building on this — behavior changes, new dependencies, migrations, TODOs left behind, untested paths.

Use plain language with no marketing tone, and do not restate the diff line by line — compress to what matters for someone picking this up tomorrow. Target 150-250 words of output. Do not modify any files.
