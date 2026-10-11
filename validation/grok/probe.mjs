import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

if (process.env.AGENT_STAFF_LIVE !== '1') throw new Error('Opt-in required: AGENT_STAFF_LIVE=1');
if (!process.env.AGENT_STAFF_PROBE_ROOT) throw new Error('Set AGENT_STAFF_PROBE_ROOT to a fresh evidence directory');
const ROOT = path.resolve(process.env.AGENT_STAFF_PROBE_ROOT);
const WORKSPACE = path.join(ROOT, 'workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const stateFile = path.join(ROOT, 'probe-state.json');
if (process.argv[2] === 'seed' && fs.existsSync(stateFile)) throw new Error('Refusing reused seed directory/session; choose a new root');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {
  session: randomUUID(), nonce: `grok_memory_${randomUUID().replaceAll('-', '')}`,
  fixture: `fixture_${randomUUID().slice(0, 8)}`,
};
writeJSON(stateFile, state);
fs.writeFileSync(path.join(WORKSPACE, 'fixture.txt'), state.fixture + '\n');
if (!fs.existsSync(path.join(WORKSPACE, '.git'))) {
  const r = spawnSync('git', ['init', '--quiet'], { cwd: WORKSPACE });
  if (r.status !== 0) throw new Error('git init failed');
}

function processes() {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,comm='], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ps failed: ${r.stderr}`);
  return r.stdout.trim().split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: +m[1], ppid: +m[2], group: +m[3], born: m[4], command: m[5] }] : [];
  });
}
function family(rootPid, rows) {
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
  }
  return rows.filter(row => ids.has(row.pid) || row.group === rootPid);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(name, prompt, flags, { cancelMarker, timeoutMs = 120000, waitAfterMs = 1500, maxTurns = 4 } = {}) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, prompt);
  const args = ['--cwd', WORKSPACE, '--no-memory', '--no-subagents', '--no-leader', '--disable-web-search',
    '--permission-mode', 'dontAsk', '--max-turns', String(maxTurns), '--output-format', 'streaming-json',
    ...flags, '--prompt-file', promptFile];
  const manifest = { name, binary: 'grok', argv: args, cwd: WORKSPACE, timeoutMs,
    startedAt: new Date().toISOString(), node: process.version, version: spawnSync('grok', ['--version'], { encoding: 'utf8' }).stdout.trim() };
  writeJSON(path.join(dir, 'manifest.json'), manifest);
  const out = fs.openSync(path.join(dir, 'stdout.jsonl'), 'w');
  const err = fs.openSync(path.join(dir, 'stderr.log'), 'w');
  const child = spawn('grok', args, { cwd: WORKSPACE, detached: true, stdio: ['ignore', out, err] });
  fs.closeSync(out); fs.closeSync(err);
  const seen = new Map();
  let stopping = false, stopReason = null, exitRecord = null;
  function track() {
    const rows = processes();
    for (const row of family(child.pid, rows)) seen.set(`${row.pid}:${row.born}`, row);
    return rows;
  }
  function ownedSignals(signal) {
    const rows = track();
    const live = [...seen.values()].filter(old => rows.some(now => now.pid === old.pid && now.born === old.born));
    // Every process here was observed beneath this dedicated test process or in its process group.
    for (const row of live.reverse()) { try { process.kill(row.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  }
  const start = Date.now();
  const exited = new Promise(resolve => {
    child.on('error', error => { exitRecord = { error: error.message }; resolve(exitRecord); });
    child.on('exit', (code, signal) => { exitRecord = { code, signal }; resolve(exitRecord); });
  });
  const monitor = setInterval(() => {
    try { track(); } catch (e) { console.error(e.message); }
  }, 250);
  try {
    while (!exitRecord) {
      if (cancelMarker && fs.existsSync(cancelMarker)) {
        const markers = { marker: fs.readFileSync(cancelMarker, 'utf8'), processes: family(child.pid, track()), at: new Date().toISOString() };
        writeJSON(path.join(dir, 'before-cancel.json'), markers);
        stopReason = 'requested_cancel_after_tool_started'; stopping = true; break;
      }
      if (Date.now() - start > timeoutMs) { stopReason = 'probe_timeout'; stopping = true; break; }
      await delay(150);
    }
    if (stopping) {
      ownedSignals('SIGTERM');
      await delay(1200);
      ownedSignals('SIGKILL');
    }
    await Promise.race([exited, delay(4000)]);
    await delay(waitAfterMs);
    const rows = track();
    const survivors = [...seen.values()].filter(old => rows.some(now => now.pid === old.pid && now.born === old.born));
    const raw = fs.readFileSync(path.join(dir, 'stdout.jsonl'), 'utf8');
    const events = raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { malformed: line }; } });
    const result = { ...manifest, pid: child.pid, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - start,
      exit: exitRecord, stopReason, tracked: [...seen.values()], survivors,
      eventCount: events.length, eventTypes: [...new Set(events.map(e => e.type || e.event || e.sessionUpdate || e.update?.sessionUpdate || e.method || Object.keys(e).join(',')))],
      workspaceFiles: fs.readdirSync(WORKSPACE).filter(n => n !== '.git') };
    writeJSON(path.join(dir, 'result.json'), result);
    if (survivors.length) { ownedSignals('SIGTERM'); await delay(800); ownedSignals('SIGKILL'); }
    console.log(JSON.stringify({ name, exit: result.exit, stopReason, eventCount: events.length, eventTypes: result.eventTypes, survivors: survivors.length, elapsedMs: result.elapsedMs, dir }));
    return { result, events, raw, text: events.filter(e => e.type === 'text').map(e => e.data || '').join('') };
  } finally {
    clearInterval(monitor);
    if (!exitRecord) { try { ownedSignals('SIGTERM'); await delay(500); ownedSignals('SIGKILL'); } catch {} }
  }
}

