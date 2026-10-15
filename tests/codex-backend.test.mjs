import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInvocation, createBackendProjection } from '../companion/backend-adapters.mjs';
import { codexCompatibilityArgs, codexReviewSchema } from '../companion/codex-backend.mjs';
import { createParser } from '../companion/observation.mjs';
import { sandbox, jobIdOf } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fake = path.join(root, 'tests/fake-coding-agent.mjs');
const session = '00000000-0000-4000-8000-000000000001';
const thread = { type: 'thread.started', thread_id: session };
const answer = text => ({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } });
const done = { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 2 } };

test('Codex sends task bytes through stdin and scopes native options to fresh and explicit resumed sessions', () => {
  const invoke = { prompt: '--model not-a-flag\n中文', cwd: '/tmp/work space/nested', workspace: '/tmp/work space', model: null, unrestricted: false };
  const first = buildInvocation('codex', invoke);
  assert.equal(first.input, invoke.prompt);
  assert.equal(first.args.includes(invoke.prompt), false);
  assert.equal(first.args.at(-1), '-');
  assert.equal(first.args.includes('--model'), false);
  assert.equal(first.args.includes('--last'), false);
  assert.equal(first.args[first.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(first.args.includes('approval_policy="never"'));

  const resumed = buildInvocation('codex', { ...invoke, model: 'native-model', effort: 'high', unrestricted: true, isResume: true, conversation: session, jsonSchema: '{}' }, { schemaFile: '/tmp/review schema.json' });
  assert.deepEqual(resumed.args.slice(-3), ['resume', session, '-']);
  for (const flag of ['--cd', '--model', '--output-schema']) assert.ok(resumed.args.indexOf(flag) < resumed.args.indexOf('resume'));
  assert.equal(resumed.args[resumed.args.indexOf('--cd') + 1], invoke.cwd);
  assert.ok(resumed.args.includes('model_reasoning_effort="high"'));
  assert.ok(resumed.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(resumed.args.includes('--sandbox'), false);
  assert.throws(() => buildInvocation('codex', { ...invoke, isResume: true }), { reason: 'invalid_session' });
  assert.throws(() => buildInvocation('codex', { ...invoke, jsonSchema: '{}' }), { reason: 'unsupported_capability' });
});

test('Codex schema closes nested objects while keeping all shared review fields and types', () => {
  const original = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, file: { type: 'string' } }, required: ['title'] } } }, required: ['findings'] };
  const strict = JSON.parse(codexReviewSchema(JSON.stringify(original)));
  assert.equal(strict.additionalProperties, false);
  assert.equal(strict.properties.findings.items.additionalProperties, false);
  assert.deepEqual(strict.properties.findings.items.required, ['title', 'file']);
  assert.deepEqual(strict.properties.findings.items.properties, original.properties.findings.items.properties);
  assert.deepEqual(original.properties.findings.items.required, ['title']);
});

test('Codex compatibility override preserves files and applies only to the incompatible desktop table', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-compat-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'config.toml');
  assert.deepEqual(codexCompatibilityArgs(config), []);
  for (const content of ['[features]\ncontext_management = true\n', '# [features.context_management]\n']) {
    fs.writeFileSync(config, content);
    assert.deepEqual(codexCompatibilityArgs(config), []);
    assert.equal(fs.readFileSync(config, 'utf8'), content);
  }
  const content = 'model = "keep-native-model"\n[features.context_management]\nexperimental_mode = true\n';
  fs.writeFileSync(config, content);
  assert.deepEqual(codexCompatibilityArgs(config), ['-c', 'features.context_management=false']);
  assert.equal(fs.readFileSync(config, 'utf8'), content);
});

test('Codex JSONL handles split UTF-8, captures the early thread ID, and returns only the last complete answer', () => {
  const ids = [], projection = createBackendProjection('codex', id => ids.push(id));
  const events = [thread, { type: 'turn.started' }, answer('Earlier progress'),
    { type: 'item.completed', item: { id: 'private', type: 'reasoning', text: 'PRIVATE_REASONING' } },
    { type: 'item.completed', item: { id: 'commentary', type: 'agent_message', phase: 'commentary', text: 'COMMENTARY' } },
    { type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'INCOMPLETE' } },
    answer('最终答案 🧪'), done];
  const parser = createParser(projection.accept, projection.warn);
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n'));
  for (let i = 0; i < bytes.length; i += 7) parser.write(bytes.subarray(i, i + 7));
  parser.end();
  assert.deepEqual(ids, [session]);
  assert.equal(projection.summary().response, '最终答案 🧪');
  assert.equal(projection.summary().status, 'SUCCESS');
  assert.equal(projection.summary().model, null);
  assert.deepEqual(projection.summary().usage, done.usage);
  assert.equal(projection.snapshot().latest_text.incomplete, false);
  assert.deepEqual(projection.snapshot().warnings, []);
});

