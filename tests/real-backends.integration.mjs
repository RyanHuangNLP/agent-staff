#!/usr/bin/env node
// Explicitly opted-in real CLI checks through the product entrypoint.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i + 1], `Missing ${process.argv[i]}`);
  options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const backend = options.backend, phase = options.phase || 'basic';
assert.ok(['agy', 'grok', 'cursor'].includes(backend), '--backend agy|grok|cursor required');
assert.ok(['basic', 'verify-basic', 'deny', 'cancel'].includes(phase), '--phase basic|verify-basic|deny|cancel');
if (phase !== 'verify-basic' && process.env.AGENT_STAFF_REAL !== '1') throw new Error('Set AGENT_STAFF_REAL=1 to authorize real model usage.');
assert.ok(options.root && path.isAbsolute(options.root), '--root must be a new absolute evidence directory');
const root = options.root, workspace = path.join(root, 'workspace');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = options.entry || (phase === 'verify-basic'
  ? JSON.parse(fs.readFileSync(path.join(root, 'basic-01-version-before.json'), 'utf8')).argv[1]
  : path.join(packageRoot, 'bin/agent-staff.mjs'));
const profileDir = path.join(workspace, `.${backend}-staff`);
const env = { ...process.env, AGENT_STAFF_KEEP_LOGS: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
let counter = 0, activeId = null, createdPolicy = null, summary;
const outcomes = [];
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function save(name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  return file;
}
function command(name, args, { expected = 0, timeout = 150000, cwd = workspace, extraEnv = {} } = {}) {
  if (phase === 'verify-basic') assert.deepEqual(args, ['doctor'], 'Offline verification must never invoke a model or mutate a job');
  const record = { name, argv: [process.execPath, entry, '--backend', backend, ...args], startedAt: new Date().toISOString() };
  const result = spawnSync(process.execPath, [entry, '--backend', backend, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  Object.assign(record, { exit: result.status, signal: result.signal, error: result.error?.message || null, finishedAt: new Date().toISOString() });
  const base = `${phase}-${String(++counter).padStart(2, '0')}-${name}`;
  fs.writeFileSync(path.join(root, base + '.stdout.txt'), result.stdout || '', { mode: 0o600 });
  fs.writeFileSync(path.join(root, base + '.stderr.txt'), result.stderr || '', { mode: 0o600 });
  save(base + '.json', record);
  outcomes.push(record);
  if (expected !== null) assert.equal(result.status, expected, `${name}: ${result.stderr}\n${result.stdout}`);
  return { ...result, record };
}
function jobId(result) {
  const match = /job id: (\S+)/.exec(result.stdout);
  assert.ok(match, result.stdout);
  return match[1];
}
function job(id) {
  const record = json(path.join(profileDir, 'state.json')).jobs.find(item => item.id === id);
  assert.ok(record, id);
  // wait may observe the durable terminal sidecar just before state.json commits.
  const sidecar = record.result_file + '.status.json';
  return fs.existsSync(sidecar) ? { ...record, ...json(sidecar) } : record;
}
const read = file => fs.readFileSync(path.join(workspace, file), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function task(name, text) {
  const file = path.join(root, `${phase}-${name}.prompt.txt`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}
function start(name, text, flags = []) {
  return jobId(command(name, ['staffer', ...flags, '--timeout', '90s', '--prompt-file', task(name, text)]));
}
function finish(id, name = 'wait') { return command(name, ['wait', id, '--timeout', '120s']); }
function resultBody(result, record, exactToken) {
  const body = fs.readFileSync(record.result_file, 'utf8');
  assert.equal(result.stdout, `# Job ${record.id} (${record.mode}, ${record.status})\n\n${body}`, 'wait must print the standard job header followed by the exact saved result');
  if (exactToken) assert.equal(body.replace(/\r?\n$/, ''), exactToken, 'The saved result must contain only the exact nonce and its final newline');
  return body;
}
function recordedCommand(name) {
  const matches = fs.readdirSync(root).filter(file => new RegExp(`^basic-\\d+-${name}\\.json$`).test(file));
  assert.equal(matches.length, 1, `Need one recorded basic ${name} command`);
  const file = path.join(root, matches[0]), record = json(file), base = file.slice(0, -5);
  assert.equal(record.name, name); assert.equal(record.exit, 0); assert.equal(record.signal, null); assert.equal(record.error, null);
  assert.equal(record.argv[1], entry, 'Verification must use the same packaged entrypoint as the original run');
  assert.deepEqual(record.argv.slice(2, 4), ['--backend', backend]);
  return { record, file, stdout: fs.readFileSync(base + '.stdout.txt', 'utf8'), stderr: fs.readFileSync(base + '.stderr.txt', 'utf8') };
}
function doctor(name) {
  const value = JSON.parse(command(name, ['doctor']).stdout);
  assert.equal(value.ok, true);
  assert.equal(value.backends.length, 1);
  assert.equal(value.backends[0].backend, backend);
  assert.equal(value.backends[0].available, true);
  assert.ok(value.backends[0].version);
  return value;
}
function nativeEvents(file, { session, zeroTools = false, terminal = true } = {}) {
  assert.ok(file && fs.existsSync(file), `Missing full native event evidence: ${file}`);
  const raw = fs.readFileSync(file), lines = raw.toString('utf8').split(/\r?\n/).filter(line => line.trim());
  assert.ok(lines.length, `Empty event stream: ${file}`);
  const events = lines.map((line, index) => {
    try { return JSON.parse(line); } catch { assert.fail(`Malformed native event ${index + 1} in ${file}; cannot prove tool counts.`); }
  });
  const tools = events.filter(event => backend === 'agy' ? event.event === 'step_update' && event.step_update?.step_type === 'tool'
    : backend === 'grok' ? ['tool_call', 'tool_call_update'].includes(event.type) : event.type === 'tool_call');
  const keys = new Set(tools.map((event, index) => backend === 'agy' ? event.step_update.step_index ?? `missing-${index}`
    : backend === 'grok' ? event.toolCallId ?? `missing-${index}` : event.call_id ?? event.tool_call?.toolCallId ?? `missing-${index}`));
  if (terminal) {
    const last = events.at(-1);
    assert.ok(backend === 'agy' ? last.event === 'result' && last.result?.status === 'SUCCESS'
      : backend === 'grok' ? last.type === 'end' && last.stopReason === 'end_turn'
        : last.type === 'result' && last.subtype === 'success' && !last.is_error, `Missing successful final native event: ${file}`);
  }
  const sessions = [...new Set(events.flatMap(event => {
    const id = event.session_id || event.sessionId || event.conversation_id || event.step_update?.conversation_id || event.result?.conversation_id;
    return typeof id === 'string' && id ? [id] : [];
  }))];
  // Grok first emits sessionId in end; an interrupted stream may have no ID.
  // Every observed ID must still match, and a completed turn must emit it.
  if (session && (terminal || sessions.length)) assert.deepEqual(sessions, [session], `Native stream must belong only to the saved session: ${file}`);
  const evidence = { file, sha256: createHash('sha256').update(raw).digest('hex'), eventCount: events.length,
    toolEventCount: tools.length, toolCallCount: keys.size, sessions, nativeSessionIdEmitted: sessions.length > 0, successfulTerminalRequired: terminal };
  if (zeroTools) assert.equal(tools.length, 0, `Unexpected tool activity: ${JSON.stringify(evidence)}`);
  return { events, evidence };
}
function jobEvents(record, options) { return nativeEvents(record.events_file, { session: record.conversation_id, ...options }); }
function seedOperations(events) {
  let operations;
  if (backend === 'agy') operations = events.filter(event => event.event === 'step_update' && event.step_update?.step_type === 'tool' && event.step_update.state === 'DONE'
    && !event.step_update.error && !event.step_update.tool_info?.error).map(event => ({
    id: event.step_update.step_index, tool: event.step_update.tool_name, input: event.step_update.tool_info?.parameters,
  }));
  else if (backend === 'grok') operations = events.filter(event => event.type === 'tool_call').flatMap(event =>
    events.some(update => update.type === 'tool_call_update' && update.toolCallId === event.toolCallId && update.status === 'completed')
      ? [{ id: event.toolCallId, tool: event.toolName, input: event.rawInput }] : []);
  else operations = events.filter(event => event.type === 'tool_call' && event.subtype === 'completed').flatMap(event =>
    Object.entries(event.tool_call || {}).flatMap(([tool, body]) => /ToolCall$/.test(tool) && body?.result?.success
      ? [{ id: event.call_id || event.tool_call.toolCallId, tool, input: body.args }] : []));
  const read = operations.filter(item => /read|view|shell|run_command/i.test(item.tool) && JSON.stringify(item.input || {}).includes('fixture.txt'));
  const write = operations.filter(item => /write|edit|shell|run_command/i.test(item.tool) && JSON.stringify(item.input || {}).includes('delivered.txt'));
  assert.ok(read.length, 'Need a completed native tool reading fixture.txt');
  assert.ok(write.length, 'Need a completed native tool writing delivered.txt');
  return { completedFixtureReads: read, completedDeliverableWrites: write };
}
function processRows() {
  assert.notEqual(process.platform, 'win32', 'This real process-evidence smoke uses POSIX ps; Windows is not verified here.');
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 10000, env: { ...env, LC_ALL: 'C', TZ: 'UTC' },
  });
  assert.equal(result.status, 0, `Process inspection unavailable: ${result.error?.message || result.stderr}`);
  const rows = result.stdout.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    assert.ok(match, `Unparseable process row: ${line}`);
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), stat: match[4], born: match[5].trim() };
  });
  assert.ok(rows.length, 'An empty process table cannot prove cleanup.');
  return rows;
}
const identityKey = row => `${row.pid}:${row.born}`;
function identities(items) {
  return [...new Map(items.filter(Boolean).map(item => [identityKey(item), item])).values()];
}
function confirmCleanup(record, name, extra = []) {
  assert.equal(record.cleanup?.status, 'confirmed', `${name}: cleanup must be explicitly confirmed`);
  assert.deepEqual(record.cleanup.survivors, [], `${name}: cleanup must report no survivors`);
  assert.equal(record.executionMayBeActive, false, `${name}: execution must not remain possibly active`);
  const owned = identities([record.execution_identity, ...(record.owned_processes || []), ...(record.cleanup.owned || []), ...extra]);
  assert.ok(owned.length, `${name}: no captured execution identity for independent cleanup verification`);
  const rows = processRows(), observed = rows.filter(row => owned.some(old => identityKey(old) === identityKey(row)));
  const evidence = { observedAt: new Date().toISOString(), cleanup: record.cleanup, owned,
    identityMatches: observed, executingMatches: observed.filter(row => !row.stat.startsWith('Z')) };
  save(`${phase}-${name}-cleanup-evidence.json`, evidence);
  assert.deepEqual(evidence.executingMatches, [], `${name}: an owned process still executes`);
  return evidence;
}
function askCapture() {
  if (backend !== 'agy') return { extraEnv: {} };
  const suffix = randomBytes(8).toString('hex'), file = path.join(root, `basic-ask-${suffix}.native.json`);
  const proxy = path.join(root, `basic-ask-${suffix}.capture.mjs`);
  // This test-only shim forwards this one ask invocation. All background and
  // cancellation checks still launch the original AGY binary directly.
  fs.writeFileSync(proxy, String.raw`import fs from 'node:fs';
import { spawn } from 'node:child_process';
const binary = process.env.AGENT_STAFF_CAPTURE_AGY_BIN;
const output = process.env.AGENT_STAFF_CAPTURE_STDOUT;
const args = process.argv.slice(2), script = /\.(mjs|cjs|js)$/i.test(binary);
const fd = fs.openSync(output, 'wx', 0o600);
const child = spawn(script ? process.execPath : binary, script ? [binary, ...args] : args, { stdio: ['inherit', 'pipe', 'inherit'] });
const forwards = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
  const forward = () => { try { child.kill(signal); } catch {} };
  forwards.set(signal, forward); process.on(signal, forward);
}
let launchError = null;
child.once('error', error => { launchError = error.message; process.stderr.write(error.message + '\n'); });
child.stdout.on('data', chunk => fs.writeSync(fd, chunk));
child.stdout.pipe(process.stdout);
child.once('close', (code, signal) => {
  fs.closeSync(fd);
  fs.writeFileSync(output + '.meta.json', JSON.stringify({ binary, argv: args, cwd: process.cwd(), exit: code, signal, error: launchError }) + '\n', { mode: 0o600 });
  for (const [kind, forward] of forwards) process.removeListener(kind, forward);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`, { mode: 0o600 });
  return { file, extraEnv: { AGY_BIN: proxy, AGENT_STAFF_CAPTURE_AGY_BIN: env.AGY_BIN || 'agy', AGENT_STAFF_CAPTURE_STDOUT: file } };
}
function askEvidence(result, capture) {
  if (backend === 'agy') {
    const raw = fs.readFileSync(capture.file), text = raw.toString('utf8'), start = text.indexOf('{');
    assert.ok(start >= 0, 'Captured AGY ask did not contain native JSON');
    const payload = JSON.parse(text.slice(start)), metadata = json(capture.file + '.meta.json');
    assert.equal(metadata.exit, 0); assert.equal(metadata.signal, null); assert.equal(metadata.error, null);
    assert.equal(payload.status, 'SUCCESS'); assert.equal(payload.response.trim(), result.stdout.trim());
    return { status: 'unverified', toolEventCount: null, file: capture.file, metadataFile: capture.file + '.meta.json',
      sha256: createHash('sha256').update(raw).digest('hex'), nativeFields: Object.keys(payload),
      reason: 'AGY foreground ask native JSON was captured unchanged, but its validated schema exposes no complete tool list or counter. Exact text and num_turns do not prove zero tool calls.' };
  }
  const match = new RegExp(`^\\[${backend}-staff\\] diagnostics: (.+)$`, 'm').exec(result.stderr);
  assert.ok(match, 'Foreground ask must retain native diagnostics under AGENT_STAFF_KEEP_LOGS=1');
  const retained = path.join(root, 'basic-ask-native');
  if (phase === 'verify-basic') assert.ok(fs.existsSync(retained), 'Need the original retained ask evidence');
  else fs.cpSync(match[1].trim(), retained, { recursive: true, errorOnExist: true, force: false });
  const diagnostic = json(path.join(retained, 'diagnostics.json'));
  assert.equal(diagnostic.backend, backend); assert.equal(diagnostic.mode, 'ask'); assert.equal(diagnostic.status, 'done');
  const { evidence } = nativeEvents(path.join(retained, 'events.jsonl'), { session: diagnostic.conversation_id, zeroTools: true });
  assert.equal(diagnostic.observed_tool_calls, 0);
  assert.deepEqual(diagnostic.payload.toolCalls, []);
  assert.equal(diagnostic.cleanup?.status, 'confirmed'); assert.deepEqual(diagnostic.cleanup.survivors, []);
  return { status: 'verified', ...evidence, diagnosticsFile: path.join(retained, 'diagnostics.json'), cleanup: diagnostic.cleanup };
}

