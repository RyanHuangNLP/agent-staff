import { createProjection, excerpt } from './observation.mjs';

export const BACKENDS = ['agy', 'grok', 'cursor'];
export const STOP_POLICIES = Object.freeze({
  agy: [{ signal: 'SIGTERM', graceMs: 500 }, { signal: 'SIGKILL', graceMs: 500 }],
  grok: [{ signal: 'SIGTERM', graceMs: 1200 }, { signal: 'SIGKILL', graceMs: 1000 }],
  cursor: [{ signal: 'SIGINT', graceMs: 5000 }, { signal: 'SIGTERM', graceMs: 3000 }, { signal: 'SIGKILL', graceMs: 1000 }],
});

const unsupported = (message) => Object.assign(new Error(message), { reason: 'unsupported_capability' });

/** Build argv without a shell. Provider session IDs are allocated by the core. */
export function buildInvocation(backend, invoke, { mode = invoke.mode, promptFile, effort = invoke.effort } = {}) {
  if (!BACKENDS.includes(backend)) throw unsupported(`Unknown coding backend: ${backend}`);
  const binary = invoke.binary || (backend === 'agy' ? process.env.AGY_BIN || 'agy'
    : backend === 'grok' ? process.env.GROK_BIN || 'grok'
      : process.env.CURSOR_BIN || process.env.CURSOR_AGENT_BIN || 'cursor-agent');
  const command = (args) => /\.(?:mjs|cjs|js)$/i.test(binary)
    ? { binary: process.execPath, args: [binary, ...args] } : { binary, args };
  const { workspace, model, conversation, unrestricted, jsonSchema } = invoke;
  if (backend === 'agy') {
    const args = ['-p', invoke.prompt, '--model', model, '--output-format', 'stream-json', '--print-timeout', invoke.timeout, '--add-dir', workspace];
    if (conversation) args.push('--conversation', conversation);
    if (unrestricted) args.push('--dangerously-skip-permissions');
    if (jsonSchema) args.push('--json-schema', jsonSchema);
    return command(args);
  }
  if (jsonSchema) throw unsupported(`${backend} structured review schema is not supported by this adapter.`);
  if (backend === 'grok') {
    if (!conversation) throw Object.assign(new Error('Grok requires a preallocated session UUID or an explicit session to resume.'), { reason: 'invalid_session' });
    const args = ['--cwd', invoke.cwd || workspace, '--no-leader', '--no-memory', '--no-subagents',
      '--sandbox', 'workspace', '--permission-mode', unrestricted ? 'bypassPermissions' : 'dontAsk',
      '--output-format', 'streaming-json', invoke.isResume ? '--resume' : '--session-id', conversation];
    if (model) args.push('--model', model);
    if (effort) args.push('--reasoning-effort', effort);
    if (mode === 'ask') args.push('--tools', '', '--disable-web-search');
    if (invoke.maxTurns != null) args.push('--max-turns', String(invoke.maxTurns));
    if (promptFile) args.push('--prompt-file', promptFile);
    else args.push('--single', invoke.prompt);
    return command(args);
  }
  if (effort) throw unsupported('Cursor has no verified independent --effort mapping; pass a native parameterized --model instead.');
  const args = ['--print', '--output-format', 'stream-json', '--workspace', invoke.cwd || workspace, '--trust'];
  if (unrestricted) args.push('--force');
  if (model) args.push('--model', model);
  if (invoke.isResume) {
    if (!conversation) throw Object.assign(new Error('Cursor resume requires an explicit saved session ID.'), { reason: 'invalid_session' });
    args.push('--resume', conversation);
  }
  // "--" keeps a prompt beginning with a dash from becoming a CLI option.
  args.push('--', invoke.prompt);
  return command(args);
}

const contentText = (content) => Array.isArray(content) ? content.map((item) =>
  item?.type === 'text' ? item.text || '' : item?.type === 'content' ? contentText([item.content]) : '').join('') : '';

