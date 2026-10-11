#!/usr/bin/env node
// Generated portable harness, NOT the script that produced the bundled fixtures.
// Two paid calls: explicit-session nonce recall, then native structured review.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyUpstream, here } from './check-fixtures.mjs';
import { runStreaming } from './upstream/companion/stream-worker.mjs';

if (process.argv.includes('--help')) {
  console.log('AGENT_STAFF_RUN_REAL_AGY=1 node run-real-extras.mjs --suite-summary /absolute/path/summary.json --output /absolute/new-output-dir');
  console.log('Requires a PASSED cancel-continue run from the bundled upstream test, an authenticated AGY CLI, and approval for two model calls. AGY_BIN optionally selects the executable. No model switch or retry is performed.');
  process.exit(0);
}
if (process.env.AGENT_STAFF_RUN_REAL_AGY !== '1') {
  console.error('Not run. Read README.md, obtain authorization for real usage, then explicitly set AGENT_STAFF_RUN_REAL_AGY=1.');
  process.exit(2);
}
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert.ok(['--suite-summary', '--output'].includes(key) && value, `Invalid argument ${key}`);
  options[key.slice(2)] = path.resolve(value);
}
assert.ok(options['suite-summary'] && options.output, 'Both --suite-summary and --output are required');
verifyUpstream();
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const suite = readJson(options['suite-summary']);
const prior = suite.cases.find(item => item.kind === 'cancel-continue');
assert.equal(prior?.outcome, 'passed', 'Do not continue after a failed cancellation suite');
assert.ok(suite.model && prior.conversation_id && prior.cwd);
assert.ok(!fs.existsSync(options.output) || fs.readdirSync(options.output).length === 0, 'Use a fresh, empty output directory');
fs.mkdirSync(options.output, { recursive: true });
const binary = process.env.AGY_BIN || 'agy';
const command = args => /\.(mjs|cjs|js)$/i.test(binary) ? { binary: process.execPath, args: [binary, ...args] } : { binary, args };
const version = () => {
  const cmd = command(['--version']);
  const value = spawnSync(cmd.binary, cmd.args, { encoding: 'utf8', timeout: 10000 });
  if (value.error) throw value.error;
  assert.equal(value.status, 0, value.stderr);
  return value.stdout.trim();
};
const currentVersion = version();
assert.equal(currentVersion, prior.version_after, 'CLI changed since the suite; establish a fresh baseline rather than mixing versions');
const state = readJson(path.join(prior.cwd, '.agy-staff/state.json'));
assert.ok(!state.jobs.some(job => job.status === 'running'), 'Existing suite jobs are still running');
const seed = state.jobs.find(job => job.id === prior.results[0].id);
const token = /MEMORY_[a-f0-9]+/.exec(readJson(seed.spec_file).prompt)?.[0];
assert.ok(token);
const fixtureText = fs.readFileSync(path.resolve(here, '../fixtures/agy/structured.jsonl'), 'utf8');
const schema = fixtureText.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'init').init.json_schema;
const summary = { kind: 'generated-portable-rerun-harness', started_at: new Date().toISOString(),
  suite_summary: options['suite-summary'], version_before: currentVersion, model: suite.model,
  conversation_id: prior.conversation_id, expected_token: token,
  auto_update_disabled: process.env.AGY_CLI_DISABLE_AUTO_UPDATE === 'true', calls: [] };
