import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { backendBinary } from './backend-adapters.mjs';

// Catalog reads never start a model task or change the native CLI's settings.
// Keep discovery separate from execution: custom providers and newer model IDs
// must not be rejected just because an optional catalog is absent or stale.
export function modelCatalog(backend) {
  if (backend === 'codex') {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
    let cache;
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(cache.models)) throw new Error('missing models array');
    } catch (error) {
      return { backend, source: 'unavailable', models: [],
        notice: `Codex model cache unavailable (${error.code || error.message}). Use the native default or an explicit model ID; the native /model picker can refresh the catalog.` };
    }
    return { backend, source: 'native-cache', fetched_at: cache.fetched_at || null,
      models: cache.models.filter(m => m && typeof m.slug === 'string' && m.visibility !== 'hide').map(m => ({
        id: m.slug, name: m.display_name || m.slug,
        efforts: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
          .map(level => level?.effort).filter(level => typeof level === 'string'),
        default_effort: m.default_reasoning_level || null,
      })),
      notice: 'Cached native catalog; availability and supported efforts depend on the account, provider, model, and CLI version. Custom model IDs remain accepted.' };
  }
  const binary = backendBinary(backend);
  const script = /\.(?:mjs|cjs|js)$/i.test(binary);
  const env = { ...process.env };
  delete env.AGENT_STAFF_BACKEND;
  const result = spawnSync(script ? process.execPath : binary, script ? [binary, 'models'] : ['models'], {
    encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Model discovery failed for ${backend}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  const output = (result.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
  const models = [];
  for (const line of output.split(/\r?\n/)) {
    const match = backend === 'agy' ? /^(\S+)\t(.+)$/.exec(line)
      : backend === 'grok' ? /^\s*[-*]\s+(\S+)(.*)$/.exec(line)
      : /^(\S+)\s+-\s+(.+)$/.exec(line);
    if (!match) continue;
    models.push({ id: match[1], name: match[2].trim() || match[1] });
  }
  return { backend, source: 'native-cli', models, native_output: output.trim(),
    notice: backend === 'cursor'
      ? 'Select a listed effort-specific model ID, or a native bracket-parameter model supported by this CLI. A separate --effort is not supported.'
      : backend === 'agy'
        ? 'AGY uses concrete model IDs. Flash/pro aliases accept low|medium|high where supported; a concrete ID determines its effort.'
        : 'Use --effort only with a reasoning model and a level supported by Grok. Leaving effort at default preserves native behavior.' };
}
