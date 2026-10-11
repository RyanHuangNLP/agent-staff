# AGY validation handoff

**Status: post-update validation passed.** `agy update` confirmed that **1.2.16** was already the latest offered version on 2026-10-05. A fresh five-call run then observed **1.2.16** before and after testing, with `gemini-3.8-flash-low` and process-only `AGY_CLI_DISABLE_AUTO_UPDATE=true`. The active fixtures below come from that fresh run. Earlier baseline material is retained under `history/pre-update-v1.2.16`; do not conflate the two runs.

## What was actually tested

On 2026-10-05 Asia/Shanghai, five small model calls verified:

1. Upstream `cancel-continue`: seed a random token; resume into a real bounded shell task; cancel after the shell starts; resume the same session into a different shell task. Three calls, all relevant assertions passed.
2. One explicit `--conversation` recall of the first turn's random token through the portable harness. The recall prompt did not contain the token; the answer matched exactly; the complete captured stream contained zero tool events.
3. One native-schema review through the portable harness and unchanged upstream streaming runner. AGY returned `SUCCESS` and a valid `result.structured_output`, with zero tool events.

A late cancellation check ran 103,193 ms after the canceled shell entered, beyond its original 65,000 ms maximum. No recorded worker/CLI/tool PID remained, the canceled shell had no completion marker and entered only once, and no job remained running. A final check also covered the two extra native-call PIDs. The upstream suite additionally checked the shell PID's birth identity immediately after cancellation. This proves the tested cancellation path, not arbitrary remote/shared-backend cleanup.

The earlier pre-update structured-check harness wrote its observation file into the test workspace. That triggered the companion's git-delta warning, so parsing the entire human-readable result file as JSON failed. The failure and its offline native-payload revalidation remain in the historical evidence. The final portable harness retained raw output outside the workspaces and passed without that issue. No result from the old failed harness was relabelled as a fresh successful run.

Not tested: hard timeout, restricted/write-denial enforcement, a hard no-tool mode, independent concurrent AGY sessions, Windows, other models or other AGY versions. No global settings edit was made. Native CLI session/log writes still occur normally. The reference checkout was clean before and after testing.

## Provenance and included files

- Upstream: <https://github.com/keli-wen/agy-staff>
- Commit: `9a30e0774de09e0815c4fc5caf456472f8fc3509`.
- Executed companion SHA-256: `f6896f792fda203ceca4f853d115472d34d8edff543aa407f8e0ad0d36e138f2`.
- `sources-lock.json` records SHA-256 for all eight copied upstream files: four companion modules, the two templates used by this run, the actual continuation test, and its MIT license. They are unmodified copies with the original relative layout.
- Copyright (c) 2026 Keli (pkuwkl). See [upstream/LICENSE](upstream/LICENSE). Retain that notice and license when reusing substantial source.
- `../fixtures/agy/*.jsonl` are sanitized **observed native streams**, not simulated output. Only test cwd paths, session IDs and the test nonce were replaced consistently; event order, field placement, counters, statuses and errors were retained.
- `cancel.companion-status.json` is the actual companion status sidecar. Native cancellation returned `result.status=ERROR`, `error=interrupted`; the companion separately recorded `status=canceled`. No native `canceled` event was invented.
- `run-metadata.json` is a clearly labelled derived test summary, not a native protocol event. `source-map.json` maps every fixture to original evidence and hashes.
- `check-fixtures.mjs` is a generated offline assertion script. It checks copied-source hashes, fixture hashes, top-level init session IDs, native success, structured output, session continuity, nonce recall, and the distinction between native interruption and companion cancellation.
- `run-real-extras.mjs` is a **generated portable rerun harness that was actually executed** for the active nonce/schema fixtures. It uses the unchanged upstream `runStreaming` worker to capture complete native output outside the test workspaces, avoiding the original observation-file problem. Its preserved first comment refers to the originally bundled pre-update fixtures, which were made by different one-off scripts; `execution-manifest.json` records the exact script SHA used in the final live run.
- `reproduce.sh` is a generated orchestration wrapper for the same two stages, with explicit paid-use opt-in, process-only update freezing and a fresh-directory requirement. The two stages were executed directly for final evidence; the wrapper itself received syntax/help checks, not an additional paid rerun.

No `.git`, native credentials, authentication files, or unrelated feature cache was copied. The packet does not depend on the original user's checkout path.

## Offline checks from any new location

The baseline used Node `v26.8.2` on macOS. The packet has no npm dependencies. Use a modern Node runtime with `Array.findLast`, `structuredClone`, and the built-in test/runtime APIs; a different Node version is not part of the original measured matrix.

```sh
AGY_PACKET=/absolute/path/to/packet/validation/agy
node "$AGY_PACKET/check-fixtures.mjs"
node --check "$AGY_PACKET/run-real-extras.mjs"
```

The checker exits nonzero on any assertion or digest mismatch. It never spawns a process, calls a model, reads login files, or modifies a file. When the original raw evidence is still available, also check its hashes:

```sh
node "$AGY_PACKET/check-fixtures.mjs" \
  --original-evidence /private/tmp/agent-staff-preflight.fODiUI/updated/agy
```

