import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInvocation, createBackendProjection, STOP_POLICIES } from '../companion/backend-adapters.mjs';
import { createParser } from '../companion/observation.mjs';
import { stopExecution } from '../companion/stream-worker.mjs';

const fixtures = fileURLToPath(new URL('../validation/fixtures/', import.meta.url));
function project(backend, file) {
  const ids = [];
  const projection = createBackendProjection(backend, (id) => ids.push(id));
  const parser = createParser(projection.accept, projection.warn, 64 * 1024 * 1024);
  const raw = fs.readFileSync(path.join(fixtures, file));
  // A real protocol stream can split UTF-8 or JSON tokens at any byte.
  for (let i = 0; i < raw.length; i += 37) parser.write(raw.subarray(i, i + 37));
  parser.end();
  return { projection, ids, events: raw.toString().trim().split('\n').map((line) => JSON.parse(line)) };
}

test('Grok native text deltas concatenate exactly and terminal end identifies the session', () => {
  const { projection, events, ids } = project('grok', 'grok/01-seed.jsonl');
  const payload = projection.summary();
  assert.equal(payload.status, 'SUCCESS');
  assert.equal(payload.response, events.filter((e) => e.type === 'text').map((e) => e.data).join(''));
  assert.deepEqual(ids, [events.at(-1).sessionId]);
  assert.doesNotMatch(payload.response, /model thought omitted/);
});

test('Grok limit with partial text remains attention, native cancellation never becomes wrapper cancellation', () => {
  const { projection } = project('grok', 'grok/07-turn-limit.jsonl');
  assert.equal(projection.summary().status, 'ATTENTION');
  assert.equal(projection.summary().reason, 'turn_limit');
  assert.ok(projection.summary().response);
  const p = createBackendProjection('grok');
  p.accept({ type: 'end', stopReason: 'cancelled', sessionId: 'session' });
  assert.equal(p.summary().reason, 'backend_cancelled');
  assert.equal(p.summary().status, 'ERROR');
});

test('both backends retain explicit permission denials while a native successful turn stays successful', () => {
  for (const [backend, file] of [['grok', 'grok/03-deny.jsonl'], ['cursor', 'cursor/current/deny.stdout.ndjson']]) {
    const { projection } = project(backend, file);
    assert.equal(projection.summary().status, 'SUCCESS');
    assert.equal(projection.summary().permissionDenials.length, 2);
    assert.ok(projection.snapshot().warnings.some((w) => /permission policy/i.test(w)));
  }
});

test('Cursor returns the last complete assistant message and keeps opaque IDs including newlines', () => {
  const { projection, events } = project('cursor', 'cursor/current/baseline.stdout.ndjson');
  const last = events.filter((e) => e.type === 'assistant').at(-1);
  assert.equal(projection.summary().response, last.message.content.filter((c) => c.type === 'text').map((c) => c.text).join(''));
  assert.notEqual(projection.summary().response, events.at(-1).result);
  assert.ok(projection.summary().toolCalls.some((t) => t.id.includes('\n')));
  assert.equal(projection.summary().status, 'SUCCESS');
  assert.ok(!projection.snapshot().warnings.length);
});

test('canceled Cursor stream cannot manufacture a terminal result', () => {
  const { projection } = project('cursor', 'cursor/current/cancel_tree.stdout.ndjson');
  assert.equal(projection.summary(), null);
  assert.ok(projection.partialText());
});

test('Cursor aggregate result cannot substitute for a missing assistant answer', () => {
  const projection = createBackendProjection('cursor');
  projection.accept({ type: 'system', session_id: 'opaque-session' });
  projection.accept({ type: 'result', subtype: 'success', result: 'Progress only, not the final assistant answer.' });
  assert.equal(projection.summary().response, '');
  assert.equal(projection.partialText(), '');
  assert.ok(projection.snapshot().warnings.some((warning) => /No assistant message/.test(warning)));
});

