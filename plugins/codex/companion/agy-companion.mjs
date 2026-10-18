#!/usr/bin/env node
/**
 * agy-companion — the single brain of the agy-staff plugin.
 *
 * Wraps Google's Antigravity CLI (`agy`) so Claude Code and OpenAI Codex can
 * delegate work to Gemini via five modes: staffer (general-purpose), research,
 * review, implement, ask.
 *
 * Subcommands:
 *   staffer | research | review | implement
 *                                   run a task as a background job (staffer is
 *                                   the general-purpose mode: a minimal prompt
 *                                   with no role or output-format framing)
 *   ask --prompt <question>         cheap zero-tool one-shot Q&A (foreground)
 *   continue --prompt <text>        continue the most recent conversation (any mode)
 *   observe [job-id]                immediate bounded snapshot in every job state
 *   restart <job-id>                explicitly relaunch the stored task
 *   status [job-id]                 list background jobs / show one job
 *   wait [job-id] [--timeout 100s]  block until the job finishes, then print
 *                                   its result (exit 2 = still running: call
 *                                   it again)
 *   result [job-id]                 print the stored output of a finished job
 *   cancel <job-id>                 kill a running background job
 *   setup [--apply]                 optional: install the evidence-gathering
 *                                   command allowlist used by restricted runs
 *   setup --restrict <modes|none>   optional: per-repo policy — make the listed
 *                                   modes default to the restricted profile in
 *                                   this repository (.agy-staff/config.json)
 *   _worker <job-id>                (internal) background job executor
 *
 * Uniform flags:
 *   --job <id>            continue a specific job with its original configuration
 *   --conversation <id>   resume a specific agy conversation
 *   --continue            reuse the last conversation id for this mode
 *   --model <id>          explicit agy model id (overrides --effort)
 *   --effort <l|m|h>      low|medium|high → gemini-3.8-flash-<effort>
 *   --restricted          hardening opt-in: keep agy's permission enforcement
 *                         on (wants setup's evidence-gathering allowlist)
 *   --unrestricted        pass --dangerously-skip-permissions (already the
 *                         default for research/review/implement)
 *   --json                (review) ask agy for schema-enforced JSON findings
 *   --timeout <dur>       background hard limit (default 60m, maximum 120m); ask response timeout
 *   --prompt <text>       the task text as one opaque argv value
 *   --prompt-file <path>  read the task text from a file (long prompts)
 *   --stdin               read the task text from stdin
 *
 * Task text for the run commands (staffer/research/review/implement/ask and
 * continue) comes from exactly one of --prompt, --prompt-file, or --stdin.
 * argv is parsed once, exactly as the shell delivered it, and the task value
 * travels whole: never re-split, never scanned. Flag-like text inside a task
 * (`--check`, `--json`, an unknown `--whatever`) is therefore ordinary prompt
 * content and reaches agy byte for byte.
 *
 * Permissions: all tool-using modes (staffer/research/review/implement) run
 * unrestricted by default, so they work out of the box with no setup;
 * --restricted is the hardening opt-in that relies on the evidence-gathering
 * allowlist installed by `setup`. ask is tool-free and always restricted.
 * Profile precedence: CLI flag > project policy (.agy-staff/config.json,
 * written by `setup --restrict`) > built-in default. The policy is a run
 * policy for per-repo consistency, not a security boundary.
 * The guardrails against irreversible side effects live in the prompt
 * templates, backed by two tiered checks here: implement treats dirty
 * workspaces as bounded prompt context, while staffer/review/research snapshot
 * `git status --porcelain` around the run and report any delta with the result
 * without ever blocking.
 *
 * Output split: stdout carries the deliverable — agy's response plus any guard
 * warning about the working tree. The `[agy-staff]` telemetry line (mode,
 * profile, model, duration, tokens, conversation id) goes to stderr, and for
 * background jobs into `jobs/<id>.log`; it is metadata for the calling agent,
 * never something to show the user.
 *
 * Execution style is fixed per mode and cannot be overridden: ask runs in the
 * foreground; staffer/research/review/implement run as detached background
 * jobs whose output is collected with wait/status/result/cancel.
 *
 * Job exit codes (`status <id>` and `wait`): 0 = done, 2 = running (for wait:
 * still running when its own timeout expired — call it again), 3 = error or
 * crashed, 4 = canceled, 5 = attention (resumable timeout). 1 stays the generic companion error (bad id, etc.),
 * so a caller can loop on "exit code 2" with zero output parsing.
 *
 * Review is prompt-based: the subject ("Review PR #730", "Review changes
 * against master") is described in the task text and agy gathers the evidence
 * itself with its own tools.
 *
 * No dependencies beyond the Node standard library.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { boundSnapshot, excerpt } from './observation.mjs';
import { atomicJSON, runStreaming, processIdentity, processTable, stopExecution } from './stream-worker.mjs';
import { withStateLock, replaceFile, readTextRetry } from './state-lock.mjs';
import { BACKENDS, BACKEND_TITLES, buildInvocation } from './backend-adapters.mjs';
import { codexCompatibilityArgs, codexReviewSchema } from './codex-backend.mjs';
import { modelCatalog } from './model-catalog.mjs';

const SELF = fileURLToPath(import.meta.url);
const TEMPLATES_DIR = path.join(path.dirname(SELF), '..', 'templates');
const AGY_BIN = process.env.AGY_BIN || 'agy';
const BACKEND = process.env.AGENT_STAFF_BACKEND || 'agy';
const STAFF_NAME = `${BACKEND}-staff`;
const KEEP_LOGS = process.env.AGENT_STAFF_KEEP_LOGS === '1';

function assertBackend(record, label = 'record') {
  // Older AGY state predates the backend field and remains readable in place.
  if ((record?.backend || 'agy') !== BACKEND) {
    die(`BACKEND_MISMATCH: ${label} belongs to ${record?.backend || 'agy'}, not ${BACKEND}`);
  }
}

/** How to launch agy. AGY_BIN normally names an executable; when it names a
 *  Node script (the test fake), run it through the current Node binary so the
 *  launch does not depend on shebang support (Windows has none: EFTYPE). */
function agyCommand(args) {
  if (/\.(mjs|cjs|js)$/i.test(AGY_BIN)) return { cmd: process.execPath, args: [AGY_BIN, ...args] };
  return { cmd: AGY_BIN, args };
}
const AGY_SETTINGS = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');

const MODES = ['staffer', 'research', 'review', 'implement', 'ask'];

const DEFAULTS = {
  model: {
    staffer: 'gemini-3.8-flash-medium',
    research: 'gemini-3.8-flash-high',
    review: 'gemini-3.8-flash-medium',
    implement: 'gemini-3.8-flash-high',
    ask: 'gemini-3.8-flash-low',
  },
  // Every tool-using mode is unrestricted by default: headless agy denies
  // unlisted tool calls, so a restricted default made research/review come
  // back empty until the user ran `setup`. --restricted is the opt-in.
  // ask is tool-free, so its profile is irrelevant and stays restricted.
  profile: {
    staffer: 'unrestricted',
    research: 'unrestricted',
    review: 'unrestricted',
    implement: 'unrestricted',
    ask: 'restricted',
  },
  timeout: { staffer: '60m', research: '60m', review: '60m', implement: '60m', ask: '2m' },
  // Background-first: only ask (seconds-long, tool-free) stays in the foreground.
  // No flag overrides this; execution style is a property of the mode.
  background: { staffer: true, research: true, review: true, implement: true, ask: false },
};

// agy only accepts effort-suffixed model ids; bare family names are rejected
// with status ERROR ("--model gemini-3.8-flash requires --effort").
// Known ids from `agy models` (v1.1.13):
const KNOWN_MODELS = new Set([
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
  'gemini-3.5-flash-high', 'gemini-3.5-flash-medium', 'gemini-3.5-flash-low',
  'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
  'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
]);
const MODEL_FAMILIES = {
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.7-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': ['low', 'medium', 'high'],
  'gemini-3.5-flash': ['low', 'medium', 'high'],
  'gemini-3.1-pro': ['low', 'high'],
};
const MODEL_ALIASES = { flash: 'gemini-3.8-flash', pro: 'gemini-3.1-pro' };

/** Normalize a user-supplied --model value to an id agy accepts, or die
 *  pre-flight with a helpful message. Never lets a bare family reach agy. */
function normalizeModel(raw, effort) {
  const name = MODEL_ALIASES[raw] || raw;
  if (KNOWN_MODELS.has(name)) return name;
  const efforts = MODEL_FAMILIES[name];
  if (efforts) {
    let e = effort || 'medium';
    if (!efforts.includes(e)) {
      // e.g. gemini-3.1-pro has no medium: fall back to its highest tier
      const fallback = efforts[efforts.length - 1];
      process.stderr.write(`agy-staff: ${name} has no "${e}" effort; using ${name}-${fallback}\n`);
      e = fallback;
    }
    return `${name}-${e}`;
  }
  // future-tolerance: pass through anything already effort-suffixed
  if (/-(low|medium|high|thinking)$/.test(name)) return name;
  die(
    `unknown model id "${raw}". agy needs effort-suffixed ids, e.g. ` +
      `gemini-3.8-flash-low|medium|high, gemini-3.1-pro-low|high. ` +
      `Aliases accepted here: "flash" (gemini-3.8-flash), "pro" (gemini-3.1-pro), ` +
      `optionally combined with --effort. Run \`agy models\` for the full list.`
  );
}

// Optional GLOBAL setup rules. AGY owns prefix matching and deny precedence;
// the small deny list prevents common mistakes, not every destructive action.
const EVIDENCE_ALLOWLIST = [
  'command(git)',
  'command(gh)',
  'command(cat)',
  'command(head)',
  'command(ls)',
  'command(grep)',
  'command(find)',
  'command(rg)',
  'command(wc)',
];
const EVIDENCE_DENYLIST = [
  'command(git push)',
  'command(git reset --hard)',
  'command(git clean)',
  'command(gh pr merge)',
  'command(gh release delete)',
];

// ~200KB task-text ceiling; macOS ARG_MAX is ~1MB and the prompt
// travels as a single argv entry.
const MAX_INLINE_BYTES = 200 * 1024;
const MAX_DIRTY_STATUS_LINES = 100;
const MAX_DIRTY_STATUS_BYTES = 16 * 1024;

const REVIEW_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'nit'] },
          file: { type: 'string' },
          line: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['severity', 'title', 'detail'],
      },
    },
    could_not_verify: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary', 'findings', 'could_not_verify'],
});

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