/** Native events are interpreted only in memory; the runner retains raw bytes. */
export function createBackendProjection(backend = 'agy', onConversation = () => {}) {
  if (backend === 'agy') return createProjection(onConversation);
  if (!BACKENDS.includes(backend)) throw unsupported(`Unknown coding backend: ${backend}`);
  const data = { last_event_at: null, recent_activities: [], latest_text: null, warnings: [] };
  const tools = new Map(), denials = new Map();
  let session = null, text = '', terminal = null, failure = null, observedModel = null, sequence = 0;
  const warn = (message) => {
    if (!data.warnings.includes(message) && data.warnings.length < 5) data.warnings.push(message);
  };
  const remember = (id) => {
    if (typeof id !== 'string' || !id) return;
    if (session && session !== id) throw Object.assign(new Error(`${backend} changed its native session ID during one run.`), { reason: 'protocol_error' });
    if (session !== id) { session = id; onConversation(id); }
  };
  const updateText = (value, append) => {
    text = append ? text + value : value;
    const preview = excerpt(text, 1700, true);
    data.latest_text = { text: preview.text, truncated: preview.truncated, updated_at: data.last_event_at, incomplete: true, status: 'running' };
  };
  const tool = (id, patch, denied = false) => {
    // IDs are opaque: Cursor's real IDs can contain embedded newlines.
    if (typeof id !== 'string' || !id) { warn('Tool event without an ID retained in raw output.'); return; }
    let item = tools.get(id);
    if (!item) {
      item = { id, step_index: sequence++, started_at: data.last_event_at, status: 'unknown', name: 'unknown' };
      tools.set(id, item);
      if (tools.size > 500) { tools.delete(tools.keys().next().value); warn('Tool summary truncated; full events remain in raw output.'); }
    }
    Object.assign(item, patch, { updated_at: data.last_event_at });
    if (denied) {
      item.permissionDenied = true;
      if (!denials.has(id) && denials.size >= 100) warn('Permission-denial summary truncated; see raw output.');
      else denials.set(id, { id, tool: item.name, message: item.output_preview || 'Denied by native permission policy.' });
      warn('Native permission policy denied a tool call; the turn may still complete successfully.');
    } else if (item.status === 'error') warn('Tool reported an explicit error; see raw output.');
    data.recent_activities = [...tools.values()].slice(-5).map(({ name, id: callId, ...entry }) => ({ ...entry, tool: name, tool_call_id: callId }));
  };
  const complete = () => {
    if (data.latest_text) {
      data.latest_text.incomplete = false;
      data.latest_text.status = failure ? 'error' : 'done';
    }
  };
  const accept = (event) => {
    data.last_event_at = new Date().toISOString();
    if (!event || typeof event !== 'object') return;
    if (backend === 'grok') {
      remember(event.sessionId);
      switch (event.type) {
        case 'text': if (typeof event.data === 'string') updateText(event.data, true); return;
        case 'thought': case 'available_commands': case 'usage': return;
        case 'tool_call': {
          const preview = excerpt(event.rawInput ?? '', 240);
          tool(event.toolCallId, { name: excerpt(event.toolName || event.title || 'unknown', 100).text,
            kind: event.kind, status: event.status === 'failed' ? 'error' : 'running',
            input_preview: preview.text, input_truncated: preview.truncated });
          return;
        }
        case 'tool_call_update': {
          const output = contentText(event.content) || (event.rawOutput == null ? '' : JSON.stringify(event.rawOutput));
          const preview = excerpt(output, 240);
          const patch = {};
          if (event.status) patch.status = event.status === 'failed' ? 'error' : event.status === 'completed' ? 'done' : 'running';
          if (output) Object.assign(patch, { output_preview: preview.text, output_truncated: preview.truncated });
          tool(event.toolCallId, patch, event.status === 'failed' && /denied by permission policy|permission denied|not executed.*denied/i.test(output));
          return;
        }
        case 'max_turns_reached': failure = 'turn_limit'; warn('Grok reached its turn limit before completing the task.'); return;
        case 'error':
          failure ||= 'backend_error'; warn(excerpt(event.message || event.error || event.data || 'Grok reported an error.', 240).text); return;
        case 'end':
          terminal = event;
          if (event.stopReason !== 'end_turn') failure ||= event.stopReason === 'cancelled' ? 'backend_cancelled' : 'backend_error';
          if (event.modelUsage) observedModel = Object.keys(event.modelUsage).join(', ') || null;
          complete(); return;
        default: warn('Unknown event retained in raw output.'); return;
      }
    }
    remember(event.session_id);
    switch (event.type) {
      case 'system': if (event.model) observedModel = event.model; return;
      case 'user': case 'thinking': return;
      case 'assistant':
        if (Array.isArray(event.message?.content)) updateText(contentText(event.message.content), false);
        return;
      case 'tool_call': {
        const entry = Object.entries(event.tool_call || {}).find(([key, value]) => /ToolCall$/.test(key) && value && typeof value === 'object')
          || (event.tool_call?.function ? ['function', event.tool_call.function] : null);
        if (!entry) { warn('Unrecognized tool event retained in raw output.'); return; }
        const [name, body] = entry;
        const result = body.result;
        const denied = !!(result?.permissionDenied || result?.writePermissionDenied);
        const error = denied ? result.permissionDenied || result.writePermissionDenied : result?.error || result?.failure;
        const patch = { name: body.name || name, status: event.subtype === 'completed' ? (error ? 'error' : 'done') : 'running' };
        if (body.args !== undefined || body.arguments !== undefined) {
          const preview = excerpt(body.args ?? body.arguments, 240);
          Object.assign(patch, { input_preview: preview.text, input_truncated: preview.truncated });
        }
        if (result !== undefined) {
          const preview = excerpt(error || result, 240);
          Object.assign(patch, { output_preview: preview.text, output_truncated: preview.truncated });
        }
        tool(event.call_id || event.tool_call?.toolCallId, patch, denied);
        return;
      }
      case 'result':
        terminal = event;
        if (event.is_error || event.subtype !== 'success') failure ||= 'backend_error';
        if (!data.latest_text) warn('No assistant message was observed; the native aggregate result remains only in raw output.');
        complete(); return;
      case 'error': failure ||= 'backend_error'; warn(excerpt(event.message || event.error || 'Cursor reported an error.', 240).text); return;
      default: warn('Unknown event retained in raw output.');
    }
  };
  const summary = () => terminal ? {
    status: failure ? (failure === 'turn_limit' ? 'ATTENTION' : 'ERROR') : 'SUCCESS',
    response: text, conversation_id: session, reason: failure, model: observedModel,
    permissionDenials: [...denials.values()].map((x) => ({ ...x })),
    toolCalls: [...tools.values()].map((x) => ({ ...x })),
    native_stop_reason: backend === 'grok' ? terminal.stopReason : terminal.subtype,
    usage: terminal.usage, duration_ms: terminal.duration_ms,
    native_error: terminal.error || null,
  } : null;
  return { accept, warn, snapshot: () => structuredClone(data), summary, partialText: () => text };
}