test('Codex tool updates retain command failures, MCP permission denials, and opaque IDs without replacing the answer', () => {
  const projection = createBackendProjection('codex');
  projection.accept(thread);
  for (const type of ['item.started', 'item.completed']) projection.accept({ type, item: { id: 'cmd\n1', type: 'command_execution', command: 'verify', status: type === 'item.started' ? 'in_progress' : 'completed', exit_code: type === 'item.started' ? null : 1, aggregated_output: 'verification failed' } });
  projection.accept({ type: 'item.completed', item: { id: 'mcp-1', type: 'mcp_tool_call', server: 'local', tool: 'write', arguments: { path: 'protected.txt' }, status: 'failed', error: { message: 'Permission denied by policy' } } });
  projection.accept({ type: 'item.completed', item: { id: 'edit-1', type: 'file_change', changes: [{ path: 'file.txt', kind: 'update' }], status: 'completed' } });
  projection.accept({ type: 'item.completed', item: { id: 'web-1', type: 'web_search', query: 'fixture' } });
  projection.accept(answer('The verification failed and the write was denied.'));
  projection.accept(done);
  const result = projection.summary();
  assert.equal(result.status, 'SUCCESS', 'a completed turn still requires the caller to assess tool outcomes');
  assert.equal(result.toolCalls.length, 4, 'start/completion must update one call, not count twice');
  assert.equal(result.toolCalls[0].id, 'cmd\n1');
  assert.equal(result.toolCalls[0].status, 'error');
  assert.equal(result.permissionDenials.length, 1);
  assert.equal(result.permissionDenials[0].tool, 'local/write');
  assert.equal(result.toolCalls[2].status, 'done');
  assert.ok(projection.snapshot().warnings.some(value => value.includes('permission policy')));
});

test('Codex failed, missing-terminal, missing-session and commentary-only streams cannot manufacture successful answers', () => {
  const failed = createBackendProjection('codex');
  [thread, answer('Partial'), { type: 'turn.failed', error: { message: 'quota fixture' } }].forEach(failed.accept);
  assert.equal(failed.summary().status, 'ERROR');
  assert.equal(failed.summary().reason, 'backend_error');
  assert.equal(failed.partialText(), 'Partial');
  const incomplete = createBackendProjection('codex');
  [thread, answer('Unfinished')].forEach(incomplete.accept);
  assert.equal(incomplete.summary(), null);
  const noSession = createBackendProjection('codex');
  [answer('No identity'), done].forEach(noSession.accept);
  assert.equal(noSession.summary().reason, 'protocol_error');
  const onlyProgress = createBackendProjection('codex');
  [thread, { type: 'item.completed', item: { type: 'agent_message', phase: 'commentary', text: 'Still working' } }, done].forEach(onlyProgress.accept);
  assert.equal(onlyProgress.summary().response, '');
});

test('Codex recovered connection errors stay visible without overriding a successful terminal turn', () => {
  const projection = createBackendProjection('codex');
  [thread, { type: 'error', message: 'Reconnecting 1/5' }, answer('Recovered'), done].forEach(projection.accept);
  assert.equal(projection.summary().status, 'SUCCESS');
  assert.match(projection.snapshot().warnings[0], /Reconnecting/);
  assert.throws(() => projection.accept({ type: 'thread.started', thread_id: 'different' }), { reason: 'protocol_error' });
});

test('Codex observation bounds tool history and unknown-event diagnostics while keeping the complete final text', () => {
  const projection = createBackendProjection('codex');
  projection.accept(thread);
  for (let i = 0; i < 510; i++) projection.accept({ type: 'item.completed', item: { id: `call-${i}`, type: 'command_execution', command: 'x'.repeat(500), status: 'completed', exit_code: 0 } });
  projection.accept({ type: 'item.completed', item: { type: 'future_item', text: 'MUST_NOT_BE_ANSWER' } });
  const text = '中文'.repeat(4000);
  [answer(text), done].forEach(projection.accept);
  assert.equal(projection.summary().response, text);
  assert.equal(projection.summary().toolCalls.length, 500);
  assert.equal(projection.snapshot().recent_activities.length, 5);
  assert.equal(projection.snapshot().latest_text.truncated, true);
  assert.ok(projection.snapshot().warnings.length <= 5);
});