let inWorker = false;
function die(msg, code = 1) {
  if (inWorker) throw new Error(msg);
  process.stderr.write(`${STAFF_NAME} error: ${msg}\n`);
  throw Object.assign(new Error(msg), { exitCode: code, alreadyPrinted: true });
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });
  return { code: r.status ?? -1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const repoRootCache = new Map();
function repoRoot() {
  const cwd = process.cwd();
  if (repoRootCache.has(cwd)) return repoRootCache.get(cwd);
  const r = sh('git', ['rev-parse', '--show-toplevel']);
  // git prints forward slashes even on Windows; normalize so the root compares
  // equal to process.cwd()-derived paths and reads naturally in agy arguments.
  const root = r.code === 0 && r.out ? path.normalize(r.out) : cwd;
  repoRootCache.set(cwd, root);
  return root;
}

function stateDir() {
  return path.join(repoRoot(), `.${STAFF_NAME}`);
}

function statePath() {
  return path.join(stateDir(), 'state.json');
}

function configPath() {
  return path.join(stateDir(), 'config.json');
}

// Modes whose default profile can be set per repo. ask is tool-free and
// always restricted, so it is not configurable.
const CONFIGURABLE_MODES = ['staffer', 'research', 'review', 'implement'];

/** Project policy (per-repo default profiles), written by `setup --restrict`.
 *  Missing file → null. Invalid file → die: a policy that is silently ignored
 *  is worse than an error. */
function loadProjectConfig() {
  let raw;
  try {
    raw = readTextRetry(configPath());
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    die(`cannot read project config ${configPath()}: ${error.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    die(`project config is corrupt: ${configPath()} — fix or delete it, then retry`);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) die(`project config must be an object: ${configPath()}`);
  if (Object.hasOwn(cfg, 'defaults')) validateModelDefaults(cfg.defaults);
  for (const [m, p] of Object.entries(cfg.profiles || {})) {
    if (!CONFIGURABLE_MODES.includes(m)) {
      die(
        `project config: unknown mode "${m}" in ${configPath()} ` +
          `(configurable: ${CONFIGURABLE_MODES.join(', ')}; ask is always restricted)`
      );
    }
    if (p !== 'restricted' && p !== 'unrestricted') {
      die(`project config: profile for ${m} must be "restricted" or "unrestricted", got "${p}" (${configPath()})`);
    }
  }
  return cfg;
}

function validateModelDefaults(defaults) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) die('project config: defaults must be an object');
  for (const [key, value] of Object.entries(defaults)) {
    if (!['model', 'effort'].includes(key)) die(`project config: unknown model default ${key}`);
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.startsWith('--'))) die(`project config: ${key} must be a nonempty string or null`);
  }
  validateEffort(defaults.effort);
  if (BACKEND === 'agy' && defaults.model) {
    const family = MODEL_ALIASES[defaults.model] || defaults.model.replace(/-(low|medium|high)$/, '');
    if (defaults.effort && !MODEL_FAMILIES[family]?.includes(defaults.effort)) {
      die(`model ${defaults.model} has no supported separate effort ${defaults.effort}; choose a listed concrete ID with --effort default, or a supported family/effort combination`);
    }
    normalizeModel(defaults.model, defaults.effort);
  }
}

function validateEffort(effort) {
  if (effort == null) return;
  if (BACKEND === 'cursor') die('UNSUPPORTED_CAPABILITY: Cursor has no supported --effort mapping; use its native --model value.');
  if (BACKEND === 'agy' && !['low', 'medium', 'high'].includes(effort)) die('--effort must be low|medium|high');
  if (!/^[a-z][a-z0-9_-]*$/.test(effort)) die('--effort must be a native reasoning level or default');
}

function modelOption(value) { return value === 'default' ? null : value; }

// Per-field precedence: explicit invocation > saved conversation > project >
// original backend defaults. A recorded null means native default, not a hole
// to fill from a project preference added after the conversation started.
function resolveModel(mode, opts, project, prior = null) {
  let model = opts.model !== undefined ? modelOption(opts.model) : (prior ? prior.model : project?.model) || null;
  const requestedEffort = opts.effort !== undefined ? modelOption(opts.effort) : (prior ? prior.effort : project?.effort) || null;
  validateEffort(requestedEffort);
  if (BACKEND !== 'agy') return { model, effort: requestedEffort };
  // AGY encodes effort in model IDs. Preserve an explicit concrete ID; when
  // changing only effort, keep the saved Gemini family rather than switching
  // a pro conversation back to the built-in Flash family.
  if (model && requestedEffort && opts.model === undefined) {
    const family = model.replace(/-(low|medium|high)$/, '');
    if (MODEL_FAMILIES[family]) model = family;
  }
  model = model ? normalizeModel(model, requestedEffort)
    : requestedEffort ? `gemini-3.8-flash-${requestedEffort}` : DEFAULTS.model[mode];
  return { model, effort: null };
}

function updateProjectConfig(change) {
  ensureStateDir();
  return withStateLock(path.join(stateDir(), '.config.lock'), () => {
    const cfg = loadProjectConfig() || {};
    change(cfg);
    if (Object.keys(cfg).length) atomicJSON(configPath(), cfg);
    else fs.rmSync(configPath(), { force: true });
    return cfg;
  });
}

function cmdConfig(opts) {
  if (opts._.length || Object.keys(opts).some(key => !['_', 'model', 'effort', 'reset'].includes(key))) {
    die('usage: config [--model ID|default] [--effort LEVEL|default] | config --reset');
  }
  const changing = opts.model !== undefined || opts.effort !== undefined;
  if (opts.reset && changing) die('config --reset cannot be combined with --model or --effort');
  let cfg;
  if (changing || opts.reset) {
    cfg = updateProjectConfig(current => {
      if (opts.reset) { delete current.defaults; return; }
      const defaults = { model: null, effort: null, ...current.defaults };
      if (opts.model !== undefined) defaults.model = modelOption(opts.model);
      if (opts.effort !== undefined) defaults.effort = modelOption(opts.effort);
      // If only effort changes, a previously saved concrete Gemini ID must
      // change within its own family too. Persist the family for later edits.
      if (BACKEND === 'agy' && defaults.model && defaults.effort) {
        const family = defaults.model.replace(/-(low|medium|high)$/, '');
        if (MODEL_FAMILIES[family]) defaults.model = family;
      }
      validateModelDefaults(defaults);
      current.defaults = defaults;
    });
  } else cfg = loadProjectConfig() || {};
  process.stdout.write(JSON.stringify({ backend: BACKEND, path: configPath(), configured: Object.hasOwn(cfg, 'defaults'),
    defaults: cfg.defaults || null }, null, 2) + '\n');
}

/** Create .agy-staff/ on first use and keep it out of `git status`.
 *  .git/info/exclude is repo-local and untracked — never the team's
 *  .gitignore. Best-effort: a read-only .git must not block a run. */
function ensureStateDir() {
  const dir = stateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (sh('git', ['check-ignore', '-q', dir]).code !== 0) {
      const p = sh('git', ['rev-parse', '--git-path', 'info/exclude']);
      if (p.code === 0 && p.out) {
        try {
          fs.appendFileSync(path.resolve(p.out), `.${STAFF_NAME}/\n`);
        } catch {}
      }
    }
  }
  return dir;
}

function loadState() {
  let raw;
  try {
    raw = readTextRetry(statePath());
  } catch (error) {
    // Only a missing file means "no state yet". Anything else must not be
    // mistaken for an empty state: callers write it back and would wipe jobs.
    if (error.code === 'ENOENT') return { backend: BACKEND, conversations: {}, last: null, jobs: [] };
    die(`cannot read state file ${statePath()}: ${error.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    // Never silently reset: every caller writes the state back, which would
    // wipe all job records and conversation ids.
    die(`state file is corrupt: ${statePath()} — fix or delete it, then retry`);
  }
  assertBackend(state, 'state');
  for (const job of state.jobs || []) assertBackend(job, `job ${job.id}`);
  return state;
}

function saveState(state) {
  state.backend = BACKEND;
  ensureStateDir();
  // Atomic replace: a detached worker and a status/result call can read this
  // file at any moment; a plain truncate-then-write leaves a torn window.
  const tmp = statePath() + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  replaceFile(tmp, statePath());
}

function updateState(change) {
  ensureStateDir();
  return withStateLock(statePath() + '.lock', () => {
    const state = loadState();
    const value = change(state);
    saveState(state);
    return value;
  });
}

function updateJob(id, fields, terminal = false) {
  return updateState((state) => {
    const job = state.jobs?.find((j) => j.id === id);
    if (!job) throw new Error(`Missing job ${id}`);
    if (terminal && job.status !== 'running') return job;
    Object.assign(job, fields);
    return job;
  });
}

function finishJob(id, output, fields, { reconcile = false } = {}) {
  return updateState((state) => {
    const job = state.jobs?.find((j) => j.id === id);
    if (!job) throw new Error(`Missing job ${id}`);
    if (typeof fields === 'function') fields = fields(job);
    if (job.status !== 'running' && !(job.status === 'canceled' && fields.status === 'canceled') &&
        !(reconcile && ['attention', 'crashed'].includes(job.status))) return job;
    if (job.cancel_requested_at && fields.status !== 'canceled' && fields.reason !== 'cleanup_unverified') throw Object.assign(new Error('Execution canceled.'), { reason: 'canceled' });
    const final = { ...fields, finished_at: new Date().toISOString() };
    const completed = { ...job, ...final };
    fs.writeFileSync(job.result_file, typeof output === 'function' ? output(completed) : output);
    atomicJSON(job.result_file + '.status.json', final);
    Object.assign(job, final);
    return job;
  });
}

function rememberConversation(resolved, id, jobId) {
  if (!id) return;
  assertBackend(resolved, 'invocation');
  if (BACKEND !== 'agy' && resolved.conversation && resolved.conversation !== id) {
    throw Object.assign(new Error(`Native session changed from ${resolved.conversation} to ${id}`), { reason: 'session_mismatch' });
  }
  if (BACKEND !== 'agy') resolved.conversation = id;
  updateState((state) => {
    // Publish the id and its foreground hold together. Cursor names that id in
    // a stream event before the process exits; the follow-up must see both.
    noteForeground(state, resolved, id);
    state.conversations ||= {};
    state.conversations[resolved.mode] = id;
    state.last = { backend: BACKEND, mode: resolved.mode, id, model: resolved.model, effort: resolved.effort, profile: resolved.profile };
    state.conversation_configs ||= {};
    state.conversation_configs[id] = { backend: BACKEND, mode: resolved.mode, model: resolved.model,
      effort: resolved.effort, profile: resolved.profile, json: !!resolved.json, cwd: process.cwd() };
    const job = state.jobs?.find((j) => j.id === jobId);
    if (job) job.conversation_id = id;
  });
  if (!resolved.background) resolved.foregroundHold = id;
}

function pidAlive(pid) {
  if (pid == null) return true; // registered, pid backfill pending — treat as running
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const VALUE_FLAGS = new Set(['job', 'conversation', 'model', 'effort', 'timeout', 'restrict', 'prompt', 'prompt-file']);
const BOOL_FLAGS = new Set(['continue', 'restricted', 'unrestricted', 'json', 'apply', 'dry-run', 'stdin', 'reset']);

// Flags dropped in 0.2. They get their own error instead of falling through to
// "unknown flag", so a 0.1 caller learns what replaced them.
const REMOVED_REVIEW_FLAGS = new Set(['diff-file', 'pr', 'target']);
const REMOVED_EXEC_FLAGS = new Set(['background', 'wait']);

// Deprecated 0.1 spellings, kept for one release and undocumented.
const FLAG_ALIASES = { strict: 'restricted', loose: 'unrestricted' };
const warnedAliases = new Set();

function migrationDie(name) {
  if (REMOVED_REVIEW_FLAGS.has(name)) {
    die(
      `--${name} was removed in 0.2: review is prompt-based now. Describe the subject in the prompt, ` +
        `e.g. \`review --prompt "Review PR #730"\` or \`review --prompt "Review changes against master"\`.`
    );
  }
  die(
    `--${name} was removed in 0.2: execution style is fixed per mode (ask runs in the foreground; ` +
      `research/review/implement run as background jobs). Use status/result/cancel to manage jobs.`
  );
}

/** A flag name that still contains whitespace means the caller packed several
 *  arguments (and usually the task) into one quoted string. The companion does
 *  not split argument strings, so say so and name the fix. */
function packedArgumentDie(name, raw) {
  const first = name.split(/\s+/)[0] || '';
  const shown = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
  die(
    `unknown flag --${first}: the whole string "${shown}" arrived as a single argument. ` +
      `agy-staff parses argv exactly as the shell delivers it and never splits an argument into flags — ` +
      `pass each flag as its own argument and put the task text in --prompt, ` +
      `e.g. \`review --restricted --prompt "Review PR #730"\`.`
  );
}

/** Reject a value flag whose value is missing, empty, or itself flag-shaped.
 *  An empty value is a caller mistake worth surfacing rather than a default
 *  request, and a flag-shaped value almost always means the value was
 *  forgotten (`ask --prompt --json`). The one exception is
 *  --prompt with a value containing whitespace: that is a real sentence that
 *  happens to start with `--`, and prompt bytes are never second-guessed. */
function checkValue(name, v) {
  if (v === undefined || v === '') die(`flag --${name} needs a value`);
  if (!v.startsWith('--')) return;
  if (name === 'prompt') {
    if (/\s/.test(v)) return;
    die(
      `flag --prompt needs a value (if your prompt really starts with --, ` +
        `quote the full sentence or use --prompt-file)`
    );
  }
  die(`flag --${name} needs a value`);
}

/**
 * Parse the shell's argv once. Values are taken verbatim: nothing is re-split,
 * no quotes are interpreted, no byte of a value is inspected for flags.
 *
 * `taskCommand` only changes what a positional means. Run commands take their
 * task from --prompt/--prompt-file/--stdin, so a positional there is a caller
 * mistake and dies loudly. Management commands (status/wait/result/cancel/
 * setup) keep collecting positionals as ids and values.
 */
function parseFlags(argv, { taskCommand = false } = {}) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      let name = t.slice(2);
      if (REMOVED_REVIEW_FLAGS.has(name) || REMOVED_EXEC_FLAGS.has(name)) migrationDie(name);
      if (FLAG_ALIASES[name]) {
        if (!warnedAliases.has(name)) {
          warnedAliases.add(name);
          process.stderr.write(`agy-staff: --${name} is deprecated; use --${FLAG_ALIASES[name]}\n`);
        }
        name = FLAG_ALIASES[name];
      }
      if (VALUE_FLAGS.has(name)) {
        const v = argv[++i];
        checkValue(name, v);
        opts[name] = v;
      } else if (BOOL_FLAGS.has(name)) {
        opts[name] = true;
      } else if (/\s/.test(name)) {
        packedArgumentDie(name, t);
      } else {
        die(`unknown flag --${name}`);
      }
    } else if (taskCommand) {
      die(
        `positional task text was removed; pass the task with --prompt <text>, ` +
          `--prompt-file <path>, or --stdin`
      );
    } else {
      opts._.push(t);
    }
  }
  return opts;
}

function fmtTokens(usage) {
  if (!usage) return 'n/a';
  const parts = [`in ${usage.input_tokens ?? '?'}`, `out ${usage.output_tokens ?? '?'}`];
  if (usage.thinking_tokens) parts.push(`think ${usage.thinking_tokens}`);
  if (usage.cache_read_tokens) parts.push(`cache ${usage.cache_read_tokens}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// prompt building
// ---------------------------------------------------------------------------

function fillTemplate(mode, vars) {
  const file = path.join(TEMPLATES_DIR, `${mode}.md`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    die(`template not found: ${file}`);
  }
  // Adapt only the template, never words in the user's task or quoted text.
  if (BACKEND !== 'agy') text = text.replace(/\bAntigravity\b/g, BACKEND_TITLES[BACKEND]).replace(/\bagy\b/gi, BACKEND);
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function gatherContext() {
  const branch = sh('git', ['branch', '--show-current']).out || '(no git branch)';
  return [
    `Working directory: ${process.cwd()}`,
    `Git branch: ${branch}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
  ].join('\n');
}

function dirtyWorkspacePrompt() {
  if (!inGitRepo()) return '';
  const status = porcelainSnapshot();
  if (!status?.length) return '';
  const lines = [];
  let bytes = 0;
  for (const line of status) {
    const next = Buffer.byteLength(`${line}\n`);
    if (lines.length >= MAX_DIRTY_STATUS_LINES || bytes + next > MAX_DIRTY_STATUS_BYTES) break;
    lines.push(line);
    bytes += next;
  }
  const truncated = lines.length < status.length;
  const limitNote = truncated
    ? `\n\nThe status list was truncated to ${lines.length} of ${status.length} entries and ${bytes} bytes. Run \`git status --porcelain\` and inspect relevant diffs before editing or delivering changes.`
    : '';
  return (
    '## Existing workspace changes\n\n' +
    'The workspace was already dirty before this implement run. Treat these paths as user-owned context. Build on them only when the task clearly includes them; otherwise pause and ask for confirmation before overwriting, cleaning, stashing, resetting, deleting, committing, pushing, or opening a PR with them. Use `git status --porcelain` and `git diff` as ground truth when path ownership is unclear.\n\n' +
    '`git status --porcelain` before this run (bounded summary):\n' +
    '```text\n' +
    lines.join('\n') +
    '\n```' +
    limitNote
  );
}

// ---------------------------------------------------------------------------
// agy invocation
// ---------------------------------------------------------------------------

function durationToMs(d) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(d);
  if (!m) return null;
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
  return Math.round(parseFloat(m[1]) * mult);
}


