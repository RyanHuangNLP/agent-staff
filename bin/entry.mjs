import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BACKENDS, backendBinary } from '../companion/backend-adapters.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backends = BACKENDS;
const valueFlags = new Set(['--prompt', '--prompt-file', '--model', '--effort', '--timeout', '--conversation', '--job', '--restrict', '--response-schema', '--grok-allow', '--grok-deny']);

export async function main(fixedBackend = null, input = process.argv.slice(2)) {
  let selected = null;
  const args = [];
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (arg === '--backend') {
      if (selected !== null || !input[i + 1] || input[i + 1].startsWith('--')) throw new Error('Use --backend agy|grok|cursor|codex once.');
      selected = input[++i];
    } else {
      args.push(arg);
      if (valueFlags.has(arg) && i + 1 < input.length) args.push(input[++i]);
    }
  }
  if (fixedBackend && selected && selected !== fixedBackend) throw new Error(`${fixedBackend}-staff cannot target backend ${selected}. Use agent-staff --backend ${selected}.`);
  const backend = selected || fixedBackend || process.env.AGENT_STAFF_BACKEND || 'agy';
  if (!backends.includes(backend) && !(backend === 'all' && args[0] === 'doctor')) throw new Error(`Unknown backend: ${backend}`);

  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    process.stdout.write(`agent-staff ${version}\n`);
    return;
  }
  if (!args.length || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]))) {
    process.stdout.write(`agent-staff — choose one staff for this task\n\n` +
      `Usage: agent-staff [--backend agy|grok|cursor|codex] COMMAND [flags]\n` +
      `Aliases: agy-staff, grok-staff, cursor-staff, codex-staff\n` +
      `Tasks: staffer | research | review | implement | ask\n` +
      `Jobs: continue | restart | wait | observe | status | result | cancel\n` +
      `Setup: config | models | setup (optional restricted policy) | doctor [--backend all]\n` +
      `Input: --prompt TEXT | --prompt-file FILE | --stdin\n` +
      `Options: --model ID|default --effort LEVEL|default --restricted|--unrestricted\n` +
      `         --timeout DURATION --continue --conversation ID --json (review)\n\n` +
      `config shows project model defaults; config --model ID --effort LEVEL saves/updates them.\n` +
      `config --reset clears only model defaults. models discovers native model choices.\n` +
      `Explicit flags > conversation settings > project defaults > native/built-in defaults.\n` +
      `AGY effort: low|medium|high. Grok/Codex: model-dependent native levels.\n` +
      `Cursor: choose an effort-specific native --model; separate --effort is unsupported.\n` +
      `ask returns an answer in this call; other roles return a job ID.\n` +
      `Each backend has its own workspace state and continuation history.\n` +
      `lead is a host skill, not a CLI mode or a multi-staff scheduler.\n`);
    return;
  }
  if (args[0] === 'doctor') {
    if (args.length !== 1) throw new Error('Usage: agent-staff doctor [--backend agy|grok|cursor|codex|all]');
    const reports = (backend === 'all' ? backends : [backend]).map(id => {
      const binary = backendBinary(id);
      const script = /\.(?:mjs|cjs|js)$/i.test(binary);
      const r = spawnSync(script ? process.execPath : binary, script ? [binary, '--version'] : ['--version'], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
      return { backend: id, binary, available: !r.error && r.status === 0,
        version: !r.error && r.status === 0 ? (r.stdout || r.stderr).trim() : null,
        error: r.error ? r.error.message : r.status !== 0 ? (r.stderr || `exit ${r.status}`).trim() : null };
    });
    const ok = reports.every(item => item.available);
    process.stdout.write(JSON.stringify({ ok, backends: reports }, null, 2) + '\n');
    process.exitCode = ok ? 0 : 1;
    return;
  }
  process.env.AGENT_STAFF_BACKEND = backend;
  process.argv = [process.execPath, path.join(root, 'companion/agy-companion.mjs'), ...args];
  await import('../companion/agy-companion.mjs');
}

export function reportError(error) {
  process.stderr.write(`agent-staff: ${error.message}\n`);
  process.exitCode = 1;
}
