---
name: reviewer
description: "Delegate an independent review of code, a plan, or a decision. Use when the user invokes $cursor:reviewer or requests this workflow with Cursor Agent."
---

# Cursor Agent reviewer

Pass the user’s task, constraints, and explicit authorizations faithfully. Do not complete the delegated work first and then hand the employee your answer. The chosen backend stays cursor.

Choose code review or general review by the subject. Read references/code-review.md for code, or references/general-review.md for plans and decisions, and include the relevant review brief. The employee gathers evidence itself. Preserve tracked files; findings need evidence, conditions, impact, and locations. --json is for the built-in code-review shape; validation failure is a diagnostic, not a successful review.

This role returns a background job ID. Read ../jobs/SKILL.md, wait for the complete result, and collect it. Observe only for a user progress request or relevant failure diagnosis.

Model defaults come from Cursor Agent; --model passes a native ID unchanged. Use the native model ID (including supported bracket parameters); a separate --effort is not mapped to Gemini-style names. Tool roles default to unrestricted operation; --restricted is an explicit opt-in, while ask stays restricted. Native deny and managed policies can still limit operations.

The plugin includes its own shared runtime. Resolve this path from this skill directory:

```sh
node "<skill-dir>/../../companion/cursor-companion.mjs" review --prompt-file "<task-file>"
```

Run the CLI in the same local permission context as its existing authenticated installation. Use the host’s normal escalation mechanism if its command sandbox prevents authentication, network access, or owned-process inspection. Do not read credentials or modify global CLI settings.