function queryAgyModels() {
  try {
    const agy = agyCommand(['models']);
    const r = spawnSync(agy.cmd, agy.args, {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    if (r.error) {
      return { ok: false, error: r.error.message };
    }
    if (r.status !== 0) {
      return { ok: false, error: (r.stderr || '').trim() || `exit ${r.status}` };
    }
    const stdout = (r.stdout || '').trim();
    if (!stdout) {
      return { ok: false, error: 'empty output from `agy models`' };
    }
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const models = [];
    for (const line of lines) {
      if (/^fetching/i.test(line)) continue;
      const parts = line.split(/\s+/);
      const id = parts[0];
      const desc = parts.slice(1).join(' ');
      if (id) {
        models.push({ id, desc });
      }
    }
    if (models.length === 0) {
      return { ok: false, error: 'no models found in `agy models` output' };
    }
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function recommendCompatibleModel(requestedModel, availableModelIds) {
  const effortMatch = requestedModel ? requestedModel.match(/-(low|medium|high)$/) : null;
  const effort = effortMatch ? effortMatch[1] : null;

  if (effort) {
    const sameEffort = availableModelIds.filter((id) => id.endsWith(`-${effort}`));
    if (sameEffort.length > 0) {
      const flashOrder = [
        `gemini-3.8-flash-${effort}`,
        `gemini-3.7-flash-${effort}`,
        `gemini-3.6-flash-${effort}`,
        `gemini-3.5-flash-${effort}`,
      ];
      for (const candidate of flashOrder) {
        if (sameEffort.includes(candidate) && candidate !== requestedModel) {
          return candidate;
        }
      }
      const otherFlash = sameEffort.find((id) => id.includes('flash') && id !== requestedModel);
      if (otherFlash) return otherFlash;

      const proOrder = [`gemini-3.1-pro-${effort}`];
      for (const candidate of proOrder) {
        if (sameEffort.includes(candidate) && candidate !== requestedModel) {
          return candidate;
        }
      }
      const otherSameEffort = sameEffort.find((id) => id !== requestedModel);
      if (otherSameEffort) return otherSameEffort;
    }
  }

  const anyFlash = availableModelIds.find((id) => id.includes('flash') && id !== requestedModel);
  if (anyFlash) return anyFlash;

  return availableModelIds.find((id) => id !== requestedModel) || null;
}

function isUnsupportedModelError(errText) {
  if (!errText) return false;
  if (/auth|login|credential|unauthorized|401|403/i.test(errText)) return false;
  if (/quota|rate.?limit|resource.?exhausted|429/i.test(errText)) return false;
  if (/network|econnrefused|enotfound|fetch failed|socket|eai_again/i.test(errText)) return false;
  if (/requires --effort/i.test(errText)) return false;
  return (
    /not recognized as a known model/i.test(errText) ||
    /unknown model/i.test(errText) ||
    /unsupported model/i.test(errText) ||
    /invalid model selection/i.test(errText) ||
    /model .* (not found|is not supported|is not available|is not recognized)/i.test(errText)
  );
}

function handleUnsupportedModel({ requestedModel, errText, originalError, convNote }) {
  const discovery = queryAgyModels();
  let msg = `agy reported an unsupported-model error for requested model "${requestedModel}".\n`;
  if (originalError) {
    msg += `agy error: ${originalError}\n`;
  }

  if (!discovery.ok) {
    msg +=
      `Model discovery via \`agy models\` failed (${discovery.error}).\n` +
      `Please run \`agy models\` to check available models.\n` +
      `Updating agy is preferred to use the latest default (gemini-3.8-flash).`;
    die(msg + (convNote || ''));
  }

  const availableIds = discovery.models.map((m) => m.id);
  const best = recommendCompatibleModel(requestedModel, availableIds);

  msg +=
    `Available models (from \`agy models\`):\n` +
    discovery.models.map((m) => `  ${m.id}${m.desc ? `\t${m.desc}` : ''}`).join('\n') +
    '\n\n';

  if (best) {
    msg += `Best same-effort compatible recommendation: --model ${best}\n`;
  }
  msg += `Updating agy is preferred to use the latest default (gemini-3.8-flash).`;
  die(msg + (convNote || ''));
}

function agyArgs({ prompt, model, timeout, conversation, unrestricted, jsonSchema, workspace }, format) {
  const args = ['-p', prompt, '--model', model, '--output-format', format, '--print-timeout', timeout, '--add-dir', workspace];
  if (conversation) args.push('--conversation', conversation);
  if (unrestricted) args.push('--dangerously-skip-permissions');
  if (jsonSchema) args.push('--json-schema', jsonSchema);
  return args;
}

function runAgy(invoke) {
  const { model, timeout } = invoke;
  const args = agyArgs(invoke, 'json');

  const budget = (durationToMs(timeout) ?? 600_000) + 60_000; // grace over agy's own timeout
  const agy = agyCommand(args);
  const r = spawnSync(agy.cmd, agy.args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: budget,
    windowsHide: true,
  });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    die(`agy timed out: no result within ${timeout} plus 60s grace. Retry with a larger --timeout, or narrow the task.`);
  }
  if (r.error) die(`failed to launch agy (${AGY_BIN}): ${r.error.message}`);
  if (r.signal) {
    die(`agy was killed by signal ${r.signal} before returning a result (companion budget: ${timeout} + 60s grace).`);
  }

  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  // agy prints a single-line JSON object; be defensive about leading noise.
  const start = stdout.indexOf('{');
  let payload = null;
  if (start >= 0) {
    try {
      payload = JSON.parse(stdout.slice(start));
    } catch {
      /* fall through */
    }
  }
  if (!payload) {
    const errText = `${stdout}\n${stderr}`;
    if (isUnsupportedModelError(errText)) {
      handleUnsupportedModel({
        requestedModel: model,
        errText,
        originalError: stderr || stdout,
      });
    }
    let msg =
      `agy did not return parseable JSON (exit ${r.status}).\n` +
      `stdout: ${stdout.slice(0, 800) || '(empty)'}\n` +
      `stderr: ${stderr.slice(0, 800) || '(empty)'}`;
    // EPERM on agy's own home files or on binding localhost is the signature of
    // a harness command sandbox (e.g. Codex workspace-write). agy cannot run
    // sandboxed: it binds a local port for its language server and reads its
    // OAuth token file, which sandbox secret-protection hides — no
    // writable_roots/network_access knob fixes the hidden token.
    if (/operation not permitted/i.test(stderr)) {
      msg +=
        '\n\nThis looks like a harness command sandbox blocking agy (EPERM on its log/state files or on binding 127.0.0.1). ' +
        'agy cannot run inside a sandbox — it needs a localhost port and its OAuth token file, which sandboxes typically hide. ' +
        'Run this companion command unsandboxed: in Codex, grant the workspace full access or approve the command with escalated permissions.';
    }
    die(msg);
  }
  return { payload, stderr, exit: r.status ?? 0 };
}

/** Triage the agy result into distinct classes with distinct guidance
 *  (never cross-suggested), or return the response text on success.
 *  1. status ERROR / nonzero exit, but response text came back
 *     → return the text (exit 0) and put diagnostics on stderr.
 *       The orchestrator judges task completion; nonempty text is not proof.
 *  2. status ERROR / nonzero exit, no response
 *     → agy's own error verbatim; NEVER suggest --unrestricted. Cause
 *       hints are appended only when the error text actually matches them.
 *  3. response timeout             → attention when the conversation is resumable.
 *  4. status SUCCESS, empty body   → permission fail-closed signature; only a
 *                                    --restricted run gets the setup hint
 *                                    (unrestricted runs have no rules to fix).
 */
function triageResult({ payload, stderr, exit }, mode, profile, profileSource, requestedModel) {
  const status = (payload.status || '').toUpperCase();
  const response = (payload.response || '').trim();
  const convNote = payload.conversation_id
    ? `\nConversation id (you can still continue it): ${payload.conversation_id}`
    : '';

  // Match AGY's response deadline, not a tool/network timeout embedded in an
  // unrelated error. Response text keeps the done-with-warnings delivery contract.
  if (!response && (['TIMEOUT', 'TIMED_OUT', 'RESPONSE_TIMEOUT'].includes(status) ||
      (status === 'ERROR' && /^timeout waiting for response[.!]?$/i.test(String(payload.error || '').trim())))) {
    throw Object.assign(new Error(`agy timed out (status ${payload.status}) before finishing.` +
      (payload.error ? `\nagy error: ${payload.error}` : '') + convNote), { reason: 'response_timeout' });
  }

  if ((status && status !== 'SUCCESS') || exit !== 0) {
    if (response) {
      // Preserve response text and diagnostics for the orchestrator to assess.
      process.stderr.write(
        `agy-staff warning: agy reported status ${payload.status || 'unknown'} (exit ${exit}) ` +
          'but returned response text — delivering it for assessment.\n' +
          (payload.error ? `agy error: ${payload.error}\n` : '') +
          (stderr ? `agy stderr: ${stderr}\n` : '')
      );
      return response;
    }
    const errText = `${payload.error || ''}\n${stderr}`;
    if (isUnsupportedModelError(errText)) {
      handleUnsupportedModel({
        requestedModel: requestedModel || DEFAULTS.model[mode],
        errText,
        originalError: payload.error || stderr,
        convNote,
      });
    }

    let msg = `agy reported an error (status ${payload.status || 'unknown'}, exit ${exit}).`;
    if (payload.error) msg += `\nagy error: ${payload.error}`;
    if (stderr) msg += `\nagy stderr: ${stderr}`;
    const hints = [];
    if (/model|effort/i.test(errText)) {
      hints.push('invalid model id (agy needs effort-suffixed ids, e.g. gemini-3.8-flash-low — run `agy models`)');
    }
    if (/auth|login|credential|unauthorized|401|403/i.test(errText)) {
      hints.push('expired auth (run `agy` interactively once to re-login)');
    }
    if (/quota|rate.?limit|resource.?exhausted|429/i.test(errText)) {
      hints.push('exhausted quota');
    }
    if (hints.length) msg += `\nLikely cause: ${hints.join('; ')}.`;
    die(msg + convNote);
  }

  if (response) return response;

  // status SUCCESS but nothing came back
  if (mode === 'ask') {
    die(
      'unexpected: agy returned success with an empty answer, but ask uses no tools, so this cannot be a ' +
        'permission denial. Please report it (include the agy stderr below if any).' +
        (stderr ? `\n\nagy stderr:\n${stderr}` : '') +
        convNote
    );
  }
  let msg = 'agy returned an empty response (status SUCCESS but no content).';
  if (profile === 'restricted') {
    const cause =
      profileSource === 'project'
        ? 'This run was restricted by the project policy in .agy-staff/config.json'
        : profileSource === 'inherited' ? 'This continuation inherited the restricted profile' : 'This run used `--restricted`';
    const relax =
      profileSource === 'project'
        ? 'relax the policy (`setup --restrict none`) or pass `--unrestricted` for this run'
        : profileSource === 'inherited' ? 'pass `--unrestricted` explicitly for this continuation' : `drop \`--restricted\` — ${mode} runs unrestricted by default`;
    msg +=
      `\n${cause}, so agy kept its permission enforcement on: in headless mode every` +
      ' unlisted tool call is auto-denied, which is the usual cause of an empty response.' +
      `\nFix: run \`setup\` once to install the evidence-gathering command allowlist, or ${relax}.` +
      '\nNote: some agy tools ignore allow-rules in headless mode entirely, so even a complete allowlist cannot' +
      ' make them work; those need an unrestricted run.';
  }
  if (stderr) msg += `\n\nagy stderr:\n${stderr}`;
  die(msg + convNote);
}

// ---------------------------------------------------------------------------
// A follow-up targets a conversation whose execution has stopped. While the
// job is still running, report its status and id instead of queueing: the
// orchestrator decides whether to wait or cancel first.
function foregroundOccupant(state, conversation) {
  if (!conversation) return null;
  const holder = state.foreground_sessions?.[conversation];
  if (!holder || (holder.backend || 'agy') !== BACKEND) return null;
  const self = processIdentity(process.pid);
  if (holder.pid === process.pid && (!holder.born || !self || holder.born === self.born)) return null;
  if (!pidAlive(holder.pid)) return null;
  if (holder.born) {
    const rows = processTable();
    // A live PID with a different birth stamp is a reused identifier, not this call.
    if (rows && !rows.some((row) => row.pid === holder.pid && row.born === holder.born)) return null;
  }
  return holder;
}

function refuseRunningFollowUp(state, conversation, jobId = null) {
  if (!conversation && !jobId) return;
  const active = (state.jobs || []).find(j =>
    ((conversation && j.conversation_id === conversation) || (jobId && j.id === jobId)) &&
    (liveJobStatus(j) === 'running' || j.executionMayBeActive));
  if (active) {
    if (active.executionMayBeActive && liveJobStatus(active) !== 'running') die(`job ${active.id} has unverified process cleanup; inspect its diagnostics before continuing. Nothing was queued.`);
    die(`job ${active.id} is still running (status: running); the follow-up was not accepted or queued. ` +
      `Collect it with \`wait ${active.id}\` and continue afterwards, or \`cancel ${active.id}\` first for an immediate change of direction.`);
  }
  const holder = foregroundOccupant(state, conversation);
  if (!holder) return;
  die(`conversation ${conversation} is still in use by a foreground ${holder.mode} call (pid ${holder.pid}); the follow-up was not accepted or queued. ` +
    `Wait for that call to finish before using the same session.`);
}

function noteForeground(state, resolved, conversation) {
  if (!conversation || resolved.background) return;
  refuseRunningFollowUp(state, conversation);
  const identity = processIdentity(process.pid);
  state.foreground_sessions ||= {};
  const current = state.foreground_sessions[conversation];
  state.foreground_sessions[conversation] = {
    backend: BACKEND, mode: resolved.mode, pid: process.pid, born: identity?.born || null,
    started_at: current?.pid === process.pid ? current.started_at : new Date().toISOString(),
  };
}

function claimForeground(resolved, conversation) {
  if (!conversation || resolved.background) return;
  updateState((state) => noteForeground(state, resolved, conversation));
}

function releaseForeground(conversation) {
  if (!conversation) return;
  updateState((state) => {
    const current = state.foreground_sessions?.[conversation];
    if (current?.pid !== process.pid) return;
    delete state.foreground_sessions[conversation];
    if (!Object.keys(state.foreground_sessions).length) delete state.foreground_sessions;
  });
}

// run (research / review / implement / continue)
// ---------------------------------------------------------------------------

function resolveRun(mode, opts, priorJob = null) {
  // likely a typo for --restricted; --restrict (per-repo policy) belongs to setup
  if (opts.restrict !== undefined) {
    die(`--restrict is a setup flag (per-repo policy: \`setup --restrict <modes|none>\`). For a single ${mode} run use --restricted.`);
  }

  if (opts.reset) die('--reset belongs to config; use config --reset to clear project model defaults');
  const project = loadProjectConfig();

  // profile: CLI flag > project policy (.agy-staff/config.json) > built-in default
  if (opts.restricted && opts.unrestricted) die('--restricted and --unrestricted are mutually exclusive');
  const policyProfile = mode === 'ask' ? null : project?.profiles?.[mode] || null;
  let profile;
  let profileSource; // 'flag' | 'project' | 'default' | 'inherited'
  if (opts.restricted || opts.unrestricted) {
    profile = opts.restricted ? 'restricted' : 'unrestricted';
    profileSource = 'flag';
  } else if (policyProfile) {
    profile = policyProfile;
    profileSource = 'project';
  } else {
    profile = DEFAULTS.profile[mode];
    profileSource = 'default';
  }
  if (mode === 'ask' && (opts.unrestricted || opts.restricted)) {
    if (opts.unrestricted) process.stderr.write(BACKEND === 'agy' ? 'agy-staff: ask is tool-free; --unrestricted ignored\n'
      : `${STAFF_NAME}: ask uses the question-only restricted profile; --unrestricted ignored\n`);
    profile = 'restricted';
  }

  // execution style is a property of the mode; no flag overrides it
  const background = DEFAULTS.background[mode];

  const timeout = opts.timeout || DEFAULTS.timeout[mode];
  const budget = durationToMs(timeout);
  if (!Number.isFinite(budget) || budget <= 0 || (background && budget > 7200000)) die('invalid --timeout: use a positive duration, at most 120m for background jobs');

  // conversation
  const state = loadState();
  let conversation = opts.conversation || null;
  if (!conversation && opts.continue) {
    conversation = state.conversations?.[mode] || null;
    if (!conversation) die(`--continue given but no previous ${mode} conversation is recorded in state.json`);
  }

  const recorded = conversation ? state.conversation_configs?.[conversation] : null;
  const latestJob = conversation ? [...(state.jobs || [])].reverse().find((j) => j.conversation_id === conversation) : null;
  // The latest saved session config outranks an older job. continue --job is
  // the only caller that passes that job as priorJob, so an explicit selection
  // still keeps the selected job's model, effort, and profile.
  const prior = priorJob
    || recorded
    || latestJob
    || (state.last?.id === conversation ? { ...state.last } : null);
  // Configuration may come from an earlier job; occupancy belongs to the
  // whole conversation, including jobs launched through another mode.
  refuseRunningFollowUp(state, conversation);
  if (prior) {
    assertBackend(prior, 'conversation');
    if (prior.executionMayBeActive) die('Conversation cleanup is unverified; inspect the retained diagnostics before continuing.');
    if (!opts.restricted && !opts.unrestricted && prior.profile) { profile = prior.profile; profileSource = 'inherited'; }
  }
  const { model, effort } = resolveModel(mode, opts, project?.defaults, prior);
  // ask stays restricted even when a historical record was manually edited.
  if (mode === 'ask') profile = 'restricted';
  if (profileSource === 'project') process.stderr.write(`${STAFF_NAME}: profile=${profile} set by project policy (${configPath()})\n`);
  return { backend: BACKEND, mode, model, effort, profile, profileSource, background, timeout, conversation,
    isResume: !!conversation, parentJobId: priorJob?.id || latestJob?.id || null, originalCwd: prior?.cwd || null };
}

/** Task text comes from exactly one source: --prompt, --prompt-file, or
 *  --stdin. Long prompts should use the latter two instead of shell quoting.
 *  Whatever the source, the contents are opaque here: already a single string
 *  by the time they arrive, and never scanned for companion flags. */
function taskText(opts) {
  const sources = [
    opts.prompt !== undefined && '--prompt',
    opts['prompt-file'] !== undefined && '--prompt-file',
    opts.stdin && '--stdin',
  ].filter(Boolean);
  if (sources.length > 1) die(`task text given more than one way (${sources.join(', ')}) — use exactly one`);
  if (opts.prompt !== undefined) return opts.prompt.trim();
  if (opts['prompt-file'] !== undefined) {
    try {
      return fs.readFileSync(opts['prompt-file'], 'utf8').trim();
    } catch (e) {
      die(`cannot read --prompt-file ${opts['prompt-file']}: ${e.message}`);
    }
  }
  if (opts.stdin) {
    try {
      return fs.readFileSync(0, 'utf8').trim();
    } catch (e) {
      die(`cannot read task text from stdin: ${e.message}`);
    }
  }
  return '';
}

function buildPrompt(mode, opts) {
  const task = taskText(opts);
  const context = gatherContext();

  if (!task) {
    if (mode === 'ask') die('ask needs a question');
    if (mode === 'review') {
      die(
        'review needs a subject description, e.g. review --prompt "Review PR #730" or review --prompt "Review the current working tree"'
      );
    }
    die(`${mode} needs a task description`);
  }
  if (Buffer.byteLength(task) > MAX_INLINE_BYTES) {
    die(`task text exceeds the ${MAX_INLINE_BYTES / 1024}KB inline limit`);
  }
  // ask is zero-tool by design: question only, no workspace context
  if (mode === 'ask') return fillTemplate('ask', { TASK: task });
  return fillTemplate(mode, {
    TASK: task,
    CONTEXT: context,
    WORKSPACE: mode === 'implement' ? dirtyWorkspacePrompt() : '',
  });
}

// ---------------------------------------------------------------------------
// tiered guards (unrestricted runs only; ask is forced restricted upstream)
//
//   implement → it is meant to edit files. Dirty workspaces are prompt context,
//               not a hard companion refusal: agy can continue when the task
//               clearly includes the existing changes, and must ask when it
//               would overwrite or deliver unrelated user work.
//   review /  → no gate at all, never blocked. They should not be touching
//   research    files, so we snapshot `git status --porcelain` around the run
//               and report any delta with the result.
//   staffer   → same snapshot/report, but neutrally worded: a general task may
//               legitimately edit files, so the delta is information for the
//               caller, not an accusation.
// ---------------------------------------------------------------------------

function inGitRepo() {
  const r = sh('git', ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.out === 'true';
}

/** Porcelain lines as an array, or null when git can't tell us (no repo). */
function porcelainSnapshot() {
  const r = sh('git', ['status', '--porcelain']);
  if (r.code !== 0) return null;
  return r.out ? r.out.split('\n') : [];
}

/** Lines that appeared during the run, plus lines whose status changed for a
 *  path that was already dirty (e.g. " M f" → "MM f"). */
function porcelainDelta(before, after) {
  const seen = new Map();
  for (const line of before) seen.set(line.slice(3), line);
  return after.filter((line) => seen.get(line.slice(3)) !== line);
}

function implementGuardApplies(resolved) {
  return resolved.profile === 'unrestricted' && resolved.mode === 'implement';
}

function treeReportApplies(resolved) {
  return resolved.profile === 'unrestricted' && ['staffer', 'review', 'research'].includes(resolved.mode);
}

function implementDispatchWarning() {
  if (!inGitRepo()) {
    process.stderr.write(
      `${STAFF_NAME} warning: not a git repository — ${BACKEND}'s edits cannot be reviewed or rolled back via git.\n` +
        'Proceeding anyway; back up anything you care about, or run implement from inside a repository.\n'
    );
  }
}

function implementPostcondition(before) {
  if (!inGitRepo()) return '';
  const after = porcelainSnapshot() || [];
  if (!after.length) return '\n[unrestricted] Working tree clean after implement.';
  const diffStat = sh('git', ['diff', '--stat']).out;
  const delta = before ? porcelainDelta(before, after) : after;
  const untracked = delta
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3))
    .join(', ');
  let out;
  if (before?.length) {
    out =
      '\n[unrestricted] Working tree is dirty after implement. Existing pre-run changes may be part of the task context.\n' +
      'Status entries that appeared or changed during the run:\n' +
      (delta.length ? delta.map((l) => `  ${l}`).join('\n') : '  (none detected by porcelain status)') +
      '\n`git diff --stat`:\n' +
      (diffStat || '(only new files or committed by agy)');
  } else {
    out =
      '\n[unrestricted] agy modified the working tree. `git diff --stat`:\n' +
      (diffStat || '(only new files or committed by agy)');
  }
  if (untracked) out += `\nNew untracked files: ${untracked}`;
  out += '\nACTION FOR THE CALLING AGENT: inspect the current workspace (`git status --short`, `git diff`) and distinguish pre-run dirty paths from this run\'s delta. Continue the same agy conversation for follow-up work. If committing or opening a PR, first verify the task explicitly authorized that delivery.';
  return out;
}

/** Tree-delta warning for staffer/review/research: silent unless agy dirtied
 *  the tree. review/research should never edit, so the report blames agy; a
 *  staffer task may legitimately edit, so its wording is neutral. */
function treeDeltaReport(mode, before, after) {
  if (!before || !after) return '';
  const delta = porcelainDelta(before, after);
  if (!delta.length) return '';
  const blame =
    mode === 'staffer'
      ? `agy modified the working tree during this ${mode} run — verify the task asked for it. `
      : `agy modified the working tree during this ${mode} — it should not have. `;
  return (
    `\n[unrestricted] ${blame}` +
    `Delta (\`git status --porcelain\` entries that appeared or changed during the run):\n` +
    delta.map((l) => `  ${l}`).join('\n') +
    `\nACTION FOR THE CALLING AGENT: inspect these changes (\`git diff\`) before trusting this ${mode}. ` +
    `Rollback: \`git checkout -- <path>\` for tracked files, delete the new untracked ones.`
  );
}

function validateReviewJSON(text) {
  const invalid = (detail) => { throw Object.assign(new Error(`Review did not return a complete valid JSON report: ${detail}`), { reason: 'invalid_structured_output', partialText: text }); };
  let report;
  try { report = JSON.parse(text); } catch { invalid('response is not a single JSON value'); }
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(report) || !['approve', 'request_changes', 'comment'].includes(report.verdict) || typeof report.summary !== 'string' ||
      !Array.isArray(report.findings) || !Array.isArray(report.could_not_verify) || report.could_not_verify.some((value) => typeof value !== 'string')) {
    invalid('verdict, summary, findings, or could_not_verify has the wrong type');
  }
  for (const finding of report.findings) {
    if (!object(finding) || !['critical', 'high', 'medium', 'low', 'nit'].includes(finding.severity) ||
        typeof finding.title !== 'string' || typeof finding.detail !== 'string' ||
        ('file' in finding && typeof finding.file !== 'string') || ('line' in finding && typeof finding.line !== 'string')) {
      invalid('a finding does not match the review schema');
    }
  }
}