const save = () => fs.writeFileSync(path.join(options.output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
save();

async function nativeCall(label, cwd, prompt, { conversation, jsonSchema } = {}) {
  const folder = path.join(options.output, label); fs.mkdirSync(folder);
  const job = { id: label, events_file: path.join(folder, 'events.jsonl'), progress_file: path.join(folder, 'progress.json') };
  const args = ['-p', prompt, '--model', suite.model, '--output-format', 'stream-json', '--print-timeout', '120s', '--add-dir', cwd, '--dangerously-skip-permissions'];
  if (conversation) args.push('--conversation', conversation);
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));
  const call = { label, cwd, prompt, args, started_at: new Date().toISOString() };
  summary.calls.push(call); save();
  const previousCwd = process.cwd();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try {
    process.chdir(cwd);
    const invocation = command(args);
    const result = await runStreaming({ ...invocation, job, budget: 120000, signal: controller.signal,
      update: fields => { call.execution = { ...call.execution, ...fields }; save(); },
      conversation: id => { call.observed_session_id = id; save(); } });
    call.result = result;
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.payload.status, 'SUCCESS');
    const events = fs.readFileSync(job.events_file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const init = events.find(event => event.event === 'init');
    assert.ok(init?.conversation_id, 'Missing top-level init session ID');
    call.complete_stream_tool_events = events.filter(event => event.step_update?.step_type === 'tool').length;
    assert.equal(call.complete_stream_tool_events, 0, `${label}: model used tools against the no-tool request`);
    call.finished_at = new Date().toISOString(); save();
    return result.payload;
  } catch (error) {
    call.error = error.stack; call.finished_at = new Date().toISOString(); save();
    throw error;
  } finally {
    process.chdir(previousCwd);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

try {
  const prompt = 'Without using any tools or reading files, recall the exact MEMORY_ test token supplied in the first request of this conversation. Return only that token. If you cannot recall it, reply NOT_RECALLED.';
  assert.ok(!prompt.includes(token));
  const memory = await nativeCall('nonce', prior.cwd, prompt, { conversation: prior.conversation_id });
  assert.equal(memory.conversation_id, prior.conversation_id);
  assert.equal(memory.response.trim(), token);
  const structuredCwd = path.join(options.output, 'structured-workspace'); fs.mkdirSync(structuredCwd);
  const init = spawnSync('git', ['init', '-q'], { cwd: structuredCwd, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const payload = await nativeCall('structured', structuredCwd,
    'Review the following harmless plan without tools: print HELLO once. Return an approve verdict, a one-sentence summary, no findings and no could_not_verify items in the required JSON schema. Do not access or modify files or use the network.', { jsonSchema: schema });
  assert.equal(payload.structured_output.verdict, 'approve');
  assert.equal(typeof payload.structured_output.summary, 'string');
  assert.deepEqual(payload.structured_output.findings, []);
  assert.deepEqual(payload.structured_output.could_not_verify, []);
  const started = prior.tool_events.find(event => event.label === 'active' && event.phase === 'entered');
  while (Date.now() - started.at <= 66000) await new Promise(resolve => setTimeout(resolve, 1000));
  const toolEvents = fs.readFileSync(path.join(prior.cwd, 'tool-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(toolEvents.filter(event => event.label === 'active' && event.phase === 'entered').length, 1);
  assert.ok(!toolEvents.some(event => event.label === 'active' && event.phase === 'completed'));
  const pids = [...new Set(state.jobs.flatMap(job => [job.pid, job.agy_pid]).concat(toolEvents.map(event => event.pid)).filter(Boolean))];
  const ps = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=,lstart=,stat='], { encoding: 'utf8' });
  assert.ok([0, 1].includes(ps.status)); assert.equal(ps.stderr.trim(), '');
  // A reused PID fails conservatively and needs inspection; it is never killed.
  assert.equal(ps.stdout.trim(), '', 'A recorded PID is present; inspect identity before claiming cleanup');
  summary.late_cleanup = { checked_at: new Date().toISOString(), elapsed_since_tool_entered_ms: Date.now() - started.at,
    shell_gate_limit_ms: 65000, queried_pids: pids, ps_stdout: ps.stdout, no_active_completion: true };
  summary.version_after = version();
  assert.equal(summary.version_after, currentVersion, 'CLI version changed during testing');
  summary.outcome = 'passed';
} catch (error) {
  summary.outcome = 'failed'; summary.error = error.stack; process.exitCode = 1;
} finally {
  summary.finished_at = new Date().toISOString(); save();
  console.log(JSON.stringify({ outcome: summary.outcome, calls_started: summary.calls.length, evidence: options.output }));
}
