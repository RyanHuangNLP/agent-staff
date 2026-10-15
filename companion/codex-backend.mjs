import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excerpt } from './observation.mjs';

// Desktop builds may write this table, while CLI 0.142 expects a boolean.
// Override only that incompatible value for this process; never rewrite the
// user's config or discard their model, provider, authentication, or rules.
export function codexCompatibilityArgs(configFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')) {
  let config;
  try { config = fs.readFileSync(configFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return /^\s*\[\s*features\s*\.\s*context_management\s*\]\s*(?:#.*)?$/m.test(config)
    ? ['-c', 'features.context_management=false'] : [];
}

// Codex structured output requires closed objects and every property listed
// in required. Empty file/line strings represent findings without a location;
// the resulting report still satisfies the shared review validator.
export function codexReviewSchema(schema) {
  const result = JSON.parse(schema);
  const close = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      node.additionalProperties = false;
      node.required = Object.keys(node.properties || {});
      Object.values(node.properties || {}).forEach(close);
    }
    if (node.items) close(node.items);
  };
  close(result);
  return JSON.stringify(result);
}

export function codexArgs(invoke, { effort = invoke.effort, schemaFile, configArgs = [] } = {}) {
  if (invoke.isResume && !invoke.conversation) {
    throw Object.assign(new Error('Codex resume requires an explicit saved session ID.'), { reason: 'invalid_session' });
  }
  if (invoke.jsonSchema && !schemaFile) {
    throw Object.assign(new Error('Codex structured review requires a schema file.'), { reason: 'unsupported_capability' });
  }
  // Common exec options precede resume so cwd and sandbox also apply to a
  // resumed session. An explicit ID prevents accidentally resuming --last.
  const args = ['exec', '--json', '--color', 'never', '--skip-git-repo-check',
    '--cd', invoke.cwd || invoke.workspace, '-c', 'approval_policy="never"', ...configArgs];
  if (invoke.unrestricted) args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('--sandbox', 'read-only');
  if (invoke.model) args.push('--model', invoke.model);
  if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
  if (schemaFile) args.push('--output-schema', schemaFile);
  if (invoke.isResume) args.push('resume', invoke.conversation);
  // The task is piped over stdin, including when it starts with a dash or
  // exceeds an OS argv limit. Never include it in the command line as well.
  args.push('-');
  return args;
}

/** Project codex exec --json events; raw JSONL is retained by the runner. */
export function createCodexProjection(onConversation = () => {}) {
  const data = { last_event_at: null, recent_activities: [], latest_text: null, warnings: [] };
  const tools = new Map(), denials = new Map();
  let session = null, text = '', terminal = null, failure = null, sequence = 0;
  const warn = (message) => {
    if (!data.warnings.includes(message) && data.warnings.length < 5) data.warnings.push(message);
  };
  const updateText = (value) => {
    text = value;
    const preview = excerpt(value, 1700, true);
    data.latest_text = { text: preview.text, truncated: preview.truncated, updated_at: data.last_event_at, incomplete: true, status: 'running' };
  };
  const remember = (id) => {
    if (typeof id !== 'string' || !id) return;
    if (session && session !== id) throw Object.assign(new Error('Codex changed its native session ID during one run.'), { reason: 'protocol_error' });
    if (session !== id) { session = id; onConversation(id); }
  };
  const complete = () => {
    if (data.latest_text) {
      data.latest_text.incomplete = false;
      data.latest_text.status = failure ? 'error' : 'done';
    }
  };
  const tool = (item, eventType) => {
    if (typeof item.id !== 'string' || !item.id) { warn('Tool event without an ID retained in raw output.'); return; }
    let entry = tools.get(item.id);
    if (!entry) {
      entry = { id: item.id, step_index: sequence++, started_at: data.last_event_at, name: item.type, status: 'running' };
      tools.set(item.id, entry);
      if (tools.size > 500) { tools.delete(tools.keys().next().value); warn('Tool summary truncated; full events remain in raw output.'); }
    }
    const explicitError = item.error?.message || item.error;
    const failed = ['failed', 'declined', 'blocked'].includes(item.status) || !!explicitError ||
      (typeof item.exit_code === 'number' && item.exit_code !== 0);
    const output = explicitError || item.aggregated_output || item.result;
    const message = typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output);
    const denied = item.status === 'declined' || item.permission_denied === true ||
      (failed && /permission denied|denied by (?:permission|policy)|approval.*(?:denied|rejected)|sandbox.*(?:denied|blocked)|operation not permitted/i.test(message));
    entry.status = failed || denied ? 'error' : eventType === 'item.completed' ? 'done' : 'running';
    entry.updated_at = data.last_event_at;
    if (item.type === 'mcp_tool_call') entry.name = [item.server, item.tool].filter(Boolean).join('/') || item.type;
    const input = item.command ?? item.arguments ?? item.changes ?? item.query ?? item.input;
    if (input !== undefined) {
      const preview = excerpt(input, 240);
      Object.assign(entry, { input_preview: preview.text, input_truncated: preview.truncated });
    }
    if (message) {
      const preview = excerpt(message, 240);
      Object.assign(entry, { output_preview: preview.text, output_truncated: preview.truncated });
    }
    if (denied) {
      entry.permissionDenied = true;
      if (denials.has(item.id) || denials.size < 100) denials.set(item.id, { id: item.id, tool: entry.name, message: entry.output_preview || 'Denied by native permission policy.' });
      else warn('Permission-denial summary truncated; see raw output.');
      warn('Native permission policy denied a tool call; the turn may still complete successfully.');
    } else if (failed) warn('Tool reported an explicit error; see raw output.');
    data.recent_activities = [...tools.values()].slice(-5).map(({ name, id, ...fields }) => ({ ...fields, tool: name, tool_call_id: id }));
  };
  const accept = (event) => {
    if (!event || typeof event !== 'object') return;
    data.last_event_at = new Date().toISOString();
    switch (event.type) {
      case 'thread.started': remember(event.thread_id); return;
      case 'turn.started': return;
      case 'item.started': case 'item.updated': case 'item.completed': {
        const item = event.item;
        if (!item || typeof item !== 'object') { warn('Malformed item retained in raw output.'); return; }
        if (item.type === 'agent_message') {
          // Commentary and incomplete snapshots cannot become the answer.
          // Legacy streams have no phase; use their last complete message.
          if (event.type === 'item.completed' && item.phase !== 'commentary' && typeof item.text === 'string') updateText(item.text);
          return;
        }
        if (['reasoning', 'todo_list', 'plan', 'context_compaction'].includes(item.type)) return;
        if (item.type === 'error') { warn(excerpt(item.message || 'Codex reported an item error.', 240).text); return; }
        if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call', 'image_generation', 'custom_tool_call'].includes(item.type)) {
          tool(item, event.type); return;
        }
        warn('Unknown item retained in raw output.'); return;
      }
      case 'error':
        // Exec can emit connection/retry diagnostics before recovering. Only
        // the terminal turn event determines whether the turn succeeded.
        warn(excerpt(event.message || 'Codex reported an error.', 240).text); return;
      case 'turn.failed':
        terminal = event; failure = 'backend_error';
        warn(excerpt(event.error?.message || 'Codex turn failed.', 240).text);
        complete(); return;
      case 'turn.completed':
        terminal = event;
        if (!session) { failure ||= 'protocol_error'; warn('Codex completed without a thread ID.'); }
        complete(); return;
      default: warn('Unknown event retained in raw output.');
    }
  };
  const summary = () => terminal ? {
    status: failure ? 'ERROR' : 'SUCCESS', response: text, conversation_id: session, reason: failure,
    // Exec JSONL does not attest the selected model. Keep it distinct from
    // the requested model in the job; never invent an observed default.
    model: null, permissionDenials: [...denials.values()].map((item) => ({ ...item })),
    toolCalls: [...tools.values()].map((item) => ({ ...item })),
    native_stop_reason: terminal.type, usage: terminal.usage, native_error: terminal.error || null,
  } : null;
  return { accept, warn, snapshot: () => structuredClone(data), summary, partialText: () => text };
}
