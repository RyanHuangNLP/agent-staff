#!/usr/bin/env node
// Package the one shared runtime into self-contained backend plugin sources.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roles = ['lead', 'staffer', 'researcher', 'reviewer', 'implementer', 'ask', 'jobs'];
const titles = { grok: 'Grok Build', cursor: 'Cursor Agent' };
const modes = { staffer: 'staffer', researcher: 'research', reviewer: 'review', implementer: 'implement', ask: 'ask' };
const goals = {
  staffer: 'Delegate a general task; the user task determines the work and output.',
  researcher: 'Delegate research that returns evidence, sources, conclusions, and uncertainties.',
  reviewer: 'Delegate an independent review of code, a plan, or a decision.',
  implementer: 'Delegate a scoped code change and the verification needed to assess it.',
  ask: 'Ask a short question and return the answer in the same call.',
  jobs: 'Wait for, inspect, cancel, continue, or restart this employee’s jobs.',
  lead: 'Lead the current task by delegating to this employee and assessing its results.',
};

function skill(backend, role) {
  const title = titles[backend], entry = `<skill-dir>/../../companion/${backend}-companion.mjs`;
  const header = `---\nname: ${role}\ndescription: ${JSON.stringify(`${goals[role]} Use when the user invokes $${backend}:${role} or requests this workflow with ${title}.`)}\n---\n\n# ${title} ${role}\n\n`;
  const runtime = `The plugin includes its own shared runtime. Resolve this path from this skill directory:\n\n\`\`\`sh\nnode "${entry}" ${modes[role] || 'staffer'} --prompt-file "<task-file>"\n\`\`\`\n\nRun the CLI in the same local permission context as its existing authenticated installation. Use the host’s normal escalation mechanism if its command sandbox prevents authentication, network access, or owned-process inspection. Do not read credentials or modify global CLI settings.\n\n`;
  if (role === 'lead') return header + `You are the lead in the current host. Use ${title} as the selected employee for this task; do not start or switch to another backend unless the user asks. This guidance adds no scheduler or multi-staff collaboration.\n\n` +
    `Frame the assignment with the user’s outcome, constraints, context, and existing authorization. Delegate substantive work to staffer by default; use researcher, reviewer, or implementer when that role helps. Keep related work in one conversation. Handle small checks directly when handoff would cost more than it helps.\n\n` +
    `Read ../jobs/SKILL.md and wait for the result. Assess it against the requested outcome, including relevant diffs and verification. Turn concrete gaps into a focused follow-up in the same conversation, then integrate and deliver the result. Preserve important evidence and disclose unverified parts. You retain user communication and final judgment.\n\n` +
    `Usually one employee runs at a time. If the user explicitly requests parallel work, read tasks may share a worktree; editing tasks run sequentially or in separate worktrees. Do not create worktrees or extra assignments merely because a worker is running.\n\n` + runtime;
  if (role === 'jobs') return header +
    `The employee’s CLI is \`node "${entry}"\`. Its job state is scoped to this backend and the current Git worktree (or current non-Git directory). Keep the returned job ID with the assignment.\n\n` +
    `- After dispatch, use \`wait <id> --timeout 10m\`. Exit 2 only means this wait expired; wait again for the same job. Use the host’s pending-command collection mechanism while a wait is running. Do not launch routine status/observe loops.\n` +
    `- When the user asks for progress, use \`observe <id>\`; it is a bounded snapshot, not the full result. Get the full result from wait or result.\n` +
    `- \`status [id]\` lists or inspects jobs. \`wait\` and \`observe\` without an ID select this employee’s latest job at the moment the command starts; a wait already in progress does not switch to a job started later. \`result\` without an ID selects its latest finished job. Prefer the ID already tracked by the host.\n` +
    `- Use only this employee’s entry for wait, continue, status, and result. A job started with grok-staff is collected with grok-staff wait, not cursor-staff or agy-staff, and the same rule applies to the other two entries.\n` +
    `- For a requested follow-up, use \`continue --job <id> --prompt-file <file>\`; \`continue --prompt <text>\` also resumes this employee’s latest conversation. Model and permissions are inherited unless explicitly overridden. The same running session cannot accept another turn.\n` +
    `- For an immediate change, \`cancel <id>\`, confirm cleanup, inspect partial work, then continue. Ending a wait does not stop the worker. \`restart <id>\` creates a fresh conversation for the original assignment.\n` +
    `- On timeout, return the saved diagnosis and recovery command. Follow existing user authorization; if continuation was not authorized, obtain it before consuming another run. Never silently change backend, model, or permissions after failure.\n\n` +
    `For direct persona invocations, relay short results faithfully; summarize long results and link the complete file without rewriting evidence or errors. For lead, assess and integrate. Diagnostics and usage are separate from the answer. A successful CLI turn does not prove the user task was accomplished: check relevant artifacts before relying on it.\n\n` +
    `Common options: --restricted/--unrestricted, --model, --timeout; --json requests the built-in review result shape. The normal tool roles work without setup. Optional \`setup --restrict review,research\` sets only this employee’s repository policy. Native global allow/deny rules remain the CLI’s configuration and are not copied from AGY.\n`;
  let guidance = `Pass the user’s task, constraints, and explicit authorizations faithfully. Do not complete the delegated work first and then hand the employee your answer. The chosen backend stays ${backend}.\n\n`;
  if (role === 'researcher') guidance += `Ask for source-backed findings, supporting locations or links, and uncertainties. Preserve the working tree and report any unexpected changes.\n\n`;
  if (role === 'reviewer') guidance += `Choose code review or general review by the subject. Read references/code-review.md for code, or references/general-review.md for plans and decisions, and include the relevant review brief. The employee gathers evidence itself. Preserve tracked files; findings need evidence, conditions, impact, and locations. --json is for the built-in code-review shape; validation failure is a diagnostic, not a successful review.\n\n`;
  if (role === 'implementer') guidance += `The assignment includes the necessary verification. Existing dirty-worktree edits belong to the user: preserve them and keep the change scoped. Default delivery is a diff and verification report; include commits, pushes, or PR actions only when the user requested them. Non-Git work is supported with the runtime’s limitation notice.\n\n`;
  if (role === 'staffer') guidance += `Use the task’s requested output; do not impose a specialist report format. Native employee capabilities may be used when the task calls for them.\n\n`;
  if (role === 'ask') guidance += `This is question-only foreground mode with a restricted profile. Do not add repository context or tell the employee to inspect files, run tools, or fetch material. Return its answer faithfully; use a tool-enabled role for work requiring tools. The no-tool instruction is not a claim of OS sandbox isolation. No setup is required.\n\n`;
  else guidance += `This role returns a background job ID. Read ../jobs/SKILL.md, wait for the complete result, and collect it. Observe only for a user progress request or relevant failure diagnosis.\n\n`;
  guidance += `Model defaults come from ${title}; --model passes a native ID unchanged. ` + (backend === 'grok' ? `--effort passes Grok’s native reasoning effort.` : `Use the native model ID (including supported bracket parameters); a separate --effort is not mapped to Gemini-style names.`) +
    ` Tool roles default to unrestricted operation; --restricted is an explicit opt-in, while ask stays restricted. Native deny and managed policies can still limit operations.\n\n`;
  return header + guidance + runtime;
}