function fixture(t, label, { git = true } = {}) {
  const sb = sandbox(`codex-${label}`, { git });
  sb.calls = path.join(sb.root, 'calls.jsonl');
  sb.env = { ...process.env, HOME: sb.home, USERPROFILE: sb.home, CODEX_HOME: path.join(sb.home, '.codex'), CODEX_BIN: fake, AGENT_STAFF_BACKEND: 'codex', FAKE_CODING_CALLS: sb.calls };
  sb.run = (args, extra = {}, entry = path.join(root, 'bin/codex-staff.mjs')) => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: sb.repo, env: { ...sb.env, ...extra }, encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    return result;
  };
  sb.state = () => JSON.parse(fs.readFileSync(path.join(sb.repo, '.codex-staff/state.json'), 'utf8'));
  sb.records = () => fs.readFileSync(sb.calls, 'utf8').trim().split('\n').map(JSON.parse);
  t.after(() => {
    if (fs.existsSync(path.join(sb.repo, '.codex-staff/state.json'))) for (const job of sb.state().jobs) if (job.status === 'running') sb.run(['cancel', job.id]);
    fs.rmSync(sb.root, { recursive: true, force: true });
  });
  return sb;
}

test('Codex foreground ask accepts long literal prompts through stdin in a non-Git directory', t => {
  const sb = fixture(t, 'long-stdin', { git: false });
  const prompt = '--backend grok --model quoted "$()" 中文\n' + 'a'.repeat(180 * 1024);
  const file = path.join(sb.root, 'long prompt.txt');
  fs.writeFileSync(file, prompt);
  const result = sb.run(['ask', '--prompt-file', file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), 'codex answer 中文');
  assert.ok(sb.records()[0].prompt.includes(prompt));
  assert.ok(sb.records()[0].argv.includes('--skip-git-repo-check'));
  assert.equal(sb.records()[0].argv.some(value => value.includes(prompt)), false);
  assert.equal(sb.state().jobs.length, 0);
});

test('Codex startup failures preserve native diagnosis even when stdin closes before a long prompt is written', t => {
  const sb = fixture(t, 'early-stdin-close');
  const file = path.join(sb.root, 'prompt.txt');
  fs.writeFileSync(file, 'a'.repeat(180 * 1024));
  const result = sb.run(['ask', '--prompt-file', file], { FAKE_CODING_SCENARIO: 'startup_error' });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /FAKE_NATIVE_STARTUP_ERROR/);
  assert.match(result.stderr, /Diagnostics:/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});

test('Codex applies the config compatibility override without changing global settings or the native model default', t => {
  const sb = fixture(t, 'desktop-config');
  fs.mkdirSync(sb.env.CODEX_HOME);
  const config = path.join(sb.env.CODEX_HOME, 'config.toml');
  const content = 'model = "user-default"\n[features.context_management]\nexperimental_mode = true\n';
  fs.writeFileSync(config, content);
  const result = sb.run(['ask', '--prompt', 'fixture']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(sb.records()[0].argv.includes('features.context_management=false'));
  assert.equal(sb.records()[0].argv.includes('--ignore-user-config'), false);
  assert.equal(sb.records()[0].argv.includes('--model'), false);
  assert.equal(fs.readFileSync(config, 'utf8'), content);
});

test('Codex rejects success without a thread ID and a nonzero native exit, but accepts a recovered connection', t => {
  const sb = fixture(t, 'terminal-status');
  for (const [scenario, expected, reason] of [['missing_session', 3, 'protocol_error'], ['nonzero_exit', 3, 'backend_exit'], ['recovered_error', 0, undefined]]) {
    const started = sb.run(['staffer', '--prompt', scenario], { FAKE_CODING_SCENARIO: scenario });
    assert.equal(started.status, 0, started.stderr);
    const id = jobIdOf(started.stdout);
    const result = sb.run(['wait', id, '--timeout', '12s']);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    const job = sb.state().jobs.find(item => item.id === id);
    assert.equal(job.reason, reason);
    assert.equal(job.status, expected ? 'error' : 'done');
    if (scenario === 'recovered_error') assert.equal(job.warnings, true);
  }
});

test('Codex standalone plugin runtime completes ask, background work, and exact-session continuation', t => {
  const sb = fixture(t, 'standalone');
  const plugin = path.join(sb.root, 'installed-plugin');
  fs.cpSync(path.join(root, 'plugins/codex'), plugin, { recursive: true });
  const entry = path.join(plugin, 'companion/codex-companion.mjs');
  const asked = sb.run(['ask', '--prompt', 'installed ask'], {}, entry);
  assert.equal(asked.status, 0, asked.stdout + asked.stderr);
  const started = sb.run(['staffer', '--prompt', 'installed task'], {}, entry);
  assert.equal(started.status, 0, started.stderr);
  const id = jobIdOf(started.stdout);
  assert.equal(sb.run(['wait', id, '--timeout', '12s'], {}, entry).status, 0);
  const session = sb.state().jobs.find(item => item.id === id).conversation_id;
  const next = sb.run(['continue', '--job', id, '--prompt', 'installed continuation'], {}, entry);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(sb.run(['wait', jobIdOf(next.stdout), '--timeout', '12s'], {}, entry).status, 0);
  assert.equal(sb.records().at(-1).session, session);
});
