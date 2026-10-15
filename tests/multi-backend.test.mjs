import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, jobIdOf } from './helpers.mjs';
import { processIdentity } from '../companion/stream-worker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'bin', 'agent-staff.mjs');
const FAKE = path.join(ROOT, 'tests', 'fake-coding-agent.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = (sb, backend) => path.join(sb.repo, `.${backend}-staff`);
const state = (sb, backend) => JSON.parse(fs.readFileSync(path.join(directory(sb, backend), 'state.json'), 'utf8'));
const job = (sb, backend, id) => state(sb, backend).jobs.find(item => item.id === id);
const calls = sb => fs.existsSync(sb.calls) ? fs.readFileSync(sb.calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const arg = (call, flag) => { const i = call.argv.indexOf(flag); return i < 0 ? undefined : call.argv[i + 1]; };
const resumedSession = call => arg(call, call.backend === 'codex' ? 'resume' : '--resume');
const effortOf = call => call.backend === 'codex'
  ? JSON.parse(call.argv.find(value => value.startsWith('model_reasoning_effort='))?.split('=').slice(1).join('=') || 'null')
  : arg(call, '--reasoning-effort');
const unrestrictedFlag = backend => backend === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--force';

function fixture(label) {
  const sb = sandbox(`multi-${label}`);
  sb.calls = path.join(sb.root, 'native-calls.jsonl');
  return sb;
}

function environment(sb, backend, extra = {}) {
  return { ...process.env, HOME: sb.home, USERPROFILE: sb.home,
    AGENT_STAFF_BACKEND: backend, GROK_BIN: FAKE, CURSOR_BIN: FAKE, CODEX_BIN: FAKE,
    CODEX_HOME: path.join(sb.home, '.codex'),
    CURSOR_AGENT_BIN: FAKE, FAKE_CODING_CALLS: sb.calls, ...extra };
}

function run(sb, backend, argv, extra = {}, { alias = false, flagAfter = false, input } = {}) {
  const entry = alias ? path.join(ROOT, 'bin', `${backend}-staff.mjs`) : MAIN;
  const selected = alias ? argv : flagAfter ? [...argv, '--backend', backend] : ['--backend', backend, ...argv];
  const result = spawnSync(process.execPath, [entry, ...selected], {
    cwd: sb.repo, env: environment(sb, backend, extra), input,
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function dispatch(sb, backend, argv, extra = {}, options) {
  const result = run(sb, backend, argv, extra, options);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return jobIdOf(result.stdout);
}

function collect(sb, backend, id) {
  return run(sb, backend, ['wait', id, '--timeout', '12s']);
}

async function until(predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  assert.ok(predicate(), `Timed out waiting for ${label}`);
}

function isRunning(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 && !!result.stdout.trim() && !result.stdout.trim().startsWith('Z');
}

function cleanup(t, sb, backend) {
  t.after(() => {
    if (!fs.existsSync(path.join(directory(sb, backend), 'state.json'))) return;
    for (const item of state(sb, backend).jobs || []) {
      if (item.status === 'running') run(sb, backend, ['cancel', item.id]);
    }
  });
}

for (const backend of ['grok', 'cursor', 'codex']) {
  test(`${backend}: all tool personas retain background/unrestricted defaults and backend state`, t => {
    const sb = fixture(`${backend}-roles`);
    cleanup(t, sb, backend);
    for (const mode of ['staffer', 'research', 'review', 'implement']) {
      const id = dispatch(sb, backend, [mode, '--prompt', `Bounded ${mode} fixture`]);
      const result = collect(sb, backend, id);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`${backend} answer 中文`));
      const saved = job(sb, backend, id);
      assert.equal(saved.backend, backend);
      assert.equal(saved.mode, mode);
      assert.equal(saved.profile, 'unrestricted');
      assert.equal(saved.status, 'done');
      const native = calls(sb).at(-1);
      assert.equal(arg(native, '--model'), undefined, 'new backends use their own native model default');
      if (backend === 'grok') {
        assert.equal(arg(native, '--permission-mode'), 'bypassPermissions');
        assert.equal(arg(native, '--output-format'), 'streaming-json');
        for (const flag of ['--no-leader', '--no-memory', '--no-subagents']) assert.ok(native.argv.includes(flag), flag);
        assert.equal(arg(native, '--session-id'), saved.conversation_id);
      } else if (backend === 'codex') {
        assert.ok(native.argv.includes('--dangerously-bypass-approvals-and-sandbox'));
        assert.ok(native.argv.includes('--json'));
        assert.ok(native.argv.includes('approval_policy="never"'));
        assert.equal(native.argv.at(-1), '-');
        assert.equal(native.argv.includes(native.prompt), false, 'Codex task goes through stdin, never argv');
        assert.equal(result.stdout.includes('CODEX_PROGRESS_ONLY'), false);
      } else {
        assert.ok(native.argv.includes('--force'));
        assert.ok(native.argv.includes('--trust'));
        assert.equal(arg(native, '--output-format'), 'stream-json');
        assert.ok(!native.argv.includes('--stream-partial-output'));
        assert.ok(!result.stdout.includes('CURSOR_PROGRESS_ONLY'));
      }
      assert.ok(!result.stdout.includes('PRIVATE_THINKING_SENTINEL'));
    }
    assert.ok(!fs.existsSync(path.join(sb.repo, '.agy-staff')));
  });

  test(`${backend}: alias ask stays foreground/restricted and never parses prompt text as backend flags`, () => {
    const sb = fixture(`${backend}-ask`);
    const prompt = 'Explain the literal text --backend agy without treating it as an option. 中文';
    const result = run(sb, backend, ['ask', '--prompt', prompt], {}, { alias: true });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), `${backend} answer 中文`);
    assert.equal(state(sb, backend).jobs.length, 0, 'foreground ask must not invent a background job');
    const native = calls(sb).at(-1);
    assert.ok(native.prompt.includes(prompt));
    if (backend === 'grok') {
      assert.equal(arg(native, '--permission-mode'), 'dontAsk');
      assert.equal(arg(native, '--tools'), '');
      assert.ok(native.argv.includes('--disable-web-search'));
    } else {
      assert.ok(!native.argv.includes(unrestrictedFlag(backend)));
      if (backend === 'codex') assert.equal(arg(native, '--sandbox'), 'read-only');
    }

    const denied = run(sb, backend, ['ask', '--backend', backend === 'grok' ? 'cursor' : 'grok', '--prompt', 'must not launch'], {}, { alias: true });
    assert.equal(denied.code, 1);
    assert.equal(calls(sb).length, 1, 'conflicting alias must reject before native execution');
  });

  test(`${backend}: explicit and implicit continuations retain selected configuration and accept explicit overrides`, t => {
    const sb = fixture(`${backend}-continue`);
    cleanup(t, sb, backend);
    const subdir = path.join(sb.repo, 'nested');
    fs.mkdirSync(subdir);
    const nested = { ...sb, repo: subdir };
    const firstFlags = ['research', '--restricted', '--model', 'model-one', '--prompt', 'first task'];
    if (backend !== 'cursor') firstFlags.push('--effort', 'low');
    const first = dispatch(nested, backend, firstFlags, {}, { flagAfter: true });
    assert.equal(collect(sb, backend, first).code, 0);
    const conversation = job(sb, backend, first).conversation_id;

    const changedFlags = ['continue', '--job', first, '--unrestricted', '--model', 'model-two', '--prompt', 'new explicit settings'];
    if (backend !== 'cursor') changedFlags.push('--effort', 'high');
    const second = dispatch(sb, backend, changedFlags);
    assert.equal(collect(sb, backend, second).code, 0);
    assert.equal(job(sb, backend, second).model, 'model-two');
    assert.equal(job(sb, backend, second).profile, 'unrestricted');
    assert.equal(job(sb, backend, second).parent_job_id, first);
    assert.equal(calls(sb).at(-1).cwd, fs.realpathSync(subdir));
    assert.equal(resumedSession(calls(sb).at(-1)), conversation);

    const third = dispatch(sb, backend, ['continue', '--job', first, '--prompt', 'inherit the selected earlier job']);
    assert.equal(collect(sb, backend, third).code, 0);
    assert.equal(job(sb, backend, third).model, 'model-one');
    assert.equal(job(sb, backend, third).profile, 'restricted');
    if (backend !== 'cursor') assert.equal(effortOf(calls(sb).at(-1)), 'low');

    const fourth = dispatch(sb, backend, ['research', '--continue', '--prompt', 'same-mode implicit follow-up']);
    assert.equal(run(sb, backend, ['wait', '--timeout', '12s']).code, 0);
    assert.equal(job(sb, backend, fourth).conversation_id, conversation);
    assert.equal(job(sb, backend, fourth).model, 'model-one');
    const fifth = dispatch(sb, backend, ['continue', '--conversation', conversation, '--prompt', 'explicit conversation follow-up']);
    assert.equal(collect(sb, backend, fifth).code, 0);
    const sixth = dispatch(sb, backend, ['continue', '--prompt', 'latest conversation follow-up']);
    assert.equal(collect(sb, backend, sixth).code, 0);
    assert.equal(job(sb, backend, sixth).conversation_id, conversation);
    assert.equal(run(sb, backend, ['result']).code, 0);
    assert.equal(JSON.parse(run(sb, backend, ['observe']).stdout).job_id, sixth);
  });

  test(`${backend}: cross-role --conversation inherits session model and profile`, t => {
    const sb = fixture(`${backend}-cross-role`);
    cleanup(t, sb, backend);
    const firstFlags = ['research', '--restricted', '--model', 'model-one', '--prompt', 'restricted research'];
    if (backend !== 'cursor') firstFlags.push('--effort', 'low');
    const first = dispatch(sb, backend, firstFlags);
    assert.equal(collect(sb, backend, first).code, 0);
    const conversation = job(sb, backend, first).conversation_id;
    const second = dispatch(sb, backend, ['implement', '--conversation', conversation, '--prompt', 'same session, new role']);
    assert.equal(collect(sb, backend, second).code, 0);
    const saved = job(sb, backend, second);
    assert.equal(saved.conversation_id, conversation);
    assert.equal(saved.model, 'model-one');
    assert.equal(saved.profile, 'restricted');
    assert.equal(saved.profileSource, 'inherited');
    const native = calls(sb).at(-1);
    assert.equal(arg(native, '--model'), 'model-one');
    if (backend === 'grok') {
      assert.equal(saved.effort, 'low');
      assert.equal(arg(native, '--permission-mode'), 'dontAsk');
      assert.equal(arg(native, '--reasoning-effort'), 'low');
    } else {
      assert.equal(native.argv.includes(unrestrictedFlag(backend)), false);
      if (backend === 'codex') {
        assert.equal(saved.effort, 'low');
        assert.equal(effortOf(native), 'low');
        assert.equal(arg(native, '--sandbox'), 'read-only');
      }
    }
    const overrideFlags = ['implement', '--conversation', conversation, '--unrestricted', '--model', 'model-two', '--prompt', 'explicit override'];
    if (backend !== 'cursor') overrideFlags.push('--effort', 'high');
    const third = dispatch(sb, backend, overrideFlags);
    assert.equal(collect(sb, backend, third).code, 0);
    assert.equal(job(sb, backend, third).model, 'model-two');
    assert.equal(job(sb, backend, third).profile, 'unrestricted');
    assert.equal(job(sb, backend, third).profileSource, 'flag');
  });

  test(`${backend}: a newer ask config outranks an older background job unless continue --job selects it`, t => {
    const sb = fixture(`${backend}-config-precedence`);
    cleanup(t, sb, backend);
    const researchFlags = ['research', '--unrestricted', '--model', 'model-one', '--prompt', 'first model'];
    if (backend !== 'cursor') researchFlags.push('--effort', 'low');
    const first = dispatch(sb, backend, researchFlags);
    assert.equal(collect(sb, backend, first).code, 0);
    const conversation = job(sb, backend, first).conversation_id;
    const askFlags = ['ask', '--conversation', conversation, '--restricted', '--model', 'model-two', '--prompt', 'switch model'];
    if (backend !== 'cursor') askFlags.push('--effort', 'high');
    const asked = run(sb, backend, askFlags);
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    const savedConfig = state(sb, backend).conversation_configs[conversation];
    assert.equal(savedConfig.model, 'model-two');
    assert.equal(savedConfig.profile, 'restricted');
    if (backend !== 'cursor') assert.equal(savedConfig.effort, 'high');
    const second = dispatch(sb, backend, ['implement', '--conversation', conversation, '--prompt', 'use the latest session config']);
    assert.equal(collect(sb, backend, second).code, 0);
    const saved = job(sb, backend, second);
    assert.equal(saved.conversation_id, conversation);
    assert.equal(saved.model, 'model-two');
    assert.equal(saved.profile, 'restricted');
    assert.equal(saved.profileSource, 'inherited');
    const native = calls(sb).at(-1);
    assert.equal(arg(native, '--model'), 'model-two');
    if (backend === 'grok') {
      assert.equal(saved.effort, 'high');
      assert.equal(arg(native, '--permission-mode'), 'dontAsk');
      assert.equal(arg(native, '--reasoning-effort'), 'high');
    } else {
      assert.equal(native.argv.includes(unrestrictedFlag(backend)), false);
      if (backend === 'codex') {
        assert.equal(saved.effort, 'high');
        assert.equal(effortOf(native), 'high');
        assert.equal(arg(native, '--sandbox'), 'read-only');
      }
    }
    const pinned = dispatch(sb, backend, ['continue', '--job', first, '--prompt', 'selected job config']);
    assert.equal(collect(sb, backend, pinned).code, 0);
    assert.equal(job(sb, backend, pinned).model, 'model-one');
    assert.equal(job(sb, backend, pinned).profile, 'unrestricted');
    const selected = calls(sb).at(-1);
    if (backend === 'grok') {
      assert.equal(job(sb, backend, pinned).effort, 'low');
      assert.equal(arg(selected, '--permission-mode'), 'bypassPermissions');
      assert.equal(arg(selected, '--reasoning-effort'), 'low');
    } else {
      assert.equal(selected.argv.includes(unrestrictedFlag(backend)), true);
      if (backend === 'codex') assert.equal(effortOf(selected), 'low');
    }
  });

  test(`${backend}: the first ask occupies the session once its id is known`, async t => {
    const sb = fixture(`${backend}-ask-first-occupy`);
    const release = path.join(sb.root, 'ask-release');
    const child = spawn(process.execPath, [MAIN, '--backend', backend, 'ask', '--prompt', 'first session'], {
      cwd: sb.repo, env: environment(sb, backend, { FAKE_CODING_RELEASE: release }), windowsHide: true,
    });
    let stdout = '', stderr = '', closed = null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => { closed = code; });
    t.after(() => {
      try { fs.writeFileSync(release, 'go'); } catch {}
      if (closed === null) child.kill('SIGKILL');
    });
    await until(() => {
      try {
        const held = state(sb, backend).foreground_sessions;
        return calls(sb).length === 1 && held && Object.keys(held).length === 1;
      } catch { return false; }
    }, 'first-ask occupancy');
    const conversation = Object.keys(state(sb, backend).foreground_sessions)[0];
    assert.equal(state(sb, backend).last.id, conversation);
    const overlap = run(sb, backend, ['ask', '--continue', '--prompt', 'must not enter']);
    assert.equal(overlap.code, 1, overlap.stdout + overlap.stderr);
    assert.match(overlap.stderr, new RegExp(`conversation ${conversation} is still in use by a foreground ask call`));
    assert.equal(calls(sb).length, 1);
    fs.writeFileSync(release, 'go');
    await until(() => closed === 0, 'first ask finished');
    assert.equal(stdout.trim(), `${backend} answer 中文`);
    assert.equal(state(sb, backend).foreground_sessions, undefined);
    const after = run(sb, backend, ['ask', '--continue', '--prompt', 'session is free']);
    assert.equal(after.code, 0, after.stdout + after.stderr);
    assert.equal(calls(sb).length, 2);
    assert.equal(calls(sb).at(-1).session, conversation);
    assert.equal(stderr.includes('still in use'), false);
  });

  test(`${backend}: a foreground ask occupies its session until the call returns`, async t => {
    const sb = fixture(`${backend}-ask-occupy`);
    const release = path.join(sb.root, 'ask-release');
    const seed = run(sb, backend, ['ask', '--prompt', 'seed the session']);
    assert.equal(seed.code, 0, seed.stdout + seed.stderr);
    const conversation = state(sb, backend).last.id;
    assert.equal(state(sb, backend).jobs?.length || 0, 0);
    const before = calls(sb).length;
    const child = spawn(process.execPath, [MAIN, '--backend', backend, 'ask', '--conversation', conversation, '--prompt', 'hold the session'], {
      cwd: sb.repo, env: environment(sb, backend, { FAKE_CODING_RELEASE: release }), windowsHide: true,
    });
    let stdout = '', stderr = '', closed = null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => { closed = code; });
    t.after(() => {
      try { fs.writeFileSync(release, 'go'); } catch {}
      if (closed === null) child.kill('SIGKILL');
    });
    await until(() => calls(sb).length === before + 1 && state(sb, backend).foreground_sessions?.[conversation], 'foreground occupancy');
    const overlap = run(sb, backend, ['ask', '--conversation', conversation, '--prompt', 'must not enter the CLI']);
    assert.equal(overlap.code, 1, overlap.stdout + overlap.stderr);
    assert.match(overlap.stderr, new RegExp(`conversation ${conversation} is still in use by a foreground ask call`));
    assert.match(overlap.stderr, /not accepted or queued/);
    const role = run(sb, backend, ['implement', '--conversation', conversation, '--prompt', 'must not widen or start']);
    assert.equal(role.code, 1, role.stdout + role.stderr);
    assert.match(role.stderr, /still in use by a foreground ask call/);
    assert.equal(calls(sb).length, before + 1);
    assert.equal(state(sb, backend).jobs?.length || 0, 0);
    fs.writeFileSync(release, 'go');
    await until(() => closed === 0, 'held ask finished');
    assert.equal(stdout.trim(), `${backend} answer 中文`);
    assert.equal(state(sb, backend).foreground_sessions, undefined);
    const after = run(sb, backend, ['ask', '--conversation', conversation, '--prompt', 'session is free']);
    assert.equal(after.code, 0, after.stdout + after.stderr);
    assert.equal(calls(sb).length, before + 2);
    assert.equal(stderr.includes('still in use'), false);
  });

  test(`${backend}: wait without an id stays on the job selected when it started`, async t => {
    const sb = fixture(`${backend}-wait-pin`);
    cleanup(t, sb, backend);
    const release = path.join(sb.root, 'wait-release');
    const first = dispatch(sb, backend, ['staffer', '--prompt', 'job A'], {
      FAKE_CODING_RELEASE: release, FAKE_CODING_RESPONSE: 'ANSWER_A',
    });
    await until(() => calls(sb).length >= 1, 'job A native start');
    const waiter = spawn(process.execPath, [MAIN, '--backend', backend, 'wait', '--timeout', '12s'], {
      cwd: sb.repo, env: environment(sb, backend), windowsHide: true,
    });
    let stdout = '', stderr = '', closed = null;
    waiter.stdout.on('data', (chunk) => { stdout += chunk; });
    waiter.stderr.on('data', (chunk) => { stderr += chunk; });
    waiter.on('close', (code) => { closed = code; });
    t.after(() => {
      try { fs.writeFileSync(release, 'go'); } catch {}
      if (closed === null) waiter.kill('SIGKILL');
    });
    await delay(400);
    const second = dispatch(sb, backend, ['staffer', '--prompt', 'job B'], {
      FAKE_CODING_RESPONSE: 'ANSWER_B', FAKE_CODING_DELAY_MS: '20',
    });
    const finished = collect(sb, backend, second);
    assert.equal(finished.code, 0, finished.stdout + finished.stderr);
    assert.match(finished.stdout, /ANSWER_B/);
    await delay(400);
    assert.equal(closed, null, `wait returned early:\n${stdout}${stderr}`);
    assert.equal(job(sb, backend, first).status, 'running');
    fs.writeFileSync(release, 'go');
    await until(() => closed !== null, 'pinned wait finished');
    assert.equal(closed, 0, stdout + stderr);
    assert.match(stdout, new RegExp(`# Job ${first} \\(staffer, done\\)`));
    assert.match(stdout, /ANSWER_A/);
    assert.equal(stdout.includes(second), false);
    assert.equal(stdout.includes('ANSWER_B'), false);
  });

  test(`${backend}: bare continue and continue --conversation keep review --json validation`, t => {
    const sb = fixture(`${backend}-json-continue`);
    cleanup(t, sb, backend);
    const report = { verdict: 'approve', summary: 'No findings.', findings: [], could_not_verify: [] };
    const firstFlags = ['review', '--json', '--restricted', '--model', 'model-one', '--prompt', 'Review this fixture'];
    if (backend !== 'cursor') firstFlags.push('--effort', 'low');
    const first = dispatch(sb, backend, firstFlags, { FAKE_CODING_RESPONSE: JSON.stringify(report) });
    assert.equal(collect(sb, backend, first).code, 0);
    const conversation = job(sb, backend, first).conversation_id;
    const savedConfig = state(sb, backend).conversation_configs[conversation];
    assert.equal(savedConfig.json, true);
    assert.equal(savedConfig.model, 'model-one');
    assert.equal(savedConfig.profile, 'restricted');
    for (const args of [
      ['continue', '--prompt', 'implicit follow-up'],
      ['continue', '--conversation', conversation, '--prompt', 'explicit conversation follow-up'],
    ]) {
      const next = dispatch(sb, backend, args, { FAKE_CODING_RESPONSE: 'not json' });
      const result = collect(sb, backend, next);
      assert.equal(result.code, 3, result.stdout + result.stderr);
      const saved = job(sb, backend, next);
      assert.equal(saved.conversation_id, conversation);
      assert.equal(saved.mode, 'review');
      assert.equal(saved.model, 'model-one');
      assert.equal(saved.profile, 'restricted');
      assert.equal(saved.status, 'error');
      assert.equal(saved.reason, 'invalid_structured_output');
      assert.equal(JSON.parse(fs.readFileSync(saved.spec_file, 'utf8')).opts.json, true);
      assert.match(calls(sb).at(-1).prompt, /could_not_verify/);
      if (backend === 'grok') {
        assert.equal(saved.effort, 'low');
        assert.equal(arg(calls(sb).at(-1), '--permission-mode'), 'dontAsk');
      } else {
        assert.equal(calls(sb).at(-1).argv.includes(unrestrictedFlag(backend)), false);
        if (backend === 'codex') {
          assert.equal(saved.effort, 'low');
          assert.equal(effortOf(calls(sb).at(-1)), 'low');
          assert.ok(calls(sb).at(-1).schema, 'native schema must remain active during follow-up');
        }
      }
    }
  });

  test(`${backend}: denied tools preserve a completed answer and warnings`, t => {
    const sb = fixture(`${backend}-denied`);
    cleanup(t, sb, backend);
    const id = dispatch(sb, backend, ['staffer', '--restricted', '--prompt', 'permission fixture'], { FAKE_CODING_SCENARIO: 'denied', FAKE_CODING_RESPONSE: 'The requested write was denied.' });
    const result = collect(sb, backend, id);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /The requested write was denied\./);
    assert.equal(job(sb, backend, id).warnings, true);
    assert.ok(!fs.existsSync(path.join(sb.repo, 'protected.txt')));
  });

  test(`${backend}: structured review validates the entire report and preserves that contract on continuation`, t => {
    const sb = fixture(`${backend}-json-review`);
    cleanup(t, sb, backend);
    const report = { verdict: 'approve', summary: 'No findings.', findings: [], could_not_verify: [] };
    const valid = dispatch(sb, backend, ['review', '--json', '--prompt', 'Review this fixture'], { FAKE_CODING_RESPONSE: JSON.stringify(report) });
    assert.equal(collect(sb, backend, valid).code, 0);
    assert.match(calls(sb).at(-1).prompt, /could_not_verify/);
    assert.ok(!calls(sb).at(-1).argv.includes('--json-schema'), 'native schema support must not be invented');
    if (backend === 'codex') {
      const schema = calls(sb).at(-1).schema;
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.findings.items.additionalProperties, false);
      assert.deepEqual(new Set(schema.properties.findings.items.required), new Set(Object.keys(schema.properties.findings.items.properties)));
    }

    for (const response of [
      `Here is the report: ${JSON.stringify(report)}`,
      JSON.stringify({ ...report, findings: [{ severity: 'bogus', title: 'Invalid severity', detail: 'Must reject.' }] }),
      JSON.stringify({ verdict: 'approve', summary: 'Missing required arrays.' }),
    ]) {
      const invalid = dispatch(sb, backend, ['continue', '--job', valid, '--prompt', 'Continue the structured review'], { FAKE_CODING_RESPONSE: response });
      const result = collect(sb, backend, invalid);
      assert.equal(result.code, 3, result.stdout + result.stderr);
      assert.equal(job(sb, backend, invalid).reason, 'invalid_structured_output');
      assert.equal(run(sb, backend, ['result', invalid]).code, 3);
      assert.match(result.stdout, /partial_response/);
    }
  });

  test(`${backend}: native failure and missing terminal records keep partial answers without claiming completion`, t => {
    const sb = fixture(`${backend}-failure`);
    cleanup(t, sb, backend);
    for (const [scenario, expectedReason] of [['error', 'backend_error'], ['missing_result', 'missing_result']]) {
      const id = dispatch(sb, backend, ['staffer', '--prompt', `Bounded ${scenario} fixture`], {
        FAKE_CODING_SCENARIO: scenario, FAKE_CODING_RESPONSE: 'PARTIAL_ANSWER',
      });
      const result = collect(sb, backend, id);
      assert.equal(result.code, 3, result.stdout + result.stderr);
      assert.equal(job(sb, backend, id).status, 'error');
      assert.equal(job(sb, backend, id).reason, expectedReason);
      assert.equal(run(sb, backend, ['result', id]).code, 3);
      assert.match(result.stdout, /PARTIAL_ANSWER/);
      assert.ok(fs.existsSync(job(sb, backend, id).events_file), 'failure must retain native diagnostic events');
    }
  });

  test(`${backend}: cancel clears a real owned child in an independent process group`, { skip: process.platform === 'win32' }, async t => {
    const sb = fixture(`${backend}-cancel`);
    cleanup(t, sb, backend);
    const ready = path.join(sb.root, 'child-ready.json');
    const heartbeat = path.join(sb.root, 'heartbeat.txt');
    const completion = path.join(sb.root, 'unexpected-completion.txt');
    let identity;
    t.after(() => {
      if (identity && processIdentity(identity.pid)?.born === identity.born) {
        try { process.kill(identity.pid, 'SIGKILL'); } catch {}
      }
    });
    const id = dispatch(sb, backend, ['staffer', '--timeout', '20s', '--prompt', 'bounded child fixture'], {
      FAKE_CODING_CHILD_READY: ready, FAKE_CODING_HEARTBEAT: heartbeat,
      FAKE_CODING_COMPLETION: completion, FAKE_CODING_DELAY_MS: '25000',
    });
    await until(() => fs.existsSync(ready) && fs.existsSync(heartbeat), 'native tool started');
    const child = JSON.parse(fs.readFileSync(ready, 'utf8'));
    identity = processIdentity(child.pid);
    assert.ok(identity);
    const pgid = spawnSync('ps', ['-p', String(child.pid), '-o', 'pgid='], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    assert.equal(Number(pgid), child.pid, 'fixture must really own another process group');
    const canceled = run(sb, backend, ['cancel', id]);
    assert.equal(canceled.code, 0, canceled.stdout + canceled.stderr);
    assert.equal(collect(sb, backend, id).code, 4);
    await until(() => !isRunning(child.pid), 'owned detached tool exit');
    const stoppedHeartbeat = fs.readFileSync(heartbeat, 'utf8');
    await delay(150);
    assert.equal(fs.readFileSync(heartbeat, 'utf8'), stoppedHeartbeat);
    assert.ok(!fs.existsSync(completion));
    assert.equal(job(sb, backend, id).status, 'canceled');
  });
}