function triageBackendResult(result) {
  const payload = result.payload || {};
  const response = typeof payload.response === 'string' ? payload.response : '';
  if (String(payload.status).toUpperCase() !== 'SUCCESS' || result.exit !== 0) {
    throw Object.assign(new Error(`${BACKEND} reported ${payload.status || 'unknown'} (exit ${result.exit})${payload.error ? `: ${payload.error}` : ''}`),
      { reason: payload.reason || 'native_error', payload, partialText: response });
  }
  if (!response.trim()) throw Object.assign(new Error(`${BACKEND} returned an empty response.`), { reason: 'empty_response', payload });
  return response;
}

function streamInvocation(invoke, resolved, job, controller, budget, update) {
  const promptFile = BACKEND === 'agy' ? null : job.spec_file + '.prompt.txt';
  if (promptFile) fs.writeFileSync(promptFile, invoke.prompt, { mode: 0o600 });
  const schemaFile = BACKEND === 'codex' && invoke.jsonSchema ? job.spec_file + '.schema.json' : null;
  if (schemaFile) fs.writeFileSync(schemaFile, invoke.jsonSchema, { mode: 0o600 });
  const configArgs = BACKEND === 'codex' ? codexCompatibilityArgs() : [];
  const command = BACKEND === 'agy' ? (() => {
    const agy = agyCommand(agyArgs(invoke, 'stream-json'));
    return { binary: agy.cmd, args: agy.args };
  })() : buildInvocation(BACKEND, invoke, { mode: resolved.mode, promptFile, effort: resolved.effort, schemaFile, configArgs });
  return runStreaming({ ...command, backend: BACKEND, job, budget, signal: controller.signal,
    update, conversation: (id) => rememberConversation(resolved, id, job.id),
  });
}

