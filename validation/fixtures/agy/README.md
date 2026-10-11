# Sanitized observed AGY fixtures

These active streams came from the fresh **post-update AGY 1.2.16** run, after its updater confirmed that version was already latest. All calls inherited `AGY_CLI_DISABLE_AUTO_UPDATE=true`. They are observed model output, not simulations. The initial baseline remains under `history/pre-update-v1.2.16`; it is not the active run.

| File | Actual observation |
| --- | --- |
| `success.jsonl` | First session turn: native SUCCESS and READY |
| `cancel.jsonl` | Real shell starts; native terminal ERROR / interrupted |
| `resume.jsonl` | Same session after cancel: native SUCCESS / FOLLOWUP_DONE |
| `nonce.jsonl` | Explicit same-session recall: exact seeded nonce, zero tool events |
| `structured.jsonl` | Schema review: native SUCCESS and structured_output |
| `cancel.companion-status.json` | Actual companion sidecar: canceled / canceled |
| `run-metadata.json` | Derived assertions from observed reports; not native events |

`source-map.json` records original relative source paths, SHA-256 digests, and the limited redactions. Test cwd, session IDs and nonce are consistently replaced; statuses, errors, event order and protocol field placement are unchanged. The UUIDs and nonce here are placeholders, not usable native sessions.

In particular, no `canceled` native stream event was synthesized. The real CLI reported `ERROR` / `interrupted`; `canceled` belongs to the companion's job lifecycle. Derived cleanup metadata does not itself replay a process cleanup test.

Run `node ../../agy/check-fixtures.mjs` from this directory, or use an absolute path to that script. It checks all fixture and copied-source digests and the observed contract offline. See `../../agy/README.md` for portable live rerun instructions, provenance, the original validation-harness issue and untested capabilities.