if (process.env.AGENT_STAFF_LIVE !== '1') throw new Error('Opt-in required: AGENT_STAFF_LIVE=1');
const phase = process.argv[2];
if (phase === 'seed') {
  const r = await run('01-seed', `This is a bounded integration test. Remember this exact synthetic code for a later turn in this conversation: ${state.nonce}. Do not save it to files or memory. Read only fixture.txt in the current workspace and reply with the fixture value and the code. Do not run shell commands, edit files, call external tools, or spawn agents.`,
    ['--session-id', state.session, '--allow', 'Read', '--deny', 'Bash', '--deny', 'Edit', '--deny', 'Write', '--sandbox', 'workspace']);
  writeJSON(path.join(ROOT, '01-seed', 'assertions.json'), { nonceReturned: r.text.includes(state.nonce), fixtureReturned: r.text.includes(state.fixture), cleanExit: r.result.exit?.code === 0, noSurvivors: r.result.survivors.length === 0 });
} else if (phase === 'resume') {
  const r = await run('02-resume', 'Without using any tools or reading any files, return only the exact synthetic code that I asked you to remember in the previous turn of this conversation. Do not guess a new code.',
    ['--resume', state.session, '--deny', 'Bash', '--deny', 'Edit', '--deny', 'Write', '--deny', 'Read', '--sandbox', 'workspace']);
  writeJSON(path.join(ROOT, '02-resume', 'assertions.json'), { recalledNonce: r.text.includes(state.nonce), nativeSessionMatches: r.events.some(e => e.type === 'end' && e.sessionId === state.session), cleanExit: r.result.exit?.code === 0, noSurvivors: r.result.survivors.length === 0 });
} else if (phase === 'deny') {
  const r = await run('03-deny', `This is an authorized permission-enforcement integration test in this disposable workspace. First read fixture.txt. Then attempt exactly one write-tool call to create blocked-edit.txt containing DENIED_EDIT_PROBE. Also attempt exactly one shell-tool call: printf DENIED_SHELL_PROBE > blocked-shell.txt. A deliberate CLI deny policy may reject them; that rejection is the expected test outcome. Do not bypass a denial, use alternative tools, retry, or modify anything else. Report what actually happened.`,
    ['--session-id', randomUUID(), '--allow', 'Read', '--allow', 'Write', '--allow', 'Bash', '--deny', 'Bash', '--deny', 'Edit', '--deny', 'Write', '--sandbox', 'workspace']);
  writeJSON(path.join(ROOT, '03-deny', 'assertions.json'), { editAbsent: !fs.existsSync(path.join(WORKSPACE, 'blocked-edit.txt')), shellAbsent: !fs.existsSync(path.join(WORKSPACE, 'blocked-shell.txt')), positiveRead: r.events.some(e => e.type === 'tool_call_update' && JSON.stringify(e.rawOutput).includes(state.fixture)), attemptedTools: r.events.filter(e => e.type === 'tool_call').map(e => ({ id: e.toolCallId, name: e.toolName, kind: e.kind })), failedTools: r.events.filter(e => e.type === 'tool_call_update' && e.status === 'failed'), cleanExit: r.result.exit?.code === 0 });
} else if (phase === 'allow') {
  const target = path.join(WORKSPACE, 'allowed-edit.txt');
  const r = await run('04-allow', `This is an authorized bounded write test. Create only allowed-edit.txt in the current workspace using the write tool. Its exact content must be ALLOWED_EDIT_PROBE followed by one newline. Do not run shell commands or edit anything else. Then report the path written.`,
    ['--session-id', randomUUID(), '--allow', 'Read', '--allow', 'Write', '--allow', 'Edit', '--deny', 'Bash', '--sandbox', 'workspace']);
  writeJSON(path.join(ROOT, '04-allow', 'assertions.json'), { exactContent: fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'ALLOWED_EDIT_PROBE\n', cleanExit: r.result.exit?.code === 0, completedTools: r.events.filter(e => e.type === 'tool_call_update' && e.status === 'completed').map(e => e.toolCallId), noSurvivors: r.result.survivors.length === 0 });
} else if (phase === 'cancel') {
  state.cancelSession = randomUUID();
  state.cancelNonce = `cancel_memory_${randomUUID().replaceAll('-', '')}`;
  writeJSON(stateFile, state);
  const script = path.join(WORKSPACE, 'heartbeat.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync('tool-started.json', JSON.stringify({pid:process.pid,ppid:process.ppid,startedAt:new Date().toISOString()}));\nconst interval = setInterval(() => fs.appendFileSync('heartbeat.log', Date.now()+'\\n'), 300);\nsetTimeout(() => {clearInterval(interval);fs.writeFileSync('tool-completed.txt','UNEXPECTED_COMPLETION');}, 10000);\n`);
  const r = await run('05-cancel', `Remember this exact synthetic code only in this conversation: ${state.cancelNonce}. Run exactly this one shell command in the current workspace: ${process.execPath} heartbeat.mjs . This is a cancellation test: the harness will interrupt you after the tool writes its started marker. Do not run it a second time, do not background it manually, do not create other files, and do not spawn agents.`,
    ['--session-id', state.cancelSession, '--allow', `Bash(${process.execPath} heartbeat.mjs)`, '--allow', 'Read', '--deny', 'Edit', '--deny', 'Write', '--sandbox', 'workspace'],
    { cancelMarker: path.join(WORKSPACE, 'tool-started.json'), waitAfterMs: 12000 });
  writeJSON(path.join(ROOT, '05-cancel', 'assertions.json'), { toolStarted: fs.existsSync(path.join(WORKSPACE, 'tool-started.json')), completionAbsent: !fs.existsSync(path.join(WORKSPACE, 'tool-completed.txt')), canceledWhileRunning: r.result.stopReason === 'requested_cancel_after_tool_started', noSurvivors: r.result.survivors.length === 0, waitedPastToolCompletionMs: 12000 });
} else if (phase === 'cancel-resume') {
  if (!state.cancelSession) throw new Error('Run cancel first');
  const r = await run('06-cancel-resume', 'The previous command was intentionally canceled by the test harness. Do not restart it and do not use any tools. Return only the exact synthetic code I asked you to remember in the canceled turn of this conversation.',
    ['--resume', state.cancelSession, '--deny', 'Bash', '--deny', 'Edit', '--deny', 'Write', '--deny', 'Read', '--sandbox', 'workspace']);
  writeJSON(path.join(ROOT, '06-cancel-resume', 'assertions.json'), { recalledNonce: r.text.includes(state.cancelNonce), nativeSessionMatches: r.events.some(e => e.type === 'end' && e.sessionId === state.cancelSession), cleanExit: r.result.exit?.code === 0, completionAbsent: !fs.existsSync(path.join(WORKSPACE, 'tool-completed.txt')), noTools: !r.events.some(e => e.type === 'tool_call'), noSurvivors: r.result.survivors.length === 0 });
} else if (phase === 'limit') {
  const r = await run('07-turn-limit', 'Read fixture.txt using the read tool, then provide a one-sentence explanation of its value. Do not run any other tools or edit files.',
    ['--session-id', randomUUID(), '--allow', 'Read', '--deny', 'Bash', '--deny', 'Edit', '--deny', 'Write', '--sandbox', 'workspace'], { maxTurns: 1 });
  writeJSON(path.join(ROOT, '07-turn-limit', 'assertions.json'), { limitEventSeen: r.events.some(e => e.type === 'max_turns_reached'), nonzeroExit: r.result.exit?.code !== 0, nativeTerminal: r.events.filter(e => e.type === 'end'), exit: r.result.exit, observedText: r.text, noSurvivors: r.result.survivors.length === 0 });
} else {
  throw new Error(`Unknown phase: ${phase}`);
}

const phaseNames = { seed:'01-seed', resume:'02-resume', deny:'03-deny', allow:'04-allow', cancel:'05-cancel', 'cancel-resume':'06-cancel-resume', limit:'07-turn-limit' };
const assertions = JSON.parse(fs.readFileSync(path.join(ROOT, phaseNames[phase], 'assertions.json'), 'utf8'));
const falseKeys = Object.entries(assertions).filter(([,value]) => value === false).map(([key]) => key);
if (phase === 'deny' && assertions.failedTools.length < 2) falseKeys.push('fewer than two actual denied tool events');
if (falseKeys.length) throw new Error('Preflight assertion failure: '+falseKeys.join(', '));
