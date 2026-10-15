#!/usr/bin/env node
// A native-protocol subprocess fixture. It never runs a model or uses network.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const env = process.env;
const argv = process.argv.slice(2);
const value = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');

// The child deliberately owns another POSIX group. Killing only the CLI group
// must not satisfy the cancellation tests below.
if (argv[0] === '--owned-child') {
  fs.writeFileSync(env.FAKE_CODING_CHILD_READY, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
  const timer = setInterval(() => fs.appendFileSync(env.FAKE_CODING_HEARTBEAT, 'tick\n'), 40);
  setTimeout(() => {
    clearInterval(timer);
    fs.writeFileSync(env.FAKE_CODING_COMPLETION, 'SHOULD_NOT_COMPLETE');
    process.exit(0);
  }, 30000);
  await new Promise(() => {});
}

if (argv.includes('--version')) {
  process.stdout.write('fake-coding-agent 1.0.0\n');
  process.exit(0);
}

const format = value('--output-format');
const backend = argv[0] === 'exec' ? 'codex' : format === 'streaming-json' ? 'grok' : 'cursor';
const resume = backend === 'codex' ? value('resume') : value('--resume');
const session = resume || value('--session-id') || env.FAKE_CODING_SESSION || randomUUID();
const promptFile = value('--prompt-file');
const scenario = env.FAKE_CODING_SCENARIO || 'success';
if (scenario === 'startup_error') {
  process.stderr.write('FAKE_NATIVE_STARTUP_ERROR: invalid configuration\n');
  process.exit(1);
}
const prompt = backend === 'codex' ? fs.readFileSync(0, 'utf8') : promptFile ? fs.readFileSync(promptFile, 'utf8')
  : value('--single') ?? argv.at(-1) ?? '';
if (env.FAKE_CODING_CALLS) {
  const schemaFile = value('--output-schema');
  const schema = schemaFile ? JSON.parse(fs.readFileSync(schemaFile, 'utf8')) : null;
  fs.appendFileSync(env.FAKE_CODING_CALLS, JSON.stringify({ backend, argv, cwd: process.cwd(), prompt, session, schema }) + '\n');
}

if (backend === 'codex') {
  if (scenario !== 'missing_session') emit({ type: 'thread.started', thread_id: session });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'reasoning-1', type: 'reasoning', text: 'PRIVATE_THINKING_SENTINEL' } });
  emit({ type: 'item.completed', item: { id: 'progress-1', type: 'agent_message', phase: 'commentary', text: 'CODEX_PROGRESS_ONLY' } });
} else if (backend === 'cursor') {
  emit({ type: 'system', subtype: 'init', session_id: session, model: value('--model') || 'Cursor native default' });
  emit({ type: 'thinking', subtype: 'delta', text: 'PRIVATE_THINKING_SENTINEL', session_id: session });
  emit({ type: 'thinking', subtype: 'completed', session_id: session });
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CURSOR_PROGRESS_ONLY' }] }, session_id: session });
} else {
  emit({ type: 'available_commands', tools: ['read_file', 'write'], commands: [] });
  emit({ type: 'thought', data: 'PRIVATE_THINKING_SENTINEL' });
}

if (scenario === 'denied') {
  if (backend === 'grok') {
    emit({ type: 'tool_call', toolCallId: 'grok-write-1', title: 'write', toolName: 'write', kind: 'edit', status: 'pending', rawInput: { file_path: 'protected.txt' } });
    emit({ type: 'tool_call_update', toolCallId: 'grok-write-1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Denied by permission policy: deny rule on edit' } }], rawOutput: null });
  } else if (backend === 'codex') {
    emit({ type: 'item.started', item: { id: 'codex-write-1', type: 'command_execution', command: 'write protected.txt', status: 'in_progress' } });
    emit({ type: 'item.completed', item: { id: 'codex-write-1', type: 'command_execution', command: 'write protected.txt', status: 'failed', exit_code: 1, aggregated_output: 'Permission denied by sandbox policy' } });
  } else {
    const call = 'cursor-write\ncall-1';
    emit({ type: 'tool_call', subtype: 'started', call_id: call, session_id: session, tool_call: { toolCallId: call, editToolCall: { args: { path: 'protected.txt', streamContent: 'FORBIDDEN' } } } });
    emit({ type: 'tool_call', subtype: 'completed', call_id: call, session_id: session, tool_call: { toolCallId: call, editToolCall: { result: { writePermissionDenied: { path: 'protected.txt', error: 'Write permission denied: Blocked by permissions configuration', isReadonly: false } } } } });
  }
}