test('backend directories isolate equal native session IDs without serializing independent conversations', async t => {
  const sb = fixture('isolation');
  cleanup(t, sb, 'grok'); cleanup(t, sb, 'cursor'); cleanup(t, sb, 'codex');
  const release = path.join(sb.root, 'release');
  t.after(() => fs.writeFileSync(release, 'finish'));
  const grok = dispatch(sb, 'grok', ['staffer', '--prompt', 'grok separate conversation'], { FAKE_CODING_RELEASE: release, FAKE_CODING_RESPONSE: 'ONLY_GROK' });
  await until(() => job(sb, 'grok', grok).conversation_id, 'Grok preallocated session');
  const shared = job(sb, 'grok', grok).conversation_id;
  const cursor = dispatch(sb, 'cursor', ['staffer', '--prompt', 'cursor separate conversation'], { FAKE_CODING_RELEASE: release, FAKE_CODING_SESSION: shared, FAKE_CODING_RESPONSE: 'ONLY_CURSOR' });
  const codex = dispatch(sb, 'codex', ['staffer', '--prompt', 'codex separate conversation'], { FAKE_CODING_RELEASE: release, FAKE_CODING_SESSION: shared, FAKE_CODING_RESPONSE: 'ONLY_CODEX' });
  await until(() => calls(sb).length === 3, 'all independent native calls to start');
  assert.equal(job(sb, 'grok', grok).status, 'running');
  assert.equal(job(sb, 'cursor', cursor).status, 'running');
  assert.equal(job(sb, 'codex', codex).status, 'running');
  fs.writeFileSync(release, 'finish');
  assert.match(collect(sb, 'grok', grok).stdout, /ONLY_GROK/);
  assert.match(collect(sb, 'cursor', cursor).stdout, /ONLY_CURSOR/);
  assert.match(collect(sb, 'codex', codex).stdout, /ONLY_CODEX/);
  assert.equal(job(sb, 'grok', grok).conversation_id, shared);
  assert.equal(job(sb, 'cursor', cursor).conversation_id, shared);
  assert.equal(job(sb, 'codex', codex).conversation_id, shared);
  for (const backend of ['grok', 'cursor', 'codex']) {
    const next = dispatch(sb, backend, ['continue', '--prompt', 'backend-scoped implicit continuation']);
    assert.equal(collect(sb, backend, next).code, 0);
    assert.equal(resumedSession(calls(sb).at(-1)), shared);
    assert.equal(calls(sb).at(-1).backend, backend);
  }
});

