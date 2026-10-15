# Installing agent-staff

This is the four-backend fork at https://github.com/RyanHuangNLP/agent-staff. Do not use the upstream AGY GitHub URL as an installer for this fork: it does not contain this implementation.

Use Node.js 24+ and the user's existing authenticated native CLI. From the target project directory, call the absolute path to bin/agent-staff.mjs with --backend agy, grok, cursor, or codex. The README contains concrete examples. doctor only checks executable versions; it does not authenticate or call a model.

For Codex CLI versions that support plugin management, register the full local repository with `codex plugin marketplace add /absolute/path/to/agent-staff`, then install the desired plugins with `codex plugin add agy@agent-staff`, `codex plugin add grok@agent-staff`, `codex plugin add cursor@agent-staff`, or `codex plugin add codex@agent-staff`. A Git source can instead be registered with `codex plugin marketplace add RyanHuangNLP/agent-staff`; private repository access uses the caller's existing Git authentication. Verify with `codex plugin list --marketplace agent-staff --json`, then restart the desktop app and open a new chat. The README records the current machine's optional CLI configuration compatibility parameter. Do not install plugins merely while reviewing or cloning this project; install only when the user requests installation.

The root is the AGY plugin source. plugins/grok, plugins/cursor, and plugins/codex are generated, self-contained plugin sources with seven roles each. Preserve the entire source directory so relative companion, template, and review references work. Merely copying this repository does not install any host plugin. Install or replace a host plugin only when the user asks, using the installed host's documented local-source mechanism and verifying the resolved version.

For a portable CLI package, run npm run build:plugins, npm run check:skills, npm run check:plugins, npm test, then npm pack --ignore-scripts. Extract the tarball and invoke package/bin/agent-staff.mjs directly. No global npm install is necessary.

Run native execution and job-management commands in the permission context needed by that CLI's existing login and owned-process inspection. If a command sandbox blocks authentication, network access, ps, or signaling, use the host's normal approval mechanism. Do not read credentials, change login state, rewrite native permission settings, or weaken cleanup verification to make a test pass.

AGY's retained Pi/OpenCode resources and historical reference are compatibility resources. Grok/Cursor have been scoped to local Codex/macOS validation. Codex 0.9.0 support has offline protocol/workflow tests and local CLI argument checks; real Codex model/tool execution is not yet validated. See codex-support.md and do not claim other host installations were tested.
