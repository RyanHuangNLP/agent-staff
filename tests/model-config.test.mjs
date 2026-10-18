import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, FAKE_AGY, jobIdOf } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests/fake-coding-agent.mjs');
const backends = ['agy', 'grok', 'cursor', 'codex'];
const configFile = (sb, backend) => path.join(sb.repo, `.${backend}-staff/config.json`);
const saved = (sb, backend) => JSON.parse(fs.readFileSync(configFile(sb, backend), 'utf8'));
const modelA = backend => backend === 'agy' ? 'gemini-3.8-flash-low' : 'native-model-a';
const modelB = backend => backend === 'agy' ? 'gemini-3.1-pro-high' : 'native-model-b';

function fixture(t, label) {
  const sb = sandbox(`model-config-${label}`);
  sb.calls = path.join(sb.root, 'native.jsonl');
  t.after(() => fs.rmSync(sb.root, { recursive: true, force: true }));
  return sb;
}
function run(sb, backend, args, { extraEnv = {}, entry, cwd = sb.repo } = {}) {
  const result = spawnSync(process.execPath, [entry || path.join(ROOT, `bin/${backend}-staff.mjs`), ...args], {
    cwd, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home,
      CODEX_HOME: path.join(sb.home, '.codex'), AGENT_STAFF_BACKEND: backend,
      AGY_BIN: FAKE_AGY, GROK_BIN: FAKE, CURSOR_BIN: FAKE, CODEX_BIN: FAKE,
      FAKE_AGY_ARGV_FILE: sb.argvFile, FAKE_CODING_CALLS: sb.calls, ...extraEnv },
  });
  assert.ifError(result.error);
  return result;
}
function ok(sb, backend, args, options) {
  const result = run(sb, backend, args, options);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}
const json = (sb, backend, args, options) => JSON.parse(ok(sb, backend, args, options).stdout);
function calls(sb, backend) {
  const file = backend === 'agy' ? sb.argvFile : sb.calls;
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => { const record = JSON.parse(line); return backend === 'agy' ? record : record.argv; }) : [];
}
const value = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const effort = (args, backend) => backend === 'codex'
  ? JSON.parse(args.find(arg => arg.startsWith('model_reasoning_effort='))?.slice('model_reasoning_effort='.length) || 'null')
  : value(args, '--reasoning-effort');

for (const backend of backends) {
  test(`${backend}: saved project choice applies to tasks; one-off flags do not rewrite it`, t => {
    const sb = fixture(t, `${backend}-save`);
    const first = json(sb, backend, ['config']);
    assert.equal(first.configured, false);
    assert.equal(fs.existsSync(configFile(sb, backend)), false);
    const flags = ['config', '--model', modelA(backend)];
    if (['grok', 'codex'].includes(backend)) flags.push('--effort', 'low');
    assert.equal(json(sb, backend, flags).configured, true);
    assert.equal(calls(sb, backend).length, 0, 'configuration must not start the native CLI');
    const original = saved(sb, backend);
    ok(sb, backend, ['ask', '--prompt', 'Use the saved choice']);
    assert.equal(value(calls(sb, backend).at(-1), '--model'), modelA(backend));
    if (['grok', 'codex'].includes(backend)) assert.equal(effort(calls(sb, backend).at(-1), backend), 'low');
    const override = ['ask', '--model', modelB(backend), '--prompt', 'Only this task'];
    if (['grok', 'codex'].includes(backend)) override.push('--effort', 'high');
    ok(sb, backend, override);
    assert.equal(value(calls(sb, backend).at(-1), '--model'), modelB(backend));
    assert.deepEqual(saved(sb, backend), original);
    ok(sb, backend, ['ask', '--model', 'default', '--effort', 'default', '--prompt', 'Use original defaults once']);
    assert.equal(value(calls(sb, backend).at(-1), '--model'), backend === 'agy' ? 'gemini-3.8-flash-low' : null);
    if (['grok', 'codex'].includes(backend)) assert.equal(effort(calls(sb, backend).at(-1), backend), null);
    assert.deepEqual(saved(sb, backend), original);
  });

  test(`${backend}: changed defaults affect new tasks, while continuations retain their choice`, t => {
    const sb = fixture(t, `${backend}-continue`);
    ok(sb, backend, ['config', '--model', modelA(backend)]);
    ok(sb, backend, ['ask', '--prompt', 'Start conversation']);
    ok(sb, backend, ['config', '--model', modelB(backend)]);
    ok(sb, backend, ['continue', '--prompt', 'Keep the same conversation']);
    assert.equal(value(calls(sb, backend).at(-1), '--model'), modelA(backend));
    ok(sb, backend, ['continue', '--model', modelB(backend), '--prompt', 'Change this conversation explicitly']);
    assert.equal(value(calls(sb, backend).at(-1), '--model'), modelB(backend));
    ok(sb, backend, ['ask', '--prompt', 'A new task uses the updated project choice']);
    assert.equal(value(calls(sb, backend).at(-1), '--model'), modelB(backend));
    assert.equal(json(sb, backend, ['config']).defaults.model, modelB(backend));
  });

  test(`${backend}: native defaults can be remembered, updated, and reset without changing permission policy`, t => {
    const sb = fixture(t, `${backend}-reset`);
    ok(sb, backend, ['setup', '--restrict', 'review']);
    const choice = json(sb, backend, ['config', '--model', 'default', '--effort', 'default']);
    assert.equal(choice.configured, true);
    assert.deepEqual(choice.defaults, { model: null, effort: null });
    assert.deepEqual(saved(sb, backend).profiles, { review: 'restricted' });
    ok(sb, backend, ['config', '--model', modelA(backend)]);
    ok(sb, backend, ['setup', '--restrict', 'none']);
    assert.equal(json(sb, backend, ['config']).defaults.model, modelA(backend));
    ok(sb, backend, ['setup', '--restrict', 'research']);
    const reset = json(sb, backend, ['config', '--reset']);
    assert.equal(reset.configured, false);
    assert.deepEqual(saved(sb, backend), { profiles: { research: 'restricted' } });
    assert.equal(calls(sb, backend).length, 0);
  });
}