try {
  let baseline = null;
  if (phase === 'basic') {
    assert.ok(!fs.existsSync(workspace), 'Use a fresh --root for basic'); fs.mkdirSync(workspace);
    const init = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' }); assert.equal(init.status, 0, init.stderr);
    fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'STAFF_FIXTURE_64d1\n');
  } else if (phase !== 'verify-basic') {
    assert.ok(fs.existsSync(path.join(root, 'basic-summary.json')), 'Run basic first');
    baseline = json(path.join(root, 'basic-summary.json'));
    assert.equal(baseline.backend, backend, 'Evidence root belongs to another backend');
  }
  const before = doctor('version-before');
  if (baseline) assert.deepEqual(before, baseline.version, 'Native CLI changed since the basic phase');
  if (phase === 'basic') {
    const nonce = `STAFF_MEMORY_${randomBytes(16).toString('hex')}`;
    const capture = askCapture();
    const ask = command('ask', ['ask', '--timeout', '90s', '--prompt', 'Reply with exactly STAFF_ASK_OK. Do not use any tools.'], capture);
    assert.equal(ask.stdout.trim(), 'STAFF_ASK_OK'); assert.doesNotMatch(ask.stdout, /Started background/);
    const askTools = askEvidence(ask, capture);
    activeId = start('seed', `Remember this exact token in this conversation: ${nonce}. Read fixture.txt in the current directory, then create only delivered.txt with exactly STAFF_DELIVERED_95fa followed by one newline. This task explicitly authorizes that one test file edit. Do not commit, install dependencies, inspect unrelated directories, or use external services. Finish with the token and the fixture contents.`);
    const seedId = activeId, seed = finish(seedId, 'seed-wait'); activeId = null;
    assert.equal(read('delivered.txt'), 'STAFF_DELIVERED_95fa\n'); assert.ok(seed.stdout.includes(nonce)); assert.ok(seed.stdout.includes('STAFF_FIXTURE_64d1'));
    const seedJob = job(seedId); assert.equal(seedJob.status, 'done'); assert.ok(seedJob.conversation_id);
    const seedEvents = jobEvents(seedJob).evidence;
    confirmCleanup(seedJob, 'seed');
    const followPrompt = 'Without using tools or reading any files, recall the exact STAFF_MEMORY_ token from the first request in this conversation. Return only that token.';
    assert.ok(!followPrompt.includes(nonce));
    activeId = jobId(command('continue', ['continue', '--job', seedId, '--timeout', '90s', '--prompt', followPrompt]));
    const resumeId = activeId, resumed = finish(resumeId, 'continue-wait'); activeId = null;
    const resumeJob = job(resumeId);
    assert.equal(resumeJob.status, 'done'); resultBody(resumed, resumeJob, nonce); assert.equal(resumeJob.conversation_id, seedJob.conversation_id);
    const resumeEvents = jobEvents(resumeJob, { zeroTools: true }).evidence;
    confirmCleanup(resumeJob, 'continue');
    summary = { backend, phase, status: askTools.status === 'verified' ? 'passed' : 'passed_with_limitations', cliInvocations: 3,
      seedJob: seedId, resumeJob: resumeId, session: seedJob.conversation_id, nonce, askTools, seedEvents, resumeEvents,
      checks: { foregroundAsk: true, askZeroTools: askTools.status === 'verified', exactFileWrite: true,
        fixtureRead: true, exactNonceResume: true, resumeZeroTools: true, backgroundCleanupConfirmed: true },
      limitations: askTools.status === 'verified' ? [] : [askTools.reason] };
  } else if (phase === 'verify-basic') {
    const recorded = Object.fromEntries(['version-before', 'ask', 'seed', 'seed-wait', 'continue', 'continue-wait'].map(name => [name, recordedCommand(name)]));
    const originalVersion = JSON.parse(recorded['version-before'].stdout);
    assert.deepEqual(before, originalVersion, 'Native CLI changed since the original basic calls');
    assert.equal(recorded.ask.record.argv[4], 'ask');
    assert.equal(recorded.seed.record.argv[4], 'staffer');
    assert.equal(recorded.continue.record.argv[4], 'continue');
    assert.equal(recorded.ask.stdout, 'STAFF_ASK_OK\n');
    let capture;
    if (backend === 'agy') {
      const files = fs.readdirSync(root).filter(file => /^basic-ask-[a-f0-9]+\.native\.json$/.test(file));
      assert.equal(files.length, 1, 'Need the single original AGY ask capture');
      capture = { file: path.join(root, files[0]) };
    }
    const askTools = askEvidence(recorded.ask, capture);
    const seedId = jobId(recorded.seed), resumeId = jobId(recorded.continue);
    const seedJob = job(seedId), resumeJob = job(resumeId);
    for (const item of [seedJob, resumeJob]) { assert.equal(item.backend, backend); assert.equal(item.status, 'done'); assert.ok(item.conversation_id); }
    assert.equal(resumeJob.parent_job_id, seedId); assert.equal(resumeJob.conversation_id, seedJob.conversation_id);
    const seedPrompt = fs.readFileSync(path.join(root, 'basic-seed.prompt.txt'), 'utf8');
    const nonceMatches = seedPrompt.match(/STAFF_MEMORY_[a-f0-9]{32}/g); assert.equal(nonceMatches?.length, 1);
    const nonce = nonceMatches[0], seedSpec = json(seedJob.spec_file), resumeSpec = json(resumeJob.spec_file);
    assert.equal(seedSpec.prompt_source?.task, seedPrompt); assert.ok(seedSpec.prompt.includes(nonce));
    const argv = recorded.continue.record.argv;
    assert.equal(argv[argv.indexOf('--job') + 1], seedId);
    const followPrompt = argv[argv.indexOf('--prompt') + 1]; assert.ok(followPrompt && !followPrompt.includes(nonce));
    assert.equal(resumeSpec.prompt_source?.task, followPrompt); assert.ok(!resumeSpec.prompt.includes(nonce));
    for (const [name, id] of [['seed-wait', seedId], ['continue-wait', resumeId]]) assert.deepEqual(recorded[name].record.argv.slice(4, 6), ['wait', id]);
    assert.equal(read('fixture.txt'), 'STAFF_FIXTURE_64d1\n'); assert.equal(read('delivered.txt'), 'STAFF_DELIVERED_95fa\n');
    const seedBody = resultBody(recorded['seed-wait'], seedJob);
    assert.ok(seedBody.includes(nonce)); assert.ok(seedBody.includes('STAFF_FIXTURE_64d1'));
    resultBody(recorded['continue-wait'], resumeJob, nonce);
    const nativeSeed = jobEvents(seedJob), nativeResume = jobEvents(resumeJob, { zeroTools: true });
    const operations = seedOperations(nativeSeed.events);
    confirmCleanup(seedJob, 'seed'); confirmCleanup(resumeJob, 'continue');
    summary = { backend, phase: 'basic', status: askTools.status === 'verified' ? 'passed' : 'passed_with_limitations', cliInvocations: 3,
      seedJob: seedId, resumeJob: resumeId, session: seedJob.conversation_id, nonce, askTools,
      seedEvents: nativeSeed.evidence, resumeEvents: nativeResume.evidence, seedOperations: operations,
      checks: { foregroundAsk: true, askZeroTools: askTools.status === 'verified', exactFileWrite: true, fixtureRead: true,
        nativeReadAndWriteObserved: true, exactNonceResume: true, resumeZeroTools: true, backgroundCleanupConfirmed: true, standardWaitHeaderAndBody: true },
      limitations: askTools.status === 'verified' ? [] : [askTools.reason],
      replay: { phase, modelInvocations: 0, originalModelInvocations: 3, originalFailurePreserved: fs.existsSync(path.join(root, 'basic-failure.json')),
        originalCalls: Object.values(recorded).map(item => ({ file: item.file, ...item.record })), verifiedAt: new Date().toISOString() } };
  } else if (phase === 'deny') {
    assert.equal(backend, 'cursor', 'The product denial smoke currently targets Cursor project policy; Grok dontAsk fixtures cover its explicit allow/deny protocol.');
    const config = path.join(workspace, '.cursor', 'cli.json'); assert.ok(!fs.existsSync(config), 'Refuse to replace existing policy'); fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ permissions: { allow: ['Read(**)'], deny: ['Write(**)', 'Shell(*)'] } }, null, 2)); createdPolicy = config;
    activeId = start('deny', 'Read fixture.txt as a positive control. Then attempt to create forbidden.txt using a file edit tool and attempt a shell command that creates forbidden-shell.txt. This is a bounded permissions test in this disposable workspace; make each attempt once, report the tool refusals accurately, and do not try alternative methods to bypass the denials.');
    const id = activeId; finish(id, 'deny-wait'); activeId = null;
    const record = job(id); assert.equal(record.status, 'done');
    assert.ok(!fs.existsSync(path.join(workspace, 'forbidden.txt'))); assert.ok(!fs.existsSync(path.join(workspace, 'forbidden-shell.txt')));
    const native = jobEvents(record), completed = native.events.filter(event => event.type === 'tool_call' && event.subtype === 'completed');
    const denied = completed.flatMap(event => Object.entries(event.tool_call || {}).flatMap(([name, body]) =>
      /ToolCall$/.test(name) && (body?.result?.permissionDenied || body?.result?.writePermissionDenied)
        ? [{ id: event.call_id || event.tool_call.toolCallId, tool: name, result: body.result }] : []));
    assert.ok(denied.some(item => /shell/i.test(item.tool)), 'Need a native shell denial');
    assert.ok(denied.some(item => /edit|write/i.test(item.tool)), 'Need a native file-write denial');
    assert.ok(completed.some(event => event.tool_call?.readToolCall?.result?.success?.content?.includes('STAFF_FIXTURE_64d1')), 'Need a successful native read as the positive control');
    assert.ok(Array.isArray(record.permission_denials), 'State must retain permission_denials');
    assert.deepEqual(new Set(record.permission_denials.map(item => item.id)), new Set(denied.map(item => item.id)), 'Saved permission_denials must match native denied call IDs');
    confirmCleanup(record, 'deny');
    summary = { backend, phase, status: 'passed', cliInvocations: 1, job: id, permissionDenials: record.permission_denials,
      nativeDenials: denied, events: native.evidence, checks: { readAllowed: true, writeDenied: true, shellDenied: true, cleanupConfirmed: true } };
  } else {
    for (const file of ['started.txt', 'heartbeat.txt', 'completed.txt']) assert.ok(!fs.existsSync(path.join(workspace, file)), `Existing ${file}`);
    const nonce = `CANCEL_MEMORY_${randomBytes(12).toString('hex')}`;
    const script = 'import pathlib,time,os\np=pathlib.Path(".")\nwith p.joinpath("started.txt").open("a") as f: f.write(str(os.getpid())+"\\n")\nfor i in range(20):\n p.joinpath("heartbeat.txt").write_text(str(i))\n time.sleep(1)\np.joinpath("completed.txt").write_text("COMPLETE")\n';
    fs.writeFileSync(path.join(workspace, 'bounded.py'), script);
    activeId = start('cancel-start', `Remember this token for later conversation recall: ${nonce}. Execute exactly this shell command once in the current directory: python3 bounded.py. It runs for 20 seconds and writes only local test markers. Start the command now. Do not detach it, do not replace it, do not run other commands, and do not restart it if interrupted.`);
    const id = activeId, deadline = Date.now() + 90000;
    while ((!fs.existsSync(path.join(workspace, 'started.txt')) || !fs.existsSync(path.join(workspace, 'heartbeat.txt'))) && Date.now() < deadline) {
      assert.equal(job(id).status, 'running', 'The task ended before its tool started'); await delay(200);
    }
    assert.ok(fs.existsSync(path.join(workspace, 'started.txt')), 'No real started marker');
    const started = read('started.txt'), starts = started.trim().split('\n'); assert.equal(starts.length, 1, 'Tool must be launched exactly once');
    const toolPid = Number(starts[0]); assert.ok(Number.isInteger(toolPid) && toolPid > 1);
    const running = job(id); assert.equal(running.status, 'running'); assert.ok(running.execution_identity);
    const rows = processRows(), execution = rows.find(row => identityKey(row) === identityKey(running.execution_identity));
    const toolIdentity = rows.find(row => row.pid === toolPid); assert.ok(execution); assert.ok(toolIdentity);
    const owned = new Map([[execution.pid, execution]]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (!owned.has(row.pid) && owned.has(row.parent)) { owned.set(row.pid, row); changed = true; }
    }
    assert.ok(owned.has(toolPid), 'Real tool PID must descend from this native execution before cancellation');
    save('cancel-started-process-evidence.json', { observedAt: new Date().toISOString(), toolIdentity, owned: [...owned.values()], startedMarker: started });
    const canceledAt = Date.now(); command('cancel', ['cancel', id]); activeId = null;
    const record = job(id); assert.equal(record.status, 'canceled'); assert.ok(record.conversation_id);
    confirmCleanup(record, 'cancel-immediate', [...owned.values()]);
    jobEvents(record, { terminal: false });
    const heartbeat = read('heartbeat.txt');
    await delay(Math.max(0, 21000 - (Date.now() - canceledAt)));
    assert.equal(read('heartbeat.txt'), heartbeat); assert.equal(read('started.txt'), started);
    assert.ok(!fs.existsSync(path.join(workspace, 'completed.txt')));
    const delayedCleanup = confirmCleanup(record, 'cancel-after-natural-completion', [...owned.values()]);
    const follow = 'Do not use tools and do not restart the interrupted command. Recall only the exact CANCEL_MEMORY_ token from the previous request. Return just that token.';
    assert.ok(!follow.includes(nonce));
    activeId = jobId(command('cancel-continue', ['continue', '--job', id, '--timeout', '90s', '--prompt', follow]));
    const resumeId = activeId, resumed = finish(resumeId, 'cancel-continue-wait'); activeId = null;
    const resumeJob = job(resumeId); assert.equal(resumeJob.status, 'done');
    resultBody(resumed, resumeJob, nonce); assert.equal(resumeJob.conversation_id, record.conversation_id);
    assert.ok(!fs.existsSync(path.join(workspace, 'completed.txt'))); assert.equal(read('heartbeat.txt'), heartbeat); assert.equal(read('started.txt'), started);
    const resumeEvents = jobEvents(resumeJob, { zeroTools: true }).evidence;
    confirmCleanup(resumeJob, 'cancel-continue');
    summary = { backend, phase, status: 'passed', cliInvocations: 2, job: id, resumeJob: resumeId, toolPid, toolIdentity,
      session: record.conversation_id, resumeEvents, checks: { startedObserved: true, originalToolAncestryVerified: true, cleanupConfirmed: true,
        noLateCompletion: true, noHeartbeatGrowth: true, toolStartedOnce: true, observedAfterNaturalSeconds: 21,
        ownedIdentitiesNotExecuting: delayedCleanup.executingMatches.length === 0, resumeExactNonce: true, resumeZeroTools: true } };
  }
  const after = doctor('version-after'); assert.deepEqual(after, before, 'Native CLI version changed during this phase');
  summary.version = after; summary.checks.versionStable = true; summary.outcomes = outcomes;
  if (phase === 'verify-basic') save('basic-summary.json', summary);
  save(`${phase}-summary.json`, summary);
  console.log(JSON.stringify({ backend, phase, status: summary.status, evidence: root, limitations: summary.limitations || [] }));
} catch (error) {
  if (activeId) { try { command('failure-cleanup', ['cancel', activeId], { expected: null }); } catch {} }
  save(`${phase}-failure.json`, { backend, phase, status: 'failed', error: error.stack, outcomes });
  console.error(error.stack); process.exitCode = 1;
} finally {
  if (createdPolicy && fs.existsSync(createdPolicy)) fs.unlinkSync(createdPolicy);
}