test('Grok turn exhaustion stays attention instead of becoming user cancellation or done', t => {
  const sb = fixture('turn-limit');
  cleanup(t, sb, 'grok');
  const id = dispatch(sb, 'grok', ['staffer', '--prompt', 'bounded turn-limit fixture'], { FAKE_CODING_SCENARIO: 'turn_limit' });
  const result = collect(sb, 'grok', id);
  assert.equal(result.code, 5, result.stdout + result.stderr);
  assert.equal(job(sb, 'grok', id).status, 'attention');
  assert.equal(job(sb, 'grok', id).reason, 'turn_limit');
  assert.match(result.stdout, /I will inspect the file\./);
  assert.equal(job(sb, 'grok', id).cancel_requested_at, undefined);
});

test('Grok hard timeout retains its preallocated session while wait soft timeout leaves execution alive', t => {
  const sb = fixture('timeout');
  cleanup(t, sb, 'grok');
  const id = dispatch(sb, 'grok', ['staffer', '--timeout', '2s', '--prompt', 'slow native fixture'], { FAKE_CODING_DELAY_MS: '15000' });
  const early = run(sb, 'grok', ['wait', id, '--timeout', '50ms']);
  assert.equal(early.code, 2, early.stdout + early.stderr);
  assert.equal(job(sb, 'grok', id).status, 'running');
  const final = collect(sb, 'grok', id);
  assert.equal(final.code, 5, final.stdout + final.stderr);
  assert.equal(job(sb, 'grok', id).reason, 'hard_timeout');
  assert.ok(job(sb, 'grok', id).conversation_id);
});

test('doctor identifies a missing selected backend without calling a model', () => {
  const sb = fixture('doctor');
  const missing = path.join(sb.root, 'not-installed-cursor');
  const result = run(sb, 'cursor', ['doctor'], { CURSOR_BIN: missing, CURSOR_AGENT_BIN: missing });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.backends.length, 1);
  assert.equal(report.backends[0].backend, 'cursor');
  assert.equal(report.backends[0].available, false);
  assert.ok(report.backends[0].error);
  assert.equal(calls(sb).length, 0);
  const healthy = run(sb, 'grok', ['doctor']);
  assert.equal(healthy.code, 0, healthy.stdout + healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).backends[0].available, true);
  assert.equal(calls(sb).length, 0);
});

test('Cursor rejects unsupported effort before native execution', () => {
  const sb = fixture('cursor-unsupported-effort');
  const result = run(sb, 'cursor', ['staffer', '--effort', 'high', '--prompt', 'must not launch']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /UNSUPPORTED_CAPABILITY.*--effort/);
  assert.equal(calls(sb).length, 0);
});