test('model defaults stay within their backend and project, including commands from subdirectories', t => {
  const sb = fixture(t, 'isolation');
  for (const backend of backends) ok(sb, backend, ['config', '--model', modelA(backend)]);
  const nested = path.join(sb.repo, 'nested'); fs.mkdirSync(nested);
  ok(sb, 'codex', ['config', '--model', modelB('codex')], { cwd: nested });
  for (const backend of backends) assert.equal(saved(sb, backend).defaults.model, backend === 'codex' ? modelB(backend) : modelA(backend));
  const other = path.join(sb.root, 'other'); fs.mkdirSync(other);
  assert.equal(json(sb, 'codex', ['config'], { cwd: other }).configured, false);
});

test('saved native-default null values outrank newer project settings when continuing', t => {
  const sb = fixture(t, 'null-inheritance');
  for (const backend of ['grok', 'cursor', 'codex']) {
    ok(sb, backend, ['ask', '--prompt', 'Start with native defaults']);
    const flags = ['config', '--model', modelA(backend)];
    if (backend !== 'cursor') flags.push('--effort', 'high');
    ok(sb, backend, flags);
    ok(sb, backend, ['continue', '--prompt', 'Preserve native defaults']);
    assert.equal(value(calls(sb, backend).at(-1), '--model'), null);
    if (backend !== 'cursor') assert.equal(effort(calls(sb, backend).at(-1), backend), null);
  }
});

test('partial effort edits preserve the selected model and existing conversation settings', t => {
  const sb = fixture(t, 'partial-effort');
  for (const backend of ['grok', 'codex']) {
    ok(sb, backend, ['config', '--model', modelA(backend), '--effort', 'low']);
    ok(sb, backend, ['ask', '--prompt', 'Original effort']);
    const updated = json(sb, backend, ['config', '--effort', 'high']);
    assert.deepEqual(updated.defaults, { model: modelA(backend), effort: 'high' });
    ok(sb, backend, ['continue', '--prompt', 'Inherit original effort']);
    assert.equal(effort(calls(sb, backend).at(-1), backend), 'low');
    ok(sb, backend, ['continue', '--effort', 'default', '--prompt', 'Clear only this effort']);
    assert.equal(effort(calls(sb, backend).at(-1), backend), null);
    ok(sb, backend, ['ask', '--prompt', 'Use project effort']);
    assert.equal(effort(calls(sb, backend).at(-1), backend), 'high');
  }
});

test('AGY effort-only changes keep the selected Gemini family', t => {
  const sb = fixture(t, 'agy-effort');
  ok(sb, 'agy', ['config', '--model', 'gemini-3.1-pro-low']);
  ok(sb, 'agy', ['ask', '--prompt', 'Original effort']);
  ok(sb, 'agy', ['config', '--effort', 'high']);
  ok(sb, 'agy', ['ask', '--prompt', 'Updated preference']);
  assert.equal(value(calls(sb, 'agy').at(-1), '--model'), 'gemini-3.1-pro-high');
  ok(sb, 'agy', ['continue', '--effort', 'low', '--prompt', 'Change just this conversation']);
  assert.equal(value(calls(sb, 'agy').at(-1), '--model'), 'gemini-3.1-pro-low');
  assert.equal(saved(sb, 'agy').defaults.effort, 'high');
});

