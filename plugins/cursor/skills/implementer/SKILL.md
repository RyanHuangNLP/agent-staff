---
name: implementer
description: "Delegate a scoped code change and the verification needed to assess it. Use when the user invokes $cursor:implementer or requests this workflow with Cursor Agent."
---

# Cursor Agent implementer

Pass the user’s task, constraints, and explicit authorizations faithfully. Do not complete the delegated work first and then hand the employee your answer. The chosen backend stays cursor.

The assignment includes the necessary verification. Existing dirty-worktree edits belong to the user: preserve them and keep the change scoped. Default delivery is a diff and verification report; include commits, pushes, or PR actions only when the user requested them. Non-Git work is supported with the runtime’s limitation notice.

This role returns a background job ID. Read ../jobs/SKILL.md, wait for the complete result, and collect it. Observe only for a user progress request or relevant failure diagnosis.

Model defaults come from Cursor Agent; --model passes a native ID unchanged. Use the native model ID (including supported bracket parameters); a separate --effort is not mapped to Gemini-style names. Tool roles default to unrestricted operation; --restricted is an explicit opt-in, while ask stays restricted. Native deny and managed policies can still limit operations.

The plugin includes its own shared runtime. Resolve this path from this skill directory:

```sh
node "<skill-dir>/../../companion/cursor-companion.mjs" implement --prompt-file "<task-file>"
```

Run the CLI in the same local permission context as its existing authenticated installation. Use the host’s normal escalation mechanism if its command sandbox prevents authentication, network access, or owned-process inspection. Do not read credentials or modify global CLI settings.