async function runForeground(invoke, resolved) {
  // Foreground ask keeps its original stdout contract and has no background
  // job entry. Streaming still enforces deadlines and owns child cleanup.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${STAFF_NAME}-ask-`));
  const job = { backend: BACKEND, id: null, mode: resolved.mode, spec_file: path.join(directory, 'ask.spec.json'),
    events_file: path.join(directory, 'events.jsonl'), progress_file: path.join(directory, 'progress.json') };
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  let succeeded = false, keep = KEEP_LOGS;
  try {
    const result = await streamInvocation(invoke, resolved, job, controller, durationToMs(resolved.timeout), (fields) => Object.assign(job, fields));
    // Classify before removing raw output: a successful native terminal frame
    // can still contain an empty or otherwise unusable response.
    triageBackendResult(result);
    const toolCalls = result.payload.toolCalls || [];
    if (toolCalls.length) {
      keep = true;
      process.stderr.write(`${STAFF_NAME} warning: ask requested no tools, but ${BACKEND} reported ${toolCalls.length} observed tool call(s).\n`);
    }
    if (keep) {
      fs.writeFileSync(path.join(directory, 'diagnostics.json'), JSON.stringify({ backend: BACKEND, mode: resolved.mode,
        status: 'done', conversation_id: result.payload.conversation_id, requested_model: resolved.model,
        profile: resolved.profile, observed_tool_calls: toolCalls.length, payload: result.payload,
        cleanup: result.cleanup, observationWarnings: result.observationWarnings }, null, 2), { mode: 0o600 });
      process.stderr.write(`[${STAFF_NAME}] diagnostics: ${directory}\n`);
    }
    succeeded = true;
    return result;
  } catch (error) {
    if (error.executionMayBeActive && resolved.conversation) {
      updateState((state) => {
        const prior = state.conversation_configs?.[resolved.conversation];
        if (prior) Object.assign(prior, { executionMayBeActive: true, cleanup: error.cleanup });
      });
    }
    fs.writeFileSync(path.join(directory, 'diagnostics.json'), JSON.stringify({ backend: BACKEND, reason: error.reason,
      message: error.message, conversation_id: resolved.conversation, payload: error.payload, partialText: error.partialText,
      cleanup: error.cleanup, executionMayBeActive: error.executionMayBeActive }, null, 2), { mode: 0o600 });
    error.message += `\nDiagnostics: ${directory}`;
    throw error;
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    if (succeeded && !keep) fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function executeRun(resolved, prompt, opts, execution = null) {
  assertBackend(resolved, 'invocation');
  const workspaceBefore = resolved.mode === 'ask' ? null : porcelainSnapshot();
  const implementBefore = implementGuardApplies(resolved) ? workspaceBefore : null;
  const treeBefore = treeReportApplies(resolved) ? workspaceBefore : null;
  const reviewSchema = BACKEND === 'codex' ? codexReviewSchema(REVIEW_JSON_SCHEMA) : REVIEW_JSON_SCHEMA;

  const invoke = {
    backend: BACKEND, mode: resolved.mode,
    prompt: BACKEND !== 'agy' && opts.json && resolved.mode === 'review'
      ? `${prompt}\n\n## Required response format\nReturn only one complete JSON object, without Markdown fences or surrounding prose, matching this schema:\n${reviewSchema}` : prompt,
    cwd: process.cwd(), workspace: repoRoot(),
    model: resolved.model,
    effort: resolved.effort,
    timeout: resolved.timeout,
    conversation: resolved.conversation,
    isResume: resolved.isResume ?? !!resolved.conversation,
    unrestricted: resolved.profile === 'unrestricted',
    jsonSchema: ['agy', 'codex'].includes(BACKEND) && opts.json && resolved.mode === 'review' ? reviewSchema : null,
  };
  let result, response;
  try {
    result = execution ? await execution(invoke) : BACKEND === 'agy' ? runAgy(invoke) : await runForeground(invoke, resolved);
    rememberConversation(resolved, result.payload.conversation_id, opts.jobId);
    const structuredReview = opts.json && resolved.mode === 'review';
    const triageInput = BACKEND === 'agy' && structuredReview && Object.hasOwn(result.payload, 'structured_output')
      ? { ...result, payload: { ...result.payload, response: JSON.stringify(result.payload.structured_output) } } : result;
    response = BACKEND === 'agy' ? triageResult(triageInput, resolved.mode, resolved.profile, resolved.profileSource, resolved.model) : triageBackendResult(result);
    if (structuredReview) validateReviewJSON(response);
  } catch (error) {
    error.workspace = {
      before: excerpt(workspaceBefore?.join('\n') ?? 'Git status unavailable', 3000),
      after: excerpt(porcelainSnapshot()?.join('\n') ?? 'Git status unavailable', 3000),
      note: 'Inspect git status --short, git diff and git diff --cached. Status cannot detect further edits to already dirty files; no workspace rollback was performed.' };
    if (BACKEND !== 'agy' && !resolved.background) {
      error.exitCode = error.reason === 'canceled' ? 4 : error.reason === 'cleanup_unverified' || error.reason === 'turn_limit' ||
        (isTimeoutReason(error.reason) && resolved.conversation) ? 5 : 3;
    }
    if (isTimeoutReason(error.reason) && !resolved.background) {
      const conversation = result?.payload?.conversation_id || resolved.conversation;
      const recovery = timeoutRecovery({ ...resolved, conversation_id: conversation });
      die(`${error.message}\n${JSON.stringify({
        status: conversation ? 'attention' : 'error', reason: error.reason,
        conversation_id: conversation || null, mode: resolved.mode, model: resolved.model,
        profile: resolved.profile, recovery,
      }, null, 2)}`, conversation ? 5 : 1);
    }
    throw error;
  }
  const payload = result.payload;
  const treeAfter = treeBefore ? porcelainSnapshot() : null;
  opts.warnings = !!(result.stderr || result.observationWarnings?.length || payload.permissionDenials?.length || result.exit !== 0 || (payload.status && payload.status.toUpperCase() !== 'SUCCESS'));
  if (BACKEND !== 'agy') opts.resultMetadata = { native_status: payload.status, permission_denials: payload.permissionDenials || [],
    tool_calls: payload.toolCalls || [], observed_model: payload.model || payload.observedModel || null };

  // Telemetry is plumbing, not content: it goes to stderr so it never mixes
  // into the deliverable. Foreground runs put it on the caller's stderr;
  // background workers have stdout and stderr both wired to jobs/<id>.log, so
  // it lands there as the job's provenance record.
  process.stderr.write(
    `[${STAFF_NAME}] mode=${resolved.mode} profile=${resolved.profile} model=${resolved.model || 'native-default'} ` +
      `${BACKEND}_status=${payload.status || 'unknown'} ${BACKEND}_exit=${result.exit} ` +
      (BACKEND === 'agy' ? '' : `observed_tool_calls=${payload.toolCalls?.length ?? 0} `) +
      `duration=${payload.duration_seconds ?? '?'}s turns=${payload.num_turns ?? '?'} tokens(${fmtTokens(payload.usage)})\n` +
      `conversation: ${payload.conversation_id || 'unknown'} (follow up with --continue)\n`
  );

  // Guard output is part of the body: the calling agent must act on it.
  let guard = '';
  if (implementGuardApplies(resolved)) guard += implementPostcondition(implementBefore);
  if (treeReportApplies(resolved)) guard += treeDeltaReport(resolved.mode, treeBefore, treeAfter);
  if (BACKEND !== 'agy') guard = guard.replace(/\bagy\b/gi, BACKEND);
  opts.warnings ||= !!guard;
  if (guard && opts.json && resolved.mode === 'review') {
    // Machine-readable review content remains a complete JSON value; workspace
    // diagnostics retain their normal stderr/log channel instead of corrupting it.
    process.stderr.write(`${guard}\n`);
    return response;
  }
  return guard ? response + '\n' + guard : response;
}

function cmdRun(mode, opts) {
  const task = taskText(opts); // Resolve prompt-file/stdin in the caller's cwd.
  const resolved = resolveRun(mode, opts);
  enterOriginalWorkspace(resolved.originalCwd);
  if (resolved.parentJobId) {
    const prior = findJob(resolved.parentJobId);
    enterOriginalWorkspace(prior.cwd);
    if (prior.spec_file) { try { opts.json ||= JSON.parse(fs.readFileSync(prior.spec_file, 'utf8')).opts.json; } catch {} }
  }
  const prompt = buildPrompt(mode, { prompt: task });
  return dispatch(resolved, prompt, { ...opts, promptSource: { kind: 'template', task } });
}

async function dispatch(resolved, prompt, opts) {
  assertBackend(resolved, 'invocation');
  // Grok's ID belongs to this invocation before spawn. Only a real follow-up
  // uses --resume; supplying a new session ID must not become a resume request.
  if (BACKEND === 'grok' && !resolved.conversation) resolved = { ...resolved, conversation: randomUUID(), isResume: false };
  // Persist the effective review format with the session. Model and profile
  // already live there; opts.json alone is not enough once a later continue
  // stops reading an older job spec.
  resolved.json = !!opts.json;
  const mode = resolved.mode;
  if (!resolved.background) {
    // Grok allocates its session before it emits any event. Keep the ask's
    // configuration too, so a timeout before the first event is recoverable.
    // The foreground call itself occupies that session; a background job is
    // not created, and the record is removed when this process returns.
    let held = null;
    try {
      if (resolved.conversation) {
        claimForeground(resolved, resolved.conversation);
        held = resolved.conversation;
      }
      if (BACKEND === 'grok' && !resolved.isResume) rememberConversation(resolved, resolved.conversation);
      process.stdout.write(await executeRun(resolved, prompt, opts) + '\n');
    } finally {
      releaseForeground(held);
      if (resolved.foregroundHold && resolved.foregroundHold !== held) releaseForeground(resolved.foregroundHold);
    }
    return;
  }

  if (implementGuardApplies(resolved)) implementDispatchWarning();

  // background: write a job spec, spawn ourselves detached as _worker
  const jobId = `${mode}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const jobsDir = path.join(ensureStateDir(), 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const specFile = path.join(jobsDir, `${jobId}.spec.json`);
  const resultFile = path.join(jobsDir, `${jobId}.result.md`);

  // Register the job BEFORE spawning: a fast worker's own state update must
  // find the record already present, or it gets lost in its read-modify-write.
  const record = {
    backend: BACKEND, id: jobId, mode, pid: null, status: 'running', cwd: process.cwd(),
    model: resolved.model, effort: resolved.effort || null, profile: resolved.profile, profileSource: resolved.profileSource,
    timeout: resolved.timeout, conversation_id: resolved.conversation || null,
    parent_job_id: opts.parentJobId || resolved.parentJobId || null,
    started_at: new Date().toISOString(), log_file: logFile, result_file: resultFile,
    spec_file: specFile,
    events_file: path.join(jobsDir, `${jobId}.events.jsonl`),
    progress_file: path.join(jobsDir, `${jobId}.progress.json`),
  };
  updateState((state) => {
    // Two callers can both resolve an idle conversation. Recheck under the
    // registration lock before accepting either the job or its prompt file.
    refuseRunningFollowUp(state, resolved.conversation);
    fs.writeFileSync(specFile, JSON.stringify({ backend: BACKEND, resolved, prompt, prompt_source: opts.promptSource || null, opts: { json: !!opts.json }, cwd: process.cwd() }, null, 2));
    state.jobs ||= [];
    state.jobs.push(record);
  });
  fs.appendFileSync(logFile, `[${STAFF_NAME}] dispatch registered ${jobId} at ${record.started_at}\n`);

  const logFd = fs.openSync(logFile, 'a');
  // detached on every platform: on POSIX it isolates the process group; on
  // Windows it is DETACHED_PROCESS, so the worker has no console (with
  // windowsHide its own children get none either) and outlives the terminal
  // that dispatched it, including its Ctrl+C.
  const child = spawn(process.execPath, [SELF, '_worker', jobId], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    env: { ...process.env, AGENT_STAFF_BACKEND: BACKEND },
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  // Backfill the pid, preserving whatever status the worker may have written.
  updateJob(jobId, { pid: child.pid });
  child.on('error', (error) => {
    fs.writeFileSync(resultFile, `Job failed: worker launch: ${error.message}\n`);
    updateJob(jobId, { status: 'error', reason: 'worker_launch_error', finished_at: new Date().toISOString() }, true);
  });

  process.stdout.write(
    `Started background ${mode} job.\n` +
      `job id: ${jobId} (pid ${child.pid})\n` +
      `model: ${resolved.model || 'native-default'}  effort: ${resolved.effort || (BACKEND === 'agy' ? 'model-id' : 'native-default')}  profile: ${resolved.profile}  timeout: ${resolved.timeout}\n` +
      `result file (written when the job finishes): ${resultFile}\n` +
      `Collect: run \`wait ${jobId} --timeout 10m\` as a background command ` +
      `(one background wait per job; exit 0 = result printed, 2 = still running — wait again for the same job, without extra progress checks).\n` +
      `Progress only if the user asks: \`observe ${jobId}\`   Stop: \`cancel ${jobId}\`\n`
  );
}

async function workerMain(jobId) {
  inWorker = true;
  const started = Date.now();
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  let job, cancelTimer;
  try {
    job = updateJob(jobId, { worker_started_at: new Date().toISOString(), worker_pid: process.pid, worker_identity: processIdentity(process.pid) });
    process.stderr.write(`[${STAFF_NAME}] worker started ${jobId} pid=${process.pid} at ${job.worker_started_at}\n`);
    if (job.status !== 'running') return;
    const checkCancellation = () => {
      if (job.cancel_requested_at || fs.existsSync(job.spec_file + '.cancel')) controller.abort();
    };
    checkCancellation();
    cancelTimer = setInterval(checkCancellation, 100);
    if (controller.signal.aborted) throw Object.assign(new Error('Execution canceled.'), { reason: 'canceled' });
    const spec = JSON.parse(fs.readFileSync(job.spec_file, 'utf8'));
    assertBackend(spec, 'job specification');
    assertBackend(spec.resolved, 'saved invocation');
    const opts = { ...spec.opts, jobId };
    const output = await executeRun(spec.resolved, spec.prompt, opts, (invoke) => {
      return streamInvocation(invoke, spec.resolved, job, controller,
        durationToMs(spec.resolved.timeout) - (Date.now() - started), (fields) => updateJob(jobId, fields)).catch((error) => {
        if (BACKEND === 'agy' && error.reason === 'missing_result' && isUnsupportedModelError(error.diagnosticText || '')) {
          handleUnsupportedModel({ requestedModel: invoke.model, errText: error.diagnosticText, originalError: error.diagnosticText });
        }
        throw error;
      });
    });
    if (controller.signal.aborted) throw Object.assign(new Error('Execution canceled.'), { reason: 'canceled' });
    // Result and conversation metadata are durable before completion is visible.
    job = finishJob(jobId, output + '\n', { status: 'done', warnings: opts.warnings, ...(opts.resultMetadata || {}) });
    if (job.status === 'done' && !job.warnings && !KEEP_LOGS) {
      for (const file of [job.events_file, job.progress_file]) {
        try { fs.unlinkSync(file); } catch (error) { process.stderr.write(`cleanup: ${error.message}\n`); }
      }
    }
  } catch (error) {
    if (!job) throw error;
    job = loadState().jobs?.find((j) => j.id === jobId);
    if (!job) throw error;
    const reason = error.reason === 'cleanup_unverified' ? error.reason : job.cancel_requested_at ? 'canceled' : error.reason || `${BACKEND}_error`;
    const status = reason === 'cleanup_unverified' ? 'attention' : job.status === 'canceled' || reason === 'canceled' ? 'canceled'
      : reason === 'turn_limit' || (isTimeoutReason(reason) && job.conversation_id) ? 'attention' : 'error';
    job = finishJob(jobId, (completed) => {
      const report = { ...diagnosticPacket(completed), result_exists: true, reason: completed.reason,
        workspace: error.workspace, last_snapshot: readObservation(completed), partial_response: error.partialText,
        native_result: error.payload, cleanup: error.cleanup || completed.cleanup, executionMayBeActive: error.executionMayBeActive ?? completed.executionMayBeActive };
      return `${completed.status === 'attention' ? 'Job needs attention' : 'Job failed'}:\n${completed.reason === 'canceled' ? 'Execution canceled.' : error.message}\n\n${JSON.stringify(report, null, 2)}\n`;
    }, (current) => reason === 'cleanup_unverified' ? { status, reason, cleanup: error.cleanup, executionMayBeActive: true }
      : current.cancel_requested_at ? { status: 'canceled', reason: 'canceled' } : { status, reason });
    process.exitCode = JOB_EXIT_CODES[job.status] ?? 1;
  } finally {
    clearInterval(cancelTimer);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

// ---------------------------------------------------------------------------
// jobs: status / result / cancel
// ---------------------------------------------------------------------------

const CRASH_SANDBOX_HINT =
  'The worker pid is not visible from this process. If the job may have been started from a different harness permission or sandbox context, rerun wait/status/result from the same unsandboxed context before treating it as crashed.';

function refreshJobs(state) {
  for (const job of state.jobs || []) job.status = liveJobStatus(job);
}

function liveJobStatus(job) {
  if (['done', 'canceled', 'error', 'attention'].includes(job.status)) return job.status;
  try {
    const final = JSON.parse(fs.readFileSync(job.result_file + '.status.json', 'utf8'));
    if (['done', 'error', 'canceled', 'attention'].includes(final.status)) return final.status;
  } catch {}
  const workerAlive = pidAlive(job.pid);
  let rows;
  if (workerAlive) {
    if (!job.worker_identity || job.pid == null) return 'running';
    rows = processTable();
    // An unavailable inspection cannot prove that a live PID is a replacement.
    if (!rows || rows.some((row) => row.pid === job.pid && row.born === job.worker_identity.born)) return 'running';
  }
  rows ??= processTable();
  const identities = [job.execution_identity, ...(job.owned_processes || [])].filter(Boolean);
  const survivors = rows ? identities.filter((identity) => rows.some((row) => row.pid === identity.pid && row.born === identity.born)) : [];
  if (!rows || survivors.length) {
    // This is a derived state; read callers may persist it outside any lock.
    // Merely observing a dead worker never sends signals to native execution.
    Object.assign(job, { status: 'attention', reason: 'cleanup_unverified', executionMayBeActive: true,
      cleanup: { status: 'unverified', reason: rows ? 'worker_crashed_with_owned_processes' : 'process_inspection_unavailable',
        survivors, owned: identities } });
    return 'attention';
  }
  // New jobs publish an explicit result status; never infer success from an
  // error report left behind by a worker that died before updating state.
  return !job.spec_file && fs.existsSync(job.result_file) ? 'done' : 'crashed';
}

function persistReconciledAttention(job) {
  if (job.reason !== 'cleanup_unverified' || !job.executionMayBeActive) return;
  updateState((state) => {
    const current = state.jobs?.find((item) => item.id === job.id);
    if (!current || !['running', 'crashed'].includes(current.status)) return;
    // A result committed while inspection ran wins over the derived state.
    if (liveJobStatus(current) !== 'attention') return;
    Object.assign(current, { status: 'attention', reason: 'cleanup_unverified', executionMayBeActive: true, cleanup: job.cleanup });
  });
}

// Machine-readable job exit codes shared by `status <id>` and `wait`.
// 1 stays the generic companion error, so callers can loop on "code 2"
// without parsing any output.
const JOB_EXIT_CODES = { done: 0, running: 2, error: 3, crashed: 3, canceled: 4, attention: 5 };

function cmdStatus(opts) {
  const state = loadState();
  refreshJobs(state);
  const jobs = state.jobs || [];
  for (const job of jobs) persistReconciledAttention(job);
  const id = opts._[0];

  if (id) {
    const job = jobs.find((j) => j.id === id);
    if (!job) die(`no job ${id} in this repository`);
    process.stdout.write(JSON.stringify(job, null, 2) + '\n');
    if (job.status === 'running') {
      process.stdout.write(`\nStill running. Log tail:\n`);
      const log = readTail(job.log_file);
      process.stdout.write(log.split('\n').slice(-10).join('\n') + '\n');
    } else if (job.status === 'crashed' && !fs.existsSync(job.result_file)) {
      process.stdout.write(JSON.stringify(diagnosticPacket(job), null, 2) + '\n');
      process.stdout.write(`\n${CRASH_SANDBOX_HINT}\n`);
    }
    // machine-readable outcome so callers never have to parse the JSON
    process.exitCode = JOB_EXIT_CODES[job.status] ?? 1;
    return;
  }

  if (!jobs.length) {
    process.stdout.write(`No ${STAFF_NAME} jobs recorded in this repository.\n`);
    return;
  }
  process.stdout.write('id | mode | status | started | finished\n');
  for (const j of jobs.slice(-20)) {
    process.stdout.write(`${j.id} | ${j.mode} | ${j.status} | ${j.started_at} | ${j.finished_at || '-'}\n`);
  }
  process.stdout.write('\nDetails: `status <id>`   Output: `result <id>`\n');
  if (jobs.slice(-20).some((j) => j.status === 'crashed' && !fs.existsSync(j.result_file))) {
    process.stdout.write(`\n${CRASH_SANDBOX_HINT}\n`);
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Block until the job reaches a terminal state, then print its result —
 *  `wait` + `result` in one call. Bounded by its own --timeout (default 100s,
 *  chosen to sit under a typical harness per-command timeout); expiring is NOT
 *  a failure: exit code 2 means "still running — call wait again". */
async function cmdWait(opts) {
  const id = opts._[0] || null;
  const timeout = opts.timeout || '100s';
  const budget = durationToMs(timeout);
  if (!Number.isFinite(budget)) die(`invalid --timeout "${timeout}" (examples: 100s, 5m)`);

  // Wait silently: callers use observe for progress, not periodic liveness text.
  // Read-only lookup: the poll loop must never write state.json, or it races
  // the worker's own final read-modify-write (see liveJobStatus).
  // An omitted id selects the latest job once. Later jobs must not replace it.
  const lookup = (pinned) => {
    const jobs = loadState().jobs || [];
    if (pinned) return jobs.find((j) => j.id === pinned) || null;
    return jobs.length ? jobs[jobs.length - 1] : null;
  };
  let job = lookup(id);
  if (!job) die(id ? `no job ${id} in this repository` : `no ${STAFF_NAME} jobs recorded in this repository`);
  const pinned = job.id;

  const POLL_MS = 200;
  const start = Date.now();
  let status = liveJobStatus(job);
  while (status === 'running' && Date.now() - start < budget) {
    await sleepMs(Math.min(POLL_MS, budget - (Date.now() - start)));
    job = lookup(pinned);
    if (!job) die(`job record disappeared from state.json`);
    status = liveJobStatus(job);
  }

  return renderJobResponse(job);
}

function findJob(id) {
  const jobs = loadState().jobs || [];
  const job = id ? jobs.find((j) => j.id === id) : jobs.at(-1);
  if (!job) die(id ? `no job ${id} in this repository` : `no ${STAFF_NAME} jobs recorded in this repository`);
  return job;
}

function readObservation(job) {
  let snapshot = { recent_activities: [], latest_text: null, last_event_at: null, warnings: ['No activity record is available for this job.'] };
  try { snapshot = JSON.parse(fs.readFileSync(job.progress_file, 'utf8')); } catch {}
  return boundSnapshot({ ...snapshot, job_id: job.id, mode: job.mode, status: liveJobStatus(job),
    started_at: job.started_at, observed_at: new Date().toISOString(),
    elapsed_seconds: Math.max(0, Math.round((Date.now() - Date.parse(job.started_at)) / 1000)),
    details: { raw_output: job.events_file || null, diagnostics: job.log_file, result: job.result_file },
  });
}

function readTail(file, limit = 8192) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function isTimeoutReason(reason) {
  return reason === 'response_timeout' || reason === 'hard_timeout';
}

function shellArg(value) {
  return /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function timeoutRecovery(job) {
  const previous = durationToMs(job.timeout) || durationToMs(DEFAULTS.timeout[job.mode]) || 3600000;
  const next = job.mode === 'ask' ? previous * 2 : Math.min(previous * 2, 7200000);
  const suggested = next % 60000 === 0 ? `${next / 60000}m` : `${next / 1000}s`;
  const target = job.id ? `--job ${shellArg(job.id)}` : `--conversation ${shellArg(job.conversation_id || '')}`;
  return {
    inspect: 'git status --short; git diff; git diff --cached', spec_file: job.spec_file || null,
    requires_user_confirmation: true, suggested_timeout: suggested, at_timeout_ceiling: next <= previous,
    continue: job.conversation_id ? `continue ${target} --timeout ${suggested} --prompt "Continue after inspecting partial workspace changes"` : null,
    restart: job.id ? `restart ${shellArg(job.id)} --timeout ${suggested}` : null,
    note: job.conversation_id
      ? 'Ask the user whether to continue ' + (next <= previous ? 'with a narrower task at the 120m ceiling' : `with a larger timeout (suggested: ${suggested})`) +
        ' or stop and inspect the current workspace. No automatic retry or continuation.'
      : 'No conversation ID is available. Inspect partial workspace changes and ask the user before restarting. No retry was started.',
  };
}

function diagnosticPacket(job) {
  let logBytes = null;
  try { logBytes = fs.statSync(job.log_file).size; } catch {}
  return { backend: BACKEND, job_id: job.id, mode: job.mode, cwd: job.cwd || process.cwd(), status: liveJobStatus(job),
    started_at: job.started_at, worker_started_at: job.worker_started_at || null, finished_at: job.finished_at || null,
    pid: job.pid, agy_pid: job.agy_pid || null, log_bytes: logBytes,
    log_state: logBytes === null ? 'missing' : logBytes === 0 ? 'empty' : 'present',
    result_exists: fs.existsSync(job.result_file), log_file: job.log_file, events_file: job.events_file || null,
    conversation_id: job.conversation_id || null, model: job.model || null, profile: job.profile || null,
    cleanup: job.cleanup || null, executionMayBeActive: !!job.executionMayBeActive,
    recovery: job.executionMayBeActive ? { inspect: 'Inspect the retained process identities and cleanup diagnostics.', spec_file: job.spec_file || null,
      continue: null, restart: null, note: 'Execution may still be active. No follow-up may start until cleanup is confirmed.' }
      : isTimeoutReason(job.reason) ? timeoutRecovery(job) : { inspect: 'git status --short; git diff', spec_file: job.spec_file || null,
      continue: job.conversation_id ? `continue --job ${job.id} --prompt "Continue after inspecting partial workspace changes"` : null,
      restart: `restart ${job.id}`, note: 'Inspect partial workspace changes first. Recovery creates a linked new job with a fresh budget; nothing is retried automatically.' },
  };
}

/** Observation never reads the result body, even when completion races a read.
 *  A separate wait/result owns delivery; observers cannot consume its output. */
function readTerminalObservation(job, status) {
  // A result sidecar may be visible just before the shared registry commit.
  let final = {};
  try { final = JSON.parse(fs.readFileSync(job.result_file + '.status.json', 'utf8')); } catch {}
  const finishedAt = job.finished_at || final.finished_at || null;
  const snapshot = {
    job_id: job.id, mode: job.mode, status,
    started_at: job.started_at, finished_at: finishedAt, observed_at: new Date().toISOString(),
    elapsed_seconds: Math.max(0, Math.round(((Date.parse(finishedAt) || Date.now()) - Date.parse(job.started_at)) / 1000)),
    result_file: job.result_file, result_available: fs.existsSync(job.result_file),
    collection: {
      command: `result ${job.id}`,
      instruction: 'Collect the existing wait session if one is pending; otherwise use result for the full output.',
    },
  };
  if (status !== 'done') {
    const reason = job.reason || final.reason || (status === 'crashed' ? 'worker_crashed' : status === 'canceled' ? 'canceled' : 'job_error');
    const packet = diagnosticPacket({ ...job, ...final, reason });
    Object.assign(snapshot, {
      reason,
      summary: reason === 'cleanup_unverified' ? 'Process cleanup is not confirmed; inspect diagnostics before starting a follow-up.'
        : reason === 'turn_limit' ? 'The native turn limit was reached; assess partial output before continuing.'
        : status === 'attention' ? 'Timeout with a resumable conversation; ask the user whether to continue.'
        : reason === 'hard_timeout' ? 'Execution stopped at its hard limit.' : `Job ${status}; inspect the retained report and diagnostics.`,
      conversation_id: job.conversation_id || null, model: job.model || null, profile: job.profile || null,
      worker_started_at: job.worker_started_at || null, pid: job.pid, agy_pid: job.agy_pid || null,
      cleanup: job.cleanup || null, executionMayBeActive: !!job.executionMayBeActive,
      log_state: packet.log_state, log_bytes: packet.log_bytes,
      details: { diagnostics: job.log_file, raw_output: job.events_file || null, snapshot: job.progress_file || null },
      recovery: packet.recovery,
    });
    if (status === 'crashed') snapshot.liveness_note = CRASH_SANDBOX_HINT;
  }
  // Intermediate tool errors remain internal when the overall job succeeds.
  return boundSnapshot(snapshot);
}

function renderJobResponse(initial, { observeOnly = false } = {}) {
  let job = findJob(initial.id);
  let status = liveJobStatus(job);
  if (status === 'attention') persistReconciledAttention(job);
  if (status === 'running') {
    const snapshot = readObservation(job);
    // Success cleanup can race the snapshot read; terminal state wins.
    job = findJob(job.id);
    status = liveJobStatus(job);
    if (status === 'running') {
      process.stdout.write(JSON.stringify(snapshot) + '\n');
      process.exitCode = 2;
      return;
    }
  }
  if (observeOnly) {
    process.stdout.write(JSON.stringify(readTerminalObservation(job, status)) + '\n');
    process.exitCode = JOB_EXIT_CODES[status] ?? 1;
    return;
  }
  // Include warning metadata when the sidecar precedes the registry commit.
  if (job.status === 'running') {
    try { job = { ...job, ...JSON.parse(fs.readFileSync(job.result_file + '.status.json', 'utf8')) }; } catch {}
  }
  if (fs.existsSync(job.result_file)) {
    process.stdout.write(`# Job ${job.id} (${job.mode}, ${status})\n\n`);
    process.stdout.write(fs.readFileSync(job.result_file, 'utf8'));
  } else {
    process.stdout.write(`Job ${job.id} (${job.mode}) finished with status ${status} and no stored result. Log: ${job.log_file}\n`);
    process.stdout.write(JSON.stringify(diagnosticPacket(job), null, 2) + '\n');
    if (status === 'crashed') process.stdout.write(`\n${CRASH_SANDBOX_HINT}\n`);
  }
  if (status === 'done' && job.warnings) {
    process.stderr.write(`Job diagnostics (tail, up to 8192 bytes). Full log: ${job.log_file}\n${readTail(job.log_file)}\n`);
  }
  process.exitCode = JOB_EXIT_CODES[status] ?? 1;
}


function cmdResult(opts) {
  const state = loadState();
  refreshJobs(state);
  const jobs = state.jobs || [];
  let job;
  if (opts._[0]) {
    job = jobs.find((j) => j.id === opts._[0]);
    if (!job) die(`no job ${opts._[0]} in this repository`);
  } else {
    job = [...jobs].reverse().find((j) => j.status !== 'running');
    if (!job) die('no finished jobs in this repository');
  }
  if (job.status === 'running') {
    die(`job ${job.id} is still running — collect it with \`wait ${job.id}\` or peek with \`status ${job.id}\``);
  }
  if (!fs.existsSync(job.result_file)) {
    let msg = `job ${job.id} (${job.status}) has no stored result. Log: ${job.log_file}`;
    if (job.status === 'crashed') {
      msg += `\n${JSON.stringify(diagnosticPacket(job), null, 2)}\n\n${CRASH_SANDBOX_HINT}`;
    }
    die(msg, BACKEND === 'agy' ? 1 : JOB_EXIT_CODES[job.status] ?? 1);
  }
  renderJobResponse(job);
  // Preserve result's historical exit contract for non-attention terminal states.
  process.exitCode = BACKEND === 'agy' ? (job.status === 'attention' ? 5 : 0) : JOB_EXIT_CODES[job.status] ?? 1;
}

async function cmdCancel(opts) {
  const id = opts._[0];
  if (!id) die('cancel needs a job id (see `status`)');
  let changed = false, needsCleanup = false, status;
  const job = updateState((state) => {
    const job = state.jobs?.find((j) => j.id === id);
    if (!job) die(`no job ${id} in this repository`);
    if (job.status === 'running' && job.worker_identity && !job.execution_identity && !job.owned_processes?.length) {
      const current = processIdentity(job.pid);
      if (job.worker_identity.pid !== job.pid || (current && current.born !== job.worker_identity.born)) {
        die('worker identity no longer matches this job; refusing to signal a reused or unrelated PID');
      }
    }
    status = liveJobStatus(job);
    if (status === 'running') {
      if (!job.spec_file) die('this legacy job has no cancellation request channel; cannot safely signal an unverified stored PID');
      const identity = job.worker_identity;
      const current = identity ? processIdentity(job.pid) : null;
      if (identity && (identity.pid !== job.pid || (current && identity.born !== current.born))) {
        die('worker identity no longer matches this job; refusing to signal a reused or unrelated PID');
      }
      // Keep running visible until the worker stores the cancellation report.
      job.cancel_requested_at ||= new Date().toISOString();
      fs.writeFileSync(job.spec_file + '.cancel', job.cancel_requested_at);
      changed = true;
    } else if (job.executionMayBeActive || (status === 'crashed' && (job.execution_identity || job.owned_processes?.length))) {
      // The worker cannot clean its own execution after a hard crash. Only an
      // explicit cancellation authorizes signaling these recorded identities.
      job.status = 'attention';
      job.reason = 'cleanup_unverified';
      job.executionMayBeActive = true;
      job.cancel_requested_at ||= new Date().toISOString();
      needsCleanup = true;
    }
    return job;
  });
  if (needsCleanup) {
    const cleanup = await stopExecution(job.execution_identity || null, job.owned_processes || [], processTable, { backend: BACKEND });
    const confirmed = cleanup?.status === 'confirmed';
    const previousReport = fs.existsSync(job.result_file) ? fs.readFileSync(job.result_file, 'utf8') : '';
    const completed = finishJob(id, (record) => `${previousReport}${previousReport ? '\n\n' : ''}` +
      `${confirmed ? 'Canceled after reconciling the stopped worker. Observed execution cleanup is confirmed.' : 'Cancellation requested, but execution cleanup remains unverified.'}\n` +
      `${JSON.stringify(diagnosticPacket(record), null, 2)}\n`,
    { status: confirmed ? 'canceled' : 'attention', reason: confirmed ? 'canceled' : 'cleanup_unverified',
      cleanup, executionMayBeActive: !confirmed }, { reconcile: true });
    if (confirmed && completed.status === 'canceled') {
      process.stdout.write(`Canceled job ${id}; recorded execution identities were reconciled and cleanup confirmed.\n`);
      return;
    }
    process.stdout.write(`Job ${id} still needs attention; inspect \`observe ${id}\` and the retained cleanup diagnostics.\n`);
    process.exitCode = 5;
    return;
  }
  if (!changed) { process.stdout.write(`Job ${id} is not running (status: ${status}).\n`); return; }
  // The worker polls the request even if PID inspection/signaling is blocked.
  // Never send signals to the stored AGY PID: the worker owns that child.
  // On Windows process.kill() is TerminateProcess: the worker would die without
  // running its cleanup and orphan the agy tree, so rely on the marker alone there.
  const current = job.worker_identity && process.platform !== 'win32' ? processIdentity(job.pid) : null;
  if (current && current.pid === job.worker_identity.pid && current.born === job.worker_identity.born) {
    try { process.kill(current.pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const latest = findJob(id);
    status = liveJobStatus(latest);
    if (status === 'canceled') { process.stdout.write(`Canceled job ${id} (pid ${job.pid}).\n`); return; }
    if (status !== 'running') die(`Cancellation requested, but job is ${status}; inspect \`observe ${id}\` and the retained diagnostics.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  die(`Cancellation requested but the worker has not published a terminal report; inspect \`observe ${id}\` from the original unsandboxed context.`);
}

// ---------------------------------------------------------------------------
// continue
// ---------------------------------------------------------------------------

function enterOriginalWorkspace(cwd) {
  if (!cwd) return; // Legacy records did not store a cwd.
  const root = fs.realpathSync(repoRoot());
  let target;
  try { target = fs.realpathSync(cwd); } catch { die(`original workspace directory is unavailable: ${cwd}`); }
  const git = sh('git', ['rev-parse', '--show-toplevel'], { cwd: target });
  const targetRoot = fs.realpathSync(git.code === 0 && git.out ? git.out : target);
  if (root !== targetRoot) die(`recovery cannot switch worktrees; run from the original workspace: ${cwd}`);
  process.chdir(target);
  repoRootCache.set(target, git.code === 0 && git.out ? git.out : target);
  repoRootCache.set(process.cwd(), git.code === 0 && git.out ? git.out : target);
}

function cmdContinue(opts) {
  const state = loadState();
  const explicitJob = opts.job ? findJob(opts.job) : null;
  const targetId = opts.conversation || explicitJob?.conversation_id || state.last?.id;
  const recorded = targetId ? state.conversation_configs?.[targetId] || null : null;
  const latestJob = targetId ? [...(state.jobs || [])].reverse().find((j) => j.conversation_id === targetId) : null;
  // Without --job, follow the latest session record. The older job remains
  // only a fallback for lineage and for records that predate conversation_configs.
  const prior = explicitJob || recorded || latestJob;
  const legacyMode = Object.entries(state.conversations || {}).find(([, id]) => id === targetId)?.[0];
  const mode = prior?.mode || legacyMode || (state.last?.id === targetId ? state.last?.mode : null);
  const conversation = explicitJob?.conversation_id || latestJob?.conversation_id || targetId;
  if (opts.job) refuseRunningFollowUp(state, explicitJob?.conversation_id, explicitJob?.id);
  if (!mode || !conversation) die('no previous agy-staff conversation recorded in this repository for this target; use restart <job-id> when no conversation is available');
  if (opts.job && opts.conversation && opts.conversation !== explicitJob.conversation_id) die('--job and --conversation identify different conversations');
  if (opts.job && !explicitJob.conversation_id) die('this job has no known conversation; use restart <job-id>');
  const task = taskText(opts);
  if (!task) die('continue needs follow-up text');
  enterOriginalWorkspace(prior?.cwd);
  const resolved = resolveRun(mode, { ...opts, conversation }, explicitJob);
  const workspace = mode === 'implement' ? dirtyWorkspacePrompt() : '';
  const prompt = `${workspace ? `${workspace}\n\n` : ''}Follow-up in the same conversation:\n\n${task}`;
  let json = !!opts.json;
  if (explicitJob?.spec_file) {
    // The selected job owns its own format, just as it owns its model and profile.
    try { json ||= !!JSON.parse(fs.readFileSync(explicitJob.spec_file, 'utf8')).opts.json; } catch {}
  } else if (recorded && Object.hasOwn(recorded, 'json')) {
    json ||= !!recorded.json;
  } else if (latestJob?.spec_file) {
    try { json ||= !!JSON.parse(fs.readFileSync(latestJob.spec_file, 'utf8')).opts.json; } catch {}
  }
  return dispatch(resolved, prompt, { ...opts, json, parentJobId: explicitJob?.id, promptSource: { kind: 'followup', task } });
}

function cmdRestart(opts) {
  if (!opts._[0]) die('restart needs a job id');
  const job = findJob(opts._[0]);
  if (liveJobStatus(job) === 'running') die('job is still running; cancel it before restarting');
  if (job.executionMayBeActive) die('job cleanup is unverified; inspect diagnostics before restarting');
  if (!job.spec_file) die('this legacy job has no stored restart specification');
  const spec = JSON.parse(fs.readFileSync(job.spec_file, 'utf8'));
  assertBackend(spec, 'job specification');
  assertBackend(spec.resolved, 'saved invocation');
  enterOriginalWorkspace(spec.cwd);
  const resolved = { ...spec.resolved, backend: BACKEND, conversation: null, isResume: false, timeout: DEFAULTS.timeout[job.mode] };
  if (opts.timeout) {
    resolved.timeout = resolveRun(job.mode, { ...opts, model: resolved.model, [resolved.profile]: true }).timeout;
  }
  // Rebuild saved task sources with fresh context. For legacy prompts, label
  // historical snapshots and append current facts without parsing task text.
  const source = spec.prompt_source || { kind: 'legacy', text: spec.prompt };
  let prompt;
  if (source.kind === 'template') prompt = buildPrompt(job.mode, { prompt: source.task });
  else if (source.kind === 'followup') prompt = `${job.mode === 'implement' ? dirtyWorkspacePrompt() + '\n\n' : ''}Follow-up task in a fresh conversation:\n\n${source.task}`;
  else {
    const current = `${gatherContext()}\n\n${job.mode === 'implement' ? dirtyWorkspacePrompt() || 'Working tree is currently clean.' : ''}`;
    prompt = `Restart the original task below. Its embedded workspace/environment snapshots are historical. Use the current workspace section at the end for this execution; preserve existing partial work.\n\n${source.text}\n\n## Current workspace for this restart\n\n${current}`;
  }
  return dispatch(resolved, prompt, { ...spec.opts, parentJobId: job.id, promptSource: source });
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

/** `setup --restrict <modes|none>`: write the per-repo policy. Declarative —
 *  the listed modes become restricted-by-default, every unlisted mode falls
 *  back to the built-in default. Written directly (no --apply): the file is
 *  repo-local, git-ignored by convention, and trivially reversible. */
function applyProjectPolicy(value) {
  if (value === 'none') {
    updateProjectConfig(cfg => { delete cfg.profiles; });
    process.stdout.write(`Project policy cleared — all modes use the built-in defaults again.\n\n`);
    return false;
  }

  const modes = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!modes.length) die('--restrict needs a value: a comma-separated list of modes, or "none" to clear');
  for (const m of modes) {
    if (m === 'ask') die('ask is tool-free and always restricted; it cannot be configured');
    if (!CONFIGURABLE_MODES.includes(m)) {
      die(`--restrict: unknown mode "${m}" (configurable: ${CONFIGURABLE_MODES.join(', ')}, or "none" to clear)`);
    }
  }
  updateProjectConfig(cfg => { cfg.profiles = Object.fromEntries(modes.map(m => [m, 'restricted'])); });

  process.stdout.write(`Project policy written: ${configPath()}\n`);
  for (const m of modes) process.stdout.write(`  ${m}: restricted (default for this repository)\n`);
  process.stdout.write(
    'Unlisted modes keep the built-in default (unrestricted). A --restricted/--unrestricted flag on a\n' +
      `call still overrides the policy. This is a per-repo, per-machine preference (.${STAFF_NAME}/ is\n` +
      'normally git-ignored, so it is not shared with the team) and a run policy, not a security\n' +
      'boundary — for untrusted input use an isolated checkout.\n\n'
  );
  return true;
}

function cmdSetup(opts) {
  if (BACKEND !== 'agy') {
    if (opts.apply) die(`UNSUPPORTED_CAPABILITY: ${BACKEND} setup does not edit native global permission settings. Use setup --restrict <modes|none> for the local staff policy.`);
    if (opts.restrict !== undefined) applyProjectPolicy(opts.restrict);
    process.stdout.write(`Project policy (${configPath()}): ${JSON.stringify(loadProjectConfig()?.profiles || {})}\n` +
      `${STAFF_NAME} uses native permissions for --restricted runs; this command does not modify the CLI's global settings.\n`);
    return;
  }
  // check agy availability
  const probe = agyCommand(['--version']);
  const v = sh(probe.cmd, probe.args);
  if (v.code !== 0) {
    die(
      `agy CLI not found or not working (tried \`${AGY_BIN} --version\`).\n` +
        'Install Google Antigravity CLI and make sure `agy` is on PATH (expected at ~/.local/bin/agy).'
    );
  }

  let policyWritten = false;
  if (opts.restrict !== undefined) policyWritten = applyProjectPolicy(opts.restrict);

  let settings = {};
  let exists = false;
  try {
    settings = JSON.parse(fs.readFileSync(AGY_SETTINGS, 'utf8'));
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') die(`cannot read settings ${AGY_SETTINGS}: ${error.message}`);
  }

  const current = settings.permissions?.allow || [];
  const denied = settings.permissions?.deny || [];
  const missing = EVIDENCE_ALLOWLIST.filter((r) => !current.includes(r));
  const missingDeny = EVIDENCE_DENYLIST.filter((r) => !denied.includes(r));

  process.stdout.write(`agy CLI: OK (version ${v.out})\n`);
  const profiles = loadProjectConfig()?.profiles || {};
  const policyLine = Object.keys(profiles).length
    ? Object.entries(profiles)
        .map(([m, p]) => `${m}=${p}`)
        .join(' ')
    : '(none — built-in defaults apply)';
  process.stdout.write(`Project policy (${configPath()}): ${policyLine}\n`);
  process.stdout.write(`Global settings file: ${AGY_SETTINGS} ${exists ? '(exists)' : '(will be created)'}\n\n`);
  if (!missing.length && !missingDeny.length) {
    process.stdout.write('The evidence-gathering allow/deny rules are already installed. Nothing to do.\n');
    printSetupNotes();
    return;
  }

  process.stdout.write(
    'Setup is optional hardening: research/review/implement already run unrestricted by default.\n' +
      'It only matters if you use `--restricted`, which keeps agy\'s permission enforcement on.\n'
  );
  process.stdout.write('Evidence-gathering rules for restricted runs — permissions.allow:\n\n');
  for (const r of EVIDENCE_ALLOWLIST) {
    process.stdout.write(`  ${r}${current.includes(r) ? '  (already present)' : ''}\n`);
  }
  process.stdout.write('\npermissions.deny (AGY evaluates deny before ask before allow):\n\n');
  for (const r of EVIDENCE_DENYLIST) {
    process.stdout.write(`  ${r}${denied.includes(r) ? '  (already present)' : ''}\n`);
  }
  process.stdout.write(`\nMissing rules will be appended to "permissions.allow" and "permissions.deny" in ${AGY_SETTINGS}.\n`);
  process.stdout.write(
    'Scope: this file is GLOBAL — the rules apply to every agy run on this machine, not just this repository.\n' +
      'Broad git/gh grants avoid enumerating every task\'s commands; five deny prefixes block common risky operations.\n' +
      'These rules are NOT read-only: other command forms, scripts and APIs can still write or cause external effects.\n'
  );

  if (!opts.apply) {
    process.stdout.write(
      policyWritten
        ? '\nRULES DRY RUN — the global settings file was not touched (only the project policy above was written).\n' +
            'The settings file will be backed up first. To apply the rules: rerun with --apply after the user confirms.\n'
        : '\nDRY RUN — nothing written. The settings file will be backed up first.\n' +
            'To apply: rerun with --apply after the user confirms.\n'
    );
    printSetupNotes();
    return;
  }

  if (exists) {
    const backup = `${AGY_SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(AGY_SETTINGS, backup);
    process.stdout.write(`\nBacked up settings to ${backup}\n`);
  } else {
    fs.mkdirSync(path.dirname(AGY_SETTINGS), { recursive: true });
  }

  settings.permissions = settings.permissions || {};
  settings.permissions.allow = [...current, ...missing];
  settings.permissions.deny = [...denied, ...missingDeny];
  fs.writeFileSync(AGY_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  process.stdout.write(`Wrote ${missing.length} allow-rule(s) and ${missingDeny.length} deny-rule(s) to ${AGY_SETTINGS}. Setup complete.\n`);
  printSetupNotes();
}

function printSetupNotes() {
  process.stdout.write(
    '\nNotes:\n' +
      '- Scope: these rules live in the GLOBAL settings file above, so they apply to every agy run on\n' +
      '  this machine, in any repository — not only where you ran setup.\n' +
      '- Command rules are prefix-matched by AGY, with deny > ask > allow. Existing rules are preserved.\n' +
      '  Denied operations stay denied even when requested in the prompt; change the rules explicitly if needed.\n' +
      '  Other command forms, scripts and APIs are not covered. This is an evidence-gathering setup,\n' +
      '  not a read-only one or a guarantee that every irreversible action is blocked.\n' +
      '- Security-sensitive users can scope permissions per project instead: agy supports project-scoped\n' +
      '  permission rules (highest priority) tied to its --project system, but the exact project-settings\n' +
      '  file path is undocumented/unverified, so this setup only edits the global file above. If a rule\n' +
      '  seems ignored, check agy interactively for project-level overrides.\n' +
      '- This allowlist only affects restricted runs. research/review/implement are unrestricted by\n' +
      '  default (--dangerously-skip-permissions), and unrestricted runs ignore permission rules entirely.\n' +
      '- Per-repo policy: `setup --restrict <mode,...>` (e.g. review,research) makes those modes default\n' +
      '  to the restricted profile in THIS repository only; `setup --restrict none` clears it. The policy\n' +
      '  lives in .agy-staff/config.json (normally git-ignored — a personal preference, not shared with\n' +
      '  the team), and a --restricted/--unrestricted flag on a call always wins. It is a run policy for\n' +
      '  consistency, not a security boundary.\n' +
      '- Some agy tools ignore allow-rules in headless mode entirely and only work unrestricted. If a\n' +
      '  --restricted run keeps coming back empty even after setup, drop --restricted.\n'
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  if (!BACKENDS.includes(BACKEND)) die(`unknown backend: ${BACKEND}`);
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    die(
      'usage: agy-companion.mjs <staffer|research|review|implement|ask|continue|restart|observe|status|wait|result|cancel|setup|config|models> [flags]\n' +
        'flags: --restricted|--unrestricted --model <id|default> --effort <level|default> --timeout <dur> ' +
        '--prompt <text> --prompt-file <path> --stdin --conversation <id> --continue --json (review) ' +
        '--apply --restrict <modes|none> (setup)\n' +
        'task text for staffer/research/review/implement/ask/continue comes from exactly one of ' +
        '--prompt <text>, --prompt-file <path>, or --stdin.\n' +
        'staffer/research/review/implement run unrestricted by default (no setup needed); --restricted is the ' +
        'hardening opt-in that uses the evidence-gathering allowlist from `setup`. ask is always tool-free. ' +
        'Per-repo policy: `setup --restrict review,research` makes those modes restricted by default here.'
    );
  }
  const opts = parseFlags(rest, { taskCommand: MODES.includes(cmd) || cmd === 'continue' });

  if (MODES.includes(cmd)) return cmdRun(cmd, opts);
  switch (cmd) {
    case 'continue':
      return cmdContinue(opts);
    case 'restart':
      return cmdRestart(opts);
    case 'observe':
      return renderJobResponse(findJob(opts._[0]), { observeOnly: true });
    case 'status':
      return cmdStatus(opts);
    case 'wait':
      return cmdWait(opts);
    case 'result':
      return cmdResult(opts);
    case 'cancel':
      return cmdCancel(opts);
    case 'setup':
      return cmdSetup(opts);
    case 'config':
      return cmdConfig(opts);
    case 'models':
      if (opts._.length || Object.keys(opts).length > 1) die('usage: models');
      process.stdout.write(JSON.stringify(modelCatalog(BACKEND), null, 2) + '\n');
      return;
    case '_worker':
      return workerMain(rest[0]);
    default:
      die(`unknown subcommand: ${cmd}`);
  }
}

Promise.resolve().then(main).catch((error) => {
  if (!error.alreadyPrinted) process.stderr.write(`${STAFF_NAME} error: ${error?.message || String(error)}\n`);
  process.exitCode = error.exitCode || 1;
});
