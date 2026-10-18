---
name: staffer
description: "Delegate a general task; the user task determines the work and output. Use when the user invokes $grok:staffer or requests this workflow with Grok Build."
argument-hint: "[--model <id>] [--effort <level>] <task or settings change>"
---

# Grok Build staffer

Read ../../templates/model-selection.md for first-use model/effort selection, saved project defaults, and requested changes. Use `node "<skill-dir>/../../companion/grok-companion.mjs" config` to inspect settings and `models` to discover choices. Existing conversations keep their settings.

Pass the user’s task, constraints, and explicit authorizations faithfully. Do not complete the delegated work first and then hand the employee your answer. The chosen backend stays grok.

Use the task’s requested output; do not impose a specialist report format. Native employee capabilities may be used when the task calls for them.

This role returns a background job ID. Read ../jobs/SKILL.md, wait for the complete result, and collect it. Observe only for a user progress request or relevant failure diagnosis.

Model/effort precedence: explicit flags, saved conversation, project defaults, then Grok Build's native defaults. --model passes a native ID unchanged; default clears that field's override for this invocation. --effort passes Grok’s native reasoning effort. Tool roles default to unrestricted operation; --restricted is an explicit opt-in, while ask stays restricted. Native deny and managed policies can still limit operations.

The plugin includes its own shared runtime. Resolve this path from this skill directory:

```sh
node "<skill-dir>/../../companion/grok-companion.mjs" staffer --prompt-file "<task-file>"
```

Run the CLI in the same local permission context as its existing authenticated installation. Use the host’s normal escalation mechanism if its command sandbox prevents authentication, network access, or owned-process inspection. Do not read credentials or modify global CLI settings.