This last path is only optional provenance input, not a runtime dependency. The executed offline check passed with final-evidence hash verification. The earlier `/private/tmp/agent-staff-preflight.fODiUI/agy` root matches only the history fixtures.

## Authorized live rerun at a new path

This section consumes model usage and requires an already authenticated AGY installation. Run in the same unsandboxed process/network context as that installation so process inspection and owned-child cleanup work. Do not change global permission settings or install/update AGY from these scripts. First record/update the desired CLI version through a separate explicitly authorized step.

The commands below run exactly the selected three-call cancellation/continuation case, followed by two calls for explicit-session nonce recall and schema output. They do not run the full suites and do not retry or change models automatically. Use a new evidence directory each time.

```sh
AGY_PACKET=/absolute/path/to/packet/validation/agy
AGY_CLI="$(command -v agy)"
AGY_EVIDENCE="$(mktemp -d /tmp/agent-staff-agy-rerun-XXXXXX)"
node "$AGY_PACKET/check-fixtures.mjs"
"$AGY_CLI" --version

AGY_CLI_DISABLE_AUTO_UPDATE=true \
AGY_REAL_CONTINUATION=1 \
AGY_REAL_CONTINUATION_CASE=cancel-continue \
AGY_REAL_MODEL=gemini-3.8-flash-low \
AGY_BIN="$AGY_CLI" \
TMPDIR="$AGY_EVIDENCE" \
node "$AGY_PACKET/upstream/tests/real-continuation.integration.mjs" \
  > "$AGY_EVIDENCE/continuation.stdout.txt" \
  2> "$AGY_EVIDENCE/continuation.stderr.txt"
```

Require exit 0 and `outcome: passed` before proceeding. Read `continuation.stdout.txt` for `Evidence: <directory>`. Set the following variable to that newly printed directory's `summary.json`; do not reuse the old baseline path.

```sh
AGY_SUITE_SUMMARY=/absolute/new/evidence/agy-continuation-real-EXAMPLE/summary.json
AGY_CLI_DISABLE_AUTO_UPDATE=true AGENT_STAFF_RUN_REAL_AGY=1 AGY_BIN="$AGY_CLI" \
node "$AGY_PACKET/run-real-extras.mjs" \
  --suite-summary "$AGY_SUITE_SUMMARY" \
  --output "$AGY_EVIDENCE/extras" \
  > "$AGY_EVIDENCE/extras.stdout.txt" \
  2> "$AGY_EVIDENCE/extras.stderr.txt"
```

The extras harness obtains the seed nonce from the saved spec solely for the assertion; it does not put it in the recall prompt. It passes the recorded native conversation ID explicitly, preserves the suite's model, verifies the version did not change, captures every raw event outside the workspace, and uses the upstream runner's owned-process cleanup. The schema is read from the observed fixture. A final late check waits past the original 65-second shell limit if necessary. A recorded PID that happens to have been reused causes a conservative failure requiring inspection; the harness never kills it by number.

The extras harness has a deliberate difference from the original one-off test scripts: it calls the native AGY protocol through the unchanged upstream streaming runner, so it can retain raw schema output without relying on the companion's success-file deletion timing. It does not re-test the companion's human-readable result rendering. The original continuation test remains unchanged.

Both scripts write their own summary/log/raw evidence into disposable directories. A passing fixture check does not establish that a new live run succeeded: inspect that run's exit status and summaries. Authentication, quota, schema, version or cleanup failures must be reported as observed; do not silently switch models, loosen permissions, or relabel partial results as passed.

For an equivalent single command, choose a new output directory that does not already exist:

```sh
AGENT_STAFF_RUN_REAL_AGY=1 sh "$AGY_PACKET/reproduce.sh" \
  "$AGY_PACKET" /absolute/new/agy-evidence "$AGY_CLI"
```

## Final and historical evidence

Final root: `/private/tmp/agent-staff-preflight.fODiUI/updated/agy`.

- `summary.json`, `findings.md`: post-update conclusions and scope.
- `agy-continuation-real-lcWFeF/summary.json`: final unchanged upstream suite record.
- `extras/summary.json`, `extras/nonce/events.jsonl`, `extras/structured/events.jsonl`: final portable harness results and full native streams.
- `execution-manifest.json`: exact executed script hashes and update-log provenance.
- `final-process-check.json`: every recorded suite and extra-call PID gone.
- `portable/`: a self-contained copy of this AGY validation packet and its active fixtures; it has no original-checkout dependency.

The original pre-update evidence remains unchanged:

Original root: `/private/tmp/agent-staff-preflight.fODiUI/agy`.

- `summary.json`, `findings.md`: original conclusions and scope.
- `agy-continuation-real-lyNSrA/summary.json`: exact original upstream suite record.
- Its `cancel-continue/.agy-staff/` directory: specs, captures, logs and actual cancellation sidecar.
- `structured-summary.json`: original whole-result JSON parse failure.
- `structured-native-validation.json`: subsequent offline native-payload assertions.
- `structured/captured-events.jsonl`: observed native schema output.
- `memory-summary.json`, `memory.captured-events.jsonl`: explicit-session recall evidence.
- `cleanup-after-window.json`: late PID/completion-marker check.

See `../fixtures/agy/source-map.json` for final-run hashes, and the history directory's own `source-map.json` for the initial baseline hashes. The original records were read only while making this packet.
