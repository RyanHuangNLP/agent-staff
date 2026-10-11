#!/usr/bin/env node
// Offline only. No process spawning, model calls, credentials or writes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function verifyUpstream() {
  const lock = readJson(path.join(here, 'sources-lock.json'));
  for (const entry of lock.files) {
    const content = fs.readFileSync(path.join(here, entry.path));
    assert.equal(sha256(content), entry.sha256, `Upstream snapshot changed: ${entry.path}`);
  }
  return lock;
}

export function checkFixtures(fixtures = path.resolve(here, '../fixtures/agy'), originalEvidence) {
  const lock = verifyUpstream();
  const sourceMap = readJson(path.join(fixtures, 'source-map.json'));
  for (const entry of sourceMap.files) {
    assert.equal(sha256(fs.readFileSync(path.join(fixtures, entry.file))), entry.fixture_sha256,
      `Fixture digest mismatch: ${entry.file}`);
    if (originalEvidence && entry.source_evidence_relative_path) {
      assert.equal(sha256(fs.readFileSync(path.join(originalEvidence, entry.source_evidence_relative_path))), entry.source_sha256,
        `Original evidence digest mismatch: ${entry.file}`);
    }
    if (originalEvidence) for (const source of entry.source_summary_digests || []) {
      assert.equal(sha256(fs.readFileSync(path.join(originalEvidence, source.path))), source.sha256,
        `Original summary digest mismatch: ${source.path}`);
    }
  }
  const meta = readJson(path.join(fixtures, 'run-metadata.json'));
  assert.equal(meta.kind, 'derived-test-metadata-not-native-events');
  const streams = Object.fromEntries(['success', 'cancel', 'resume', 'structured', 'nonce'].map(name => {
    const text = fs.readFileSync(path.join(fixtures, `${name}.jsonl`), 'utf8');
    assert.ok(!text.includes('/private/tmp/') && !text.includes('/Users/'), `${name}: unredacted cwd`);
    return [name, text.trim().split('\n').map(line => JSON.parse(line))];
  }));
  const nativeResult = name => streams[name].findLast(event => event.event === 'result')?.result;
  const ids = [];
  for (const [name, events] of Object.entries(streams)) {
    const init = events.find(event => event.event === 'init');
    assert.ok(init && typeof init.conversation_id === 'string', `${name}: missing top-level init session`);
    assert.equal(init.init.conversation_id, undefined, `${name}: do not invent an init-body session`);
    assert.equal(init.init.model, meta.model);
    const expected = name === 'structured' ? meta.structured_session : meta.session_a;
    assert.equal(init.conversation_id, expected);
    for (const event of events) {
      const session = event.conversation_id || event[event.event]?.conversation_id;
      if (session) assert.equal(session, expected, `${name}: mixed session`);
    }
    if (name !== 'structured') ids.push(init.conversation_id);
  }
  assert.equal(new Set(ids).size, 1, 'Seed, canceled turn, resumed turn and nonce recall must share a session');
  for (const name of ['success', 'resume', 'structured', 'nonce']) assert.equal(nativeResult(name).status, 'SUCCESS');
  assert.equal(nativeResult('success').response.trim(), 'READY');
  assert.equal(nativeResult('resume').response.trim(), 'FOLLOWUP_DONE');
  assert.equal(nativeResult('nonce').response.trim(), meta.expected_nonce);
  assert.ok(!meta.nonce_request_prompt.includes(meta.expected_nonce));
  assert.equal(streams.nonce.filter(event => event.step_update?.step_type === 'tool').length, 0);
  assert.equal(nativeResult('cancel').status, 'ERROR');
  assert.equal(nativeResult('cancel').error, 'interrupted');
  assert.equal(nativeResult('cancel').response, '');
  assert.ok(streams.cancel.some(event => event.step_update?.tool_name === 'run_command' && event.step_update.state === 'ACTIVE'));
  assert.ok(streams.cancel.every(event => event.event !== 'canceled'), 'No synthetic native cancellation event');
  const companion = readJson(path.join(fixtures, 'cancel.companion-status.json'));
  assert.equal(companion.status, 'canceled'); assert.equal(companion.reason, 'canceled');
  assert.equal(meta.cancel_companion_terminal.wait_exit, 4);
  const structured = nativeResult('structured').structured_output;
  assert.equal(structured.verdict, 'approve'); assert.equal(typeof structured.summary, 'string');
  assert.deepEqual(structured.findings, []); assert.deepEqual(structured.could_not_verify, []);
  assert.deepEqual(Object.keys(structured).sort(), ['could_not_verify', 'findings', 'summary', 'verdict']);
  const response = JSON.parse(nativeResult('structured').response);
  assert.equal(response.verdict, structured.verdict);
  // Extra response-only fields are observed data, not required by the protocol.
  assert.equal(response.summary, structured.summary);
  assert.ok(meta.cleanup.elapsed_since_shell_entered_ms > meta.cleanup.shell_gate_limit_ms);
  assert.equal(meta.cleanup.any_recorded_pid_present, false);
  assert.equal(meta.cleanup.canceled_shell_completed, false);
  assert.equal(meta.cleanup.canceled_shell_entered_count, 1);
  assert.equal(meta.cleanup.remaining_running_count, 0);
  return { outcome: 'passed', offline: true, fixture_count: sourceMap.files.length,
    upstream_commit: lock.commit, observed_cli_version: sourceMap.recorded_cli_version,
    original_digests_checked: !!originalEvidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fixtures, original;
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i], value = process.argv[i + 1];
    assert.ok(value, `Missing value for ${flag}`);
    if (flag === '--fixtures') fixtures = path.resolve(value);
    else if (flag === '--original-evidence') original = path.resolve(value);
    else throw new Error(`Unknown option ${flag}`);
  }
  console.log(JSON.stringify(checkFixtures(fixtures, original), null, 2));
}
