#!/bin/sh
# Generated orchestration wrapper. The two stages were also executed directly
# for the post-update evidence; no credentials or global settings are changed.
set -eu
if [ "${1:-}" = "--help" ]; then
  printf '%s\n' 'AGENT_STAFF_RUN_REAL_AGY=1 sh reproduce.sh /absolute/packet/validation/agy /absolute/new-evidence-dir [/absolute/agy]'
  printf '%s\n' 'Runs five paid model calls. Requires an existing AGY login, git, node and macOS/POSIX process inspection. The output directory must not exist.'
  exit 0
fi
if [ "${AGENT_STAFF_RUN_REAL_AGY:-}" != "1" ]; then
  printf '%s\n' 'Not run. Read README.md and explicitly authorize five real model calls before setting AGENT_STAFF_RUN_REAL_AGY=1.' >&2
  exit 2
fi
AGY_PACKET=${1:?Provide an absolute path to packet/validation/agy}
AGY_EVIDENCE=${2:?Provide a new absolute evidence directory}
AGY_CLI=${3:-agy}
case "$AGY_PACKET" in /*) ;; *) printf '%s\n' 'Packet path must be absolute.' >&2; exit 2;; esac
case "$AGY_EVIDENCE" in /*) ;; *) printf '%s\n' 'Evidence path must be absolute.' >&2; exit 2;; esac
if [ -e "$AGY_EVIDENCE" ]; then
  printf '%s\n' 'Evidence directory already exists; use a new path. Nothing was run.' >&2
  exit 2
fi
node "$AGY_PACKET/check-fixtures.mjs"
mkdir -p "$AGY_EVIDENCE"
export AGY_CLI_DISABLE_AUTO_UPDATE=true
AGY_REAL_CONTINUATION=1 AGY_REAL_CONTINUATION_CASE=cancel-continue \
  AGY_REAL_MODEL=gemini-3.8-flash-low AGY_BIN="$AGY_CLI" TMPDIR="$AGY_EVIDENCE" \
  node "$AGY_PACKET/upstream/tests/real-continuation.integration.mjs" \
  > "$AGY_EVIDENCE/continuation.stdout.txt" 2> "$AGY_EVIDENCE/continuation.stderr.txt"
AGY_SUITE_SUMMARY=$(node --input-type=module - "$AGY_EVIDENCE" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.argv[2];
const matches = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('agy-continuation-real-'));
assert.equal(matches.length, 1, 'Expected one suite evidence directory');
const summary = path.join(root, matches[0].name, 'summary.json');
assert.equal(JSON.parse(fs.readFileSync(summary, 'utf8')).cases[0].outcome, 'passed');
process.stdout.write(summary);
JS
)
AGY_BIN="$AGY_CLI" node "$AGY_PACKET/run-real-extras.mjs" \
  --suite-summary "$AGY_SUITE_SUMMARY" --output "$AGY_EVIDENCE/extras" \
  > "$AGY_EVIDENCE/extras.stdout.txt" 2> "$AGY_EVIDENCE/extras.stderr.txt"
printf '%s\n' "Evidence: $AGY_EVIDENCE"
cat "$AGY_EVIDENCE/extras.stdout.txt"
