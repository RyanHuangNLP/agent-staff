---
name: researcher
description: "Delegate research that returns evidence, sources, conclusions, and uncertainties. Use when the user invokes $grok:researcher or requests this workflow with Grok Build."
---

# Grok Build researcher

Pass the user’s task, constraints, and explicit authorizations faithfully. Do not complete the delegated work first and then hand the employee your answer. The chosen backend stays grok.

Ask for source-backed findings, supporting locations or links, and uncertainties. Preserve the working tree and report any unexpected changes.

This role returns a background job ID. Read ../jobs/SKILL.md, wait for the complete result, and collect it. Observe only for a user progress request or relevant failure diagnosis.

Model defaults come from Grok Build; --model passes a native ID unchanged. --effort passes Grok’s native reasoning effort. Tool roles default to unrestricted operation; --restricted is an explicit opt-in, while ask stays restricted. Native deny and managed policies can still limit operations.

The plugin includes its own shared runtime. Resolve this path from this skill directory:

```sh
node "<skill-dir>/../../companion/grok-companion.mjs" research --prompt-file "<task-file>"
```

Run the CLI in the same local permission context as its existing authenticated installation. Use the host’s normal escalation mechanism if its command sandbox prevents authentication, network access, or owned-process inspection. Do not read credentials or modify global CLI settings.