function collect(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(ent => {
    if (ent.isSymbolicLink()) throw new Error(`Unexpected symlink: ${path.join(dir, ent.name)}`);
    const rel = path.join(prefix, ent.name);
    return ent.isDirectory() ? collect(path.join(dir, ent.name), rel) : [rel];
  });
}

export function pluginFiles(root = ROOT) {
  const files = new Map(), { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const backend of Object.keys(titles)) {
    const base = path.join('plugins', backend);
    for (const folder of ['companion', 'templates']) {
      for (const rel of collect(path.join(root, folder))) files.set(path.join(base, folder, rel), fs.readFileSync(path.join(root, folder, rel)));
    }
    for (const name of ['LICENSE','NOTICE']) files.set(path.join(base,name),fs.readFileSync(path.join(root,name)));
    for (const role of roles) files.set(path.join(base,'skills',role,'SKILL.md'),Buffer.from(skill(backend,role)));
    for (const rel of collect(path.join(root,'skills/reviewer/references'))) files.set(path.join(base,'skills/reviewer/references',rel),fs.readFileSync(path.join(root,'skills/reviewer/references',rel)));
    const manifest = { name: backend, version, description: `${titles[backend]} employee using the original AGY Staff workflow.`, license: 'MIT', skills: './skills/', interface: { displayName: `${titles[backend]} Staff`, shortDescription: `Delegate to one ${titles[backend]} employee.`, category:'Engineering', capabilities:['Instructions'] } };
    files.set(path.join(base,'.codex-plugin/plugin.json'),Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
    files.set(path.join(base,'.claude-plugin/plugin.json'),Buffer.from(JSON.stringify({name:backend,version,description:manifest.description,license:'MIT'},null,2)+'\n'));
    files.set(path.join(base,'package.json'),Buffer.from(JSON.stringify({name:`${backend}-staff`,version,private:true,type:'module',engines:{node:'>=24'}},null,2)+'\n'));
  }
  return files;
}

export function buildPlugins({ root = ROOT, check = false } = {}) {
  const expected = pluginFiles(root), changed = [];
  const generatedRoot=path.join(root,'plugins');
  if(fs.existsSync(generatedRoot)) for(const file of collect(generatedRoot)) if(!expected.has(path.join('plugins',file))) throw new Error(`Unexpected generated plugin file: ${file}`);
  for (const [rel, bytes] of expected) {
    const file = path.join(root,rel);
    if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) continue;
    changed.push(rel);
    if (!check) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,bytes); }
  }
  if (check && changed.length) throw new Error(`Plugin packages are stale. Run npm run build:plugins.\n${changed.join('\n')}`);
  return { files: expected.size, changed };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(x => x !== '--check')) throw new Error('Usage: build-plugins.mjs [--check]');
    const result = buildPlugins({check:process.argv.includes('--check')});
    console.log(`Backend plugin packages ${process.argv.includes('--check')?'verified':'generated'}: ${result.files} files (${result.changed.length} changed).`);
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
