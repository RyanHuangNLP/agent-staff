import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, run, jobIdOf } from './helpers.mjs';
import { processIdentity, stopExecution } from '../companion/stream-worker.mjs';

const fakeCoding = fileURLToPath(new URL('./fake-coding-agent.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { verdict: 'comment', summary: 'Verified review', findings: [], could_not_verify: [] };
const stateFile = (sb, backend) => path.join(sb.repo, `.${backend}-staff`, 'state.json');
const state = (sb, backend) => JSON.parse(fs.readFileSync(stateFile(sb, backend), 'utf8'));
const job = (sb, backend, id) => state(sb, backend).jobs.find((item) => item.id === id);
const invoke = (sb, backend, args, extra = {}) => run(sb, args, {
  AGENT_STAFF_BACKEND: backend, GROK_BIN: fakeCoding, CURSOR_BIN: fakeCoding,
  CODEX_BIN: fakeCoding, CODEX_HOME: path.join(sb.home, '.codex'), ...extra,
});
const until = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await pause(40);
  assert.ok(predicate(), 'Expected state was not reached');
};

test('AGY review prefers structured_output and keeps workspace warnings outside JSON', () => {
  const sb = sandbox('native-json');
  const started = invoke(sb, 'agy', ['review', '--json', '--prompt', 'Review the fixture'], {
    FAKE_AGY_RESPONSE: 'not the machine-readable answer', FAKE_AGY_STRUCTURED_OUTPUT: JSON.stringify(report),
    FAKE_AGY_TOUCH: 'review-change.txt',
  });
  const id = jobIdOf(started.stdout);
  const result = invoke(sb, 'agy', ['wait', id]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(job(sb, 'agy', id).result_file, 'utf8')), report);
});

test('AGY review validates complete fallback JSON and rejects invalid structured_output', () => {
  const sb = sandbox('native-json-invalid');
  for (const env of [{ FAKE_AGY_RESPONSE: 'prefix {"verdict":"comment"}' },
    { FAKE_AGY_RESPONSE: JSON.stringify(report), FAKE_AGY_STRUCTURED_OUTPUT: '{"verdict":"approve"}' }]) {
    const started = invoke(sb, 'agy', ['review', '--json', '--prompt', 'Review fixture'], env);
    const id = jobIdOf(started.stdout);
    const result = invoke(sb, 'agy', ['wait', id]);
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.equal(job(sb, 'agy', id).reason, 'invalid_structured_output');
    assert.ok(fs.existsSync(job(sb, 'agy', id).events_file));
  }
});

test('a first Grok ask timeout persists the reserved session for explicit continuation', () => {
  const sb = sandbox('grok-ask-reserved');
  const calls = path.join(sb.root, 'calls.jsonl');
  const first = invoke(sb, 'grok', ['ask', '--timeout', '800ms', '--prompt', 'first turn'], {
    FAKE_CODING_DELAY_MS: '5000', FAKE_CODING_CALLS: calls,
  });
  assert.equal(first.code, 5, first.stdout + first.stderr);
  const saved = state(sb, 'grok');
  assert.ok(saved.last.id);
  assert.equal(saved.conversation_configs[saved.last.id].mode, 'ask');
  const next = invoke(sb, 'grok', ['continue', '--conversation', saved.last.id, '--prompt', 'continue'], { FAKE_CODING_CALLS: calls });
  assert.equal(next.code, 0, next.stdout + next.stderr);
  const records = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records[0].argv.includes('--session-id'));
  assert.ok(records[1].argv.includes('--resume'));
  assert.equal(records[0].session, records[1].session);
});

test('new foreground ask retains failed raw output and optional successful diagnostic logs', () => {
  const sb = sandbox('grok-ask-logs');
  const failed = invoke(sb, 'grok', ['ask', '--prompt', 'empty answer fixture'], { FAKE_CODING_RESPONSE: '' });
  assert.equal(failed.code, 3, failed.stdout + failed.stderr);
  const failedDir = /Diagnostics: (.+)/.exec(failed.stderr)?.[1];
  assert.ok(failedDir);
  assert.ok(fs.existsSync(path.join(failedDir, 'events.jsonl')));
  const success = invoke(sb, 'grok', ['ask', '--prompt', 'answer fixture'], { AGENT_STAFF_KEEP_LOGS: '1' });
  assert.equal(success.code, 0, success.stdout + success.stderr);
  assert.equal(success.stdout, 'grok answer 中文\n');
  const keptDir = /\[grok-staff\] diagnostics: (.+)/.exec(success.stderr)?.[1];
  assert.ok(keptDir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(keptDir, 'diagnostics.json'), 'utf8')).observed_tool_calls, 0);
});

for (const backend of ['grok', 'cursor', 'codex']) {
  test(`${backend} accepts an explicit native session through a role without searching other state`, () => {
    const sb = sandbox(`${backend}-native-id`);
    const session = '981474c1-1f8b-4f72-b6cb-e99ced6aef70';
    const result = invoke(sb, backend, ['ask', '--conversation', session, '--prompt', 'continue explicitly']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(state(sb, backend).last.id, session);
  });

  test(`${backend} reconciles a dead worker before continuation and cleans its owned process on cancel`,
    { skip: process.platform === 'win32' }, async (t) => {
      const sb = sandbox(`${backend}-worker-crash`);
      const ready = path.join(sb.root, 'child.json');
      const heartbeat = path.join(sb.root, 'heartbeat');
      const completion = path.join(sb.root, 'completion');
      let record;
      t.after(async () => {
        if (!record) return;
        if (record.worker_identity && processIdentity(record.worker_identity.pid)?.born === record.worker_identity.born) {
          try { process.kill(record.worker_identity.pid, 'SIGKILL'); } catch {}
        }
        await stopExecution(record.execution_identity || null, record.owned_processes || [], undefined, { backend });
      });
      const started = invoke(sb, backend, ['staffer', '--timeout', '25s', '--prompt', 'bounded child fixture'], {
        FAKE_CODING_DELAY_MS: '20000', FAKE_CODING_CHILD_READY: ready,
        FAKE_CODING_HEARTBEAT: heartbeat, FAKE_CODING_COMPLETION: completion,
      });
      assert.equal(started.code, 0, started.stderr);
      const id = jobIdOf(started.stdout);
      await until(() => {
        record = job(sb, backend, id);
        return fs.existsSync(ready) && record.worker_identity && record.execution_identity && record.owned_processes?.some((item) => item.pid === JSON.parse(fs.readFileSync(ready, 'utf8')).pid);
      });
      process.kill(record.worker_identity.pid, 'SIGKILL');
      await until(() => processIdentity(record.worker_identity.pid)?.born !== record.worker_identity.born);
      const observed = invoke(sb, backend, ['observe', id]);
      assert.equal(observed.code, 5, observed.stdout + observed.stderr);
      assert.match(observed.stdout, /cleanup_unverified/);
      assert.equal(job(sb, backend, id).executionMayBeActive, true);
      assert.equal(invoke(sb, backend, ['continue', '--job', id, '--prompt', 'must not run']).code, 1);
      const stopped = invoke(sb, backend, ['cancel', id]);
      assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
      assert.equal(job(sb, backend, id).status, 'canceled');
      assert.equal(job(sb, backend, id).executionMayBeActive, false);
      const stoppedText = fs.readFileSync(heartbeat, 'utf8');
      await pause(150);
      assert.equal(fs.readFileSync(heartbeat, 'utf8'), stoppedText);
      assert.ok(!fs.existsSync(completion));
    });
}
