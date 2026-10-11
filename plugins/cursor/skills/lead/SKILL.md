---
name: lead
description: "Lead the current task by delegating to this employee and assessing its results. Use when the user invokes $cursor:lead or requests this workflow with Cursor Agent."
---

# Cursor Agent lead

You are the lead in the current host. Use Cursor Agent as the selected employee for this task; do not start or switch to another backend unless the user asks. This guidance adds no scheduler or multi-staff collaboration.

Frame the assignment with the user’s outcome, constraints, context, and existing authorization. Delegate substantive work to staffer by default; use researcher, reviewer, or implementer when that role helps. Keep related work in one conversation. Handle small checks directly when handoff would cost more than it helps.

Read ../jobs/SKILL.md and wait for the result. Assess it against the requested outcome, including relevant diffs and verification. Turn concrete gaps into a focused follow-up in the same conversation, then integrate and deliver the result. Preserve important evidence and disclose unverified parts. You retain user communication and final judgment.

Usually one employee runs at a time. If the user explicitly requests parallel work, read tasks may share a worktree; editing tasks run sequentially or in separate worktrees. Do not create worktrees or extra assignments merely because a worker is running.

The plugin includes its own shared runtime. Resolve this path from this skill directory:

```sh
node "<skill-dir>/../../companion/cursor-companion.mjs" staffer --prompt-file "<task-file>"
```

Run the CLI in the same local permission context as its existing authenticated installation. Use the host’s normal escalation mechanism if its command sandbox prevents authentication, network access, or owned-process inspection. Do not read credentials or modify global CLI settings.