test('invalid changes fail before model execution and preserve the last saved configuration', t => {
  const sb = fixture(t, 'invalid');
  ok(sb, 'cursor', ['config', '--model', 'native[effort=high]']);
  const original = fs.readFileSync(configFile(sb, 'cursor'), 'utf8');
  for (const args of [['config', '--effort', 'high'], ['config', '--reset', '--model', 'other'], ['config', '--prompt', 'not a task']]) {
    assert.equal(run(sb, 'cursor', args).status, 1);
    assert.equal(fs.readFileSync(configFile(sb, 'cursor'), 'utf8'), original);
  }
  assert.equal(run(sb, 'agy', ['config', '--effort', 'unsupported']).status, 1);
  assert.equal(run(sb, 'agy', ['config', '--model', 'pro', '--effort', 'medium']).status, 1);
  assert.equal(run(sb, 'agy', ['config', '--model', 'claude-sonnet-4-6', '--effort', 'high']).status, 1);
  assert.equal(calls(sb, 'cursor').length, 0);
  assert.equal(calls(sb, 'agy').length, 0);
  fs.writeFileSync(configFile(sb, 'cursor'), '{"defaults": []}');
  assert.equal(run(sb, 'cursor', ['ask', '--prompt', 'Must not run']).status, 1);
  assert.equal(calls(sb, 'cursor').length, 0);
});

test('background jobs and restarts retain the configuration captured at dispatch', t => {
  const sb = fixture(t, 'background');
  ok(sb, 'codex', ['config', '--model', modelA('codex'), '--effort', 'low']);
  const id = jobIdOf(ok(sb, 'codex', ['research', '--prompt', 'Background assignment']).stdout);
  ok(sb, 'codex', ['config', '--model', modelB('codex'), '--effort', 'high']);
  ok(sb, 'codex', ['wait', id, '--timeout', '10s']);
  assert.equal(value(calls(sb, 'codex').at(-1), '--model'), modelA('codex'));
  const restarted = jobIdOf(ok(sb, 'codex', ['restart', id]).stdout);
  ok(sb, 'codex', ['wait', restarted, '--timeout', '10s']);
  assert.equal(value(calls(sb, 'codex').at(-1), '--model'), modelA('codex'));
  assert.equal(effort(calls(sb, 'codex').at(-1), 'codex'), 'low');
});

test('each standalone plugin config entry pins its backend even in a nested worker environment', t => {
  const sb = fixture(t, 'entries');
  for (const backend of backends) {
    const entry = path.join(ROOT, backend === 'agy' ? 'companion/agy-entry.mjs' : `plugins/${backend}/companion/${backend}-companion.mjs`);
    const result = json(sb, backend, ['config', '--model', modelA(backend)], { entry, extraEnv: { AGENT_STAFF_BACKEND: backend === 'grok' ? 'codex' : 'grok' } });
    assert.equal(result.backend, backend);
    assert.equal(result.defaults.model, modelA(backend));
  }
});

test('native catalog discovery lists choices without starting tasks or propagating the internal backend selector', t => {
  const sb = fixture(t, 'catalog');
  const script = path.join(sb.root, 'catalog.mjs');
  fs.writeFileSync(script, `if (process.argv.slice(2).join(' ') !== 'models' || process.env.AGENT_STAFF_BACKEND) process.exit(99); console.log(process.env.CATALOG_OUTPUT);`);
  const outputs = { agy: 'gemini-3.8-flash-low\tGemini Flash Low', grok: 'Available models:\n  * native-grok (default)', cursor: 'Available models\nnative-cursor-high - Cursor High' };
  for (const backend of ['agy', 'grok', 'cursor']) {
    const result = json(sb, backend, ['models'], { extraEnv: { [`${backend.toUpperCase()}_BIN`]: script, CATALOG_OUTPUT: outputs[backend] } });
    assert.equal(result.source, 'native-cli');
    assert.equal(result.models.length, 1);
    assert.equal(fs.existsSync(path.join(sb.repo, `.${backend}-staff/state.json`)), false);
  }
});

test('Codex catalog exposes only model choices and advertised efforts, with a usable cache-missing result', t => {
  const sb = fixture(t, 'codex-catalog');
  const missing = json(sb, 'codex', ['models']);
  assert.equal(missing.source, 'unavailable');
  assert.deepEqual(missing.models, []);
  const cache = path.join(sb.home, '.codex/models_cache.json');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ identity: 'PRIVATE_IDENTITY', models: [
    { slug: 'visible', display_name: 'Visible', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }], default_reasoning_level: 'low', instructions: 'PRIVATE_INSTRUCTIONS' },
    { slug: 'hidden', visibility: 'hide' },
  ] }));
  const result = ok(sb, 'codex', ['models']);
  assert.doesNotMatch(result.stdout, /PRIVATE_|hidden/);
  assert.deepEqual(JSON.parse(result.stdout).models, [{ id: 'visible', name: 'Visible', efforts: ['low', 'xhigh'], default_effort: 'low' }]);
  assert.equal(calls(sb, 'codex').length, 0);
});