test('Cursor supports the native nested tool ID without normalizing opaque characters', () => {
  const projection = createBackendProjection('cursor');
  const id = 'native/tool\nopaque';
  projection.accept({ type: 'tool_call', subtype: 'started', tool_call: { toolCallId: id, shellToolCall: { args: { command: 'pwd' } } } });
  projection.accept({ type: 'tool_call', subtype: 'completed', tool_call: { toolCallId: id, shellToolCall: { result: { success: { output: '/workspace' } } } } });
  projection.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
  projection.accept({ type: 'result', subtype: 'success' });
  assert.equal(projection.summary().toolCalls.length, 1);
  assert.equal(projection.summary().toolCalls[0].id, id);
  assert.equal(projection.summary().toolCalls[0].status, 'done');
});

test('AGY captures top-level init conversation before any response or tool', () => {
  const ids = [], p = createBackendProjection('agy', (id) => ids.push(id));
  p.accept({ event: 'init', conversation_id: 'early', init: { model: 'native' } });
  assert.deepEqual(ids, ['early']);
  p.accept({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } });
  assert.equal(p.summary().conversation_id, 'early');
});

test('provider invocation keeps sessions, permission profiles, model strings, and prompt boundaries separate', () => {
  const invoke = { workspace: '/tmp/work space', prompt: '--not-an-option', model: null, conversation: '00000000-0000-4000-8000-000000000001', unrestricted: true };
  const grok = buildInvocation('grok', invoke, { promptFile: '/tmp/task.md' }).args;
  assert.equal(grok[grok.indexOf('--cwd') + 1], invoke.workspace);
  const subdir = buildInvocation('grok', { ...invoke, cwd: '/tmp/work space/subdir' }).args;
  assert.equal(subdir[subdir.indexOf('--cwd') + 1], '/tmp/work space/subdir');
  assert.ok(grok.includes('--session-id')); assert.ok(!grok.includes('--resume'));
  assert.equal(grok[grok.indexOf('--permission-mode') + 1], 'bypassPermissions');
  for (const flag of ['--no-leader','--no-memory','--no-subagents']) assert.ok(grok.includes(flag));
  const follow = buildInvocation('grok', { ...invoke, isResume: true, unrestricted: false }, { mode: 'ask' }).args;
  assert.ok(follow.includes('--resume')); assert.ok(!follow.includes('--session-id'));
  assert.equal(follow[follow.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(follow[follow.indexOf('--tools') + 1], '');
  const cursor = buildInvocation('cursor', { ...invoke, model: 'native[effort=high]' }).args;
  const cursorSubdir = buildInvocation('cursor', { ...invoke, cwd: '/tmp/work space/subdir' }).args;
  assert.equal(cursorSubdir[cursorSubdir.indexOf('--workspace') + 1], '/tmp/work space/subdir');
  assert.ok(cursor.includes('--force') && cursor.includes('--trust'));
  assert.deepEqual(cursor.slice(-2), ['--', '--not-an-option']);
  const restricted = buildInvocation('cursor', { ...invoke, unrestricted: false, isResume: true }).args;
  assert.ok(!restricted.includes('--force') && restricted.includes('--resume'));
  assert.ok(!restricted.includes('--mode') && !restricted.includes('--stream-partial-output'));
  assert.throws(() => buildInvocation('cursor', invoke, { effort: 'high' }), { reason: 'unsupported_capability' });
  const fake = buildInvocation('grok', { ...invoke, binary: '/tmp/fake.mjs' });
  assert.equal(fake.binary, process.execPath); assert.equal(fake.args[0], '/tmp/fake.mjs');
});

test('cleanup policy retains native signal grace and unavailable inspection cannot confirm cancellation', async () => {
  assert.deepEqual(STOP_POLICIES.cursor, [{ signal: 'SIGINT', graceMs: 5000 }, { signal: 'SIGTERM', graceMs: 3000 }, { signal: 'SIGKILL', graceMs: 1000 }]);
  assert.equal((await stopExecution({ pid: 999999, born: 'old' }, [], () => null)).status, 'unverified');
  assert.equal((await stopExecution({ pid: 999999, born: 'old' }, [], () => [])).status, 'confirmed');
});
