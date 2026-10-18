---
name: researcher
description: "Delegate research that returns evidence, sources, conclusions, and uncertainties. Use when the user invokes $codex:researcher or requests delegating this workflow to a separate Codex CLI worker. Ordinary work in the host Codex agent does not require this skill."
argument-hint: "[--model <id>] [--effort <level>] <task or settings change>"
---

# Codex CLI researcher

Read ../../templates/model-selection.md for first-use model/effort selection, saved project defaults, and requested changes. Use `node "<skill-dir>/../../companion/codex-companion.mjs" config` to inspect settings and `models` to discover choices. Existing conversations keep their settings.

Pass the user’s task, constraints, and explicit authorizations faithfully. Do not complete the delegated work first and then hand the employee your answer. The chosen backend stays codex.

Ask for source-backed findings, supporting locations or links, and uncertainties. Preserve the working tree and report any unexpected changes.

This role returns a background job ID. Read ../jobs/SKILL.md, wait for the complete result, and collect it. Observe only for a user progress request or relevant failure diagnosis.

Model/effort precedence: explicit flags, saved conversation, project defaults, then Codex CLI's native defaults. --model passes a native ID unchanged; default clears that field's override for this invocation. --effort sets model_reasoning_effort for this invocation and is inherited on continuation. --restricted uses the native read-only sandbox with approval_policy=never; it can still read files. review --json uses Codex’s native output schema and local validation. Tool roles default to unrestricted operation; --restricted is an explicit opt-in, while ask stays restricted. Native deny and managed policies can still limit operations.

The plugin includes its own shared runtime. Resolve this path from this skill directory:

```sh
node "<skill-dir>/../../companion/codex-companion.mjs" research --prompt-file "<task-file>"
```

Run the CLI in the same local permission context as its existing authenticated installation. Use the host’s normal escalation mechanism if its command sandbox prevents authentication, network access, or owned-process inspection. Do not read credentials or modify global CLI settings.
