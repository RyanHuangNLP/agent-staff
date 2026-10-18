# Project model and effort selection

Use the backend-bound companion entry from the invoking skill, in the user's
target project/worktree. The following commands do not start a model task:

```sh
node "<entry>" config
node "<entry>" models
node "<entry>" config --model "<chosen-id>" --effort "<chosen-level>"
```

Before the first **new task** for this backend in a project, read `config`.
If `configured` is false, use `models` to discover choices and ask the user to
choose a model and its supported effort, using the host's question/choice UI
when available. Offer native/built-in defaults as a choice. Keep the list short
and allow a custom model ID. Wait for an actual choice; a preselected option or
no response is not a selection. Then save it with `config` and start the task.
If the user has already supplied the choices or explicitly requested defaults,
save that selection and proceed without asking again. A request for a one-time
override or to skip configuration should run without saving or prompting.

If catalog discovery fails (for example, network or login is unavailable),
explain that briefly and offer native/built-in defaults or an explicit ID and
effort supplied by the user. Do not guess a current catalog, repeatedly retry,
or start a model task to discover options.

`config --model default --effort default` records a deliberate choice to keep
the original backend defaults (AGY's role defaults; native CLI defaults for the
others). This still sets `configured: true`, so do not ask again. Once configured,
ordinary invocations use the saved project defaults automatically. Forward an
explicit per-invocation model/effort as companion flags, not only as task text;
it overrides the saved defaults for that invocation and does not rewrite them.

The choices differ by backend:

- **AGY:** choose a concrete ID from `models`, or a supported `flash`/`pro`
  family and `low|medium|high`. Concrete IDs encode their effort. Offer only
  family/effort combinations actually listed; some models have no independent
  effort setting. Save a concrete ID with `--effort default` to avoid a stale
  separate preference.
- **Grok:** select a native ID and a reasoning effort supported by that model.
  The model listing may not enumerate efforts; offer native default or ask for
  the user's known supported value instead of inventing a compatibility list.
- **Cursor:** choose a listed model variant with the desired effort, or a
  supported native bracket-parameter model. Store that entire string as
  `--model`; save `--effort default`. Never pass a separate non-default
  `--effort` to Cursor.
- **Codex:** `models` reports the local native catalog and each model's advertised
  efforts. It is a cache, not a guarantee of current account/provider access.
  If unavailable, offer native default or a user-specified ID/effort; do not
  fabricate choices or start a paid model run to discover them.

When the user asks to **change the project default**, read `config`, identify
the requested model/effort, and run `config --model ...` and/or `--effort ...`.
Only provided fields change. If changing models leaves an incompatible effort,
ask for the new effort or use an already-authorized native default; do not
silently substitute a different level. Show the saved result. A settings-only
request must not also launch a task. Use `config --reset` only when the user
asks to forget the choice and choose again next time; to keep native defaults
without future prompts, save `default` instead.

In this saved-selection workflow, a request to change the project's model or
effort updates the saved choice; a request limited to "this task" is a one-time
override. The user can change the saved choice whenever they ask.

These preferences are backend-specific and worktree-local in
`.<backend>-staff/config.json`; no global CLI settings are changed. Saving or
resetting model defaults preserves the project's permission policy. Ongoing
jobs keep the configuration they started with. Continuations inherit their
conversation settings, even if project defaults changed; explicit flags can
override them. `restart` reuses the original assignment and settings. Do not
prompt for model selection on wait/status/result/observe/cancel or merely to
resume/restart an existing conversation. No terminal/TTY picker is required.
