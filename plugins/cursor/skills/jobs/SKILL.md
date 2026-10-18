---
name: jobs
description: "Wait for, inspect, cancel, continue, or restart this employee’s jobs; view or change project model and effort defaults. Use when the user invokes $cursor:jobs or requests this workflow with Cursor Agent."
argument-hint: "[--model <native-id-or-variant>] <task or settings change>"
---

# Cursor Agent jobs

Read ../../templates/model-selection.md for first-use model/effort selection, saved project defaults, and requested changes. Use `node "<skill-dir>/../../companion/cursor-companion.mjs" config` to inspect settings and `models` to discover choices. Existing conversations keep their settings.

The employee’s CLI is `node "<skill-dir>/../../companion/cursor-companion.mjs"`. Its job state is scoped to this backend and the current Git worktree (or current non-Git directory). Keep the returned job ID with the assignment.

- After dispatch, use `wait <id> --timeout 10m`. Exit 2 only means this wait expired; wait again for the same job. Use the host’s pending-command collection mechanism while a wait is running. Do not launch routine status/observe loops.
- When the user asks for progress, use `observe <id>`; it is a bounded snapshot, not the full result. Get the full result from wait or result.
- `status [id]` lists or inspects jobs. `wait` and `observe` without an ID select this employee’s latest job at the moment the command starts; a wait already in progress does not switch to a job started later. `result` without an ID selects its latest finished job. Prefer the ID already tracked by the host.
- Use only this employee’s entry for wait, continue, status, and result. A job started with cursor-staff is collected with cursor-staff wait. Each backend has a separate state directory and conversation history.
- For a requested follow-up, use `continue --job <id> --prompt-file <file>`; `continue --prompt <text>` also resumes this employee’s latest conversation. Model and permissions are inherited unless explicitly overridden. The same running session cannot accept another turn.
- For an immediate change, `cancel <id>`, confirm cleanup, inspect partial work, then continue. Ending a wait does not stop the worker. `restart <id>` creates a fresh conversation for the original assignment.
- On timeout, return the saved diagnosis and recovery command. Follow existing user authorization; if continuation was not authorized, obtain it before consuming another run. Never silently change backend, model, or permissions after failure.

For direct persona invocations, relay short results faithfully; summarize long results and link the complete file without rewriting evidence or errors. For lead, assess and integrate. Diagnostics and usage are separate from the answer. A successful CLI turn does not prove the user task was accomplished: check relevant artifacts before relying on it.

Common options: --restricted/--unrestricted, --model, --timeout; --json requests the built-in review result shape. Model preferences use `config`; optional `setup --restrict review,research` sets only this employee’s repository permission policy. Native global allow/deny rules remain the CLI’s configuration and are not copied from AGY.
