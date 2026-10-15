---
name: ask
description: "Ask a short question and return the answer in the same call. Use when the user invokes $grok:ask or requests this workflow with Grok Build."
---

# Grok Build ask

Pass the user’s task, constraints, and explicit authorizations faithfully. Do not complete the delegated work first and then hand the employee your answer. The chosen backend stays grok.

This is question-only foreground mode with a restricted profile. Do not add repository context or tell the employee to inspect files, run tools, or fetch material. Return its answer faithfully; use a tool-enabled role for work requiring tools. The no-tool instruction is not a claim of OS sandbox isolation. No setup is required.

Model defaults come from Grok Build; --model passes a native ID unchanged. --effort passes Grok’s native reasoning effort. Tool roles default to unrestricted operation; --restricted is an explicit opt-in, while ask stays restricted. Native deny and managed policies can still limit operations.

The plugin includes its own shared runtime. Resolve this path from this skill directory:

```sh
node "<skill-dir>/../../companion/grok-companion.mjs" ask --prompt-file "<task-file>"
```

Run the CLI in the same local permission context as its existing authenticated installation. Use the host’s normal escalation mechanism if its command sandbox prevents authentication, network access, or owned-process inspection. Do not read credentials or modify global CLI settings.