if (env.FAKE_CODING_CHILD_READY) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--owned-child'], {
    detached: true, stdio: 'ignore', env, windowsHide: true,
  });
  child.unref();
  const until = Date.now() + 3000;
  while (!fs.existsSync(env.FAKE_CODING_CHILD_READY) && Date.now() < until) await delay(10);
  if (!fs.existsSync(env.FAKE_CODING_CHILD_READY)) throw new Error('Fixture child did not start');
  if (backend === 'grok') emit({ type: 'tool_call', toolCallId: 'long-tool', toolName: 'run_terminal_command', title: 'bounded shell fixture', kind: 'execute', status: 'in_progress', rawInput: { command: 'fixture-child' } });
  else if (backend === 'codex') emit({ type: 'item.started', item: { id: 'long-tool', type: 'command_execution', command: 'fixture-child', status: 'in_progress' } });
  else emit({ type: 'tool_call', subtype: 'started', call_id: 'long-tool', session_id: session, tool_call: { toolCallId: 'long-tool', shellToolCall: { args: { command: 'fixture-child' } } } });
}

await delay(Number(env.FAKE_CODING_DELAY_MS || 80));
if (env.FAKE_CODING_RELEASE) {
  const deadline = Date.now() + 25000;
  while (!fs.existsSync(env.FAKE_CODING_RELEASE) && Date.now() < deadline) await delay(20);
}

const response = env.FAKE_CODING_RESPONSE ?? `${backend} answer 中文`;
if (backend === 'grok') {
  const text = scenario === 'turn_limit' ? 'I will inspect the file.' : response;
  // Neither the nonce nor Unicode answer is present as one NDJSON data field.
  for (const part of Array.from(text)) emit({ type: 'text', data: part });
  if (scenario === 'turn_limit') emit({ type: 'max_turns_reached', maxTurns: 1 });
  if (scenario !== 'missing_result') emit({ type: 'end', stopReason: scenario === 'turn_limit' ? 'cancelled' : scenario === 'error' ? 'error' : 'end_turn', sessionId: session, requestId: `request-${session}`, usage: { input_tokens: 1, output_tokens: 2 }, num_turns: 1, modelUsage: { [value('--model') || 'grok-native-observed']: { inputTokens: 1, outputTokens: 2 } } });
} else if (backend === 'codex') {
  if (scenario === 'recovered_error') emit({ type: 'error', message: 'Reconnecting after a transient connection failure' });
  emit({ type: 'item.completed', item: { id: 'answer-1', type: 'agent_message', text: response } });
  if (scenario !== 'missing_result') emit(scenario === 'error'
    ? { type: 'turn.failed', error: { message: 'Codex fixture failure' } }
    : { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } });
} else {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: response }] }, session_id: session });
  if (scenario !== 'missing_result') emit({ type: 'result', subtype: scenario === 'error' ? 'error' : 'success', is_error: scenario === 'error', result: `CURSOR_PROGRESS_ONLY${response}`, session_id: session, request_id: `request-${session}`, duration_ms: 1, duration_api_ms: 1, usage: { inputTokens: 1, outputTokens: 2 } });
}
await new Promise(resolve => process.stdout.write('', resolve));
process.exit(['turn_limit', 'error', 'nonzero_exit'].includes(scenario) ? 1 : 0);
