import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlugins } from '../scripts/build-plugins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (file,args,env={}) => spawnSync(process.execPath,[path.join(root,file),...args],{encoding:'utf8',timeout:15000,env:{...process.env,...env}});

test('entrypoints expose all roles, preserve backend binding, and version needs no CLI login', () => {
  for (const name of ['agent','agy','grok','cursor']) {
    const file = `bin/${name}-staff.mjs`;
    const help=run(file,['--help']);assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/continue.*restart.*wait/);
    const version=run(file,['--version']);assert.equal(version.status,0,version.stderr);assert.match(version.stdout,/agent-staff 0\.8\.0/);
  }
  const conflict=run('bin/grok-staff.mjs',['--backend','cursor','ask','--prompt','x']);
  assert.equal(conflict.status,1);assert.match(conflict.stderr,/cannot target backend cursor/);
  const invalid=run('bin/agent-staff.mjs',['--backend','unknown','ask','--prompt','x']);
  assert.equal(invalid.status,1);assert.match(invalid.stderr,/Unknown backend/);
});

test('doctor reports missing backends without starting a model or requiring authentication', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-staff-doctor-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const fake=path.join(dir,'version.mjs');fs.writeFileSync(fake,"if(process.argv[2]!=='--version')process.exit(99);console.log('verified-fake-1');\n");
  const ok=run('bin/agent-staff.mjs',['doctor','--backend','all'],{AGY_BIN:fake,GROK_BIN:fake,CURSOR_BIN:fake});
  assert.equal(ok.status,0,ok.stderr);const report=JSON.parse(ok.stdout);assert.equal(report.ok,true);assert.equal(report.backends.length,3);
  const missing=run('bin/agent-staff.mjs',['--backend','grok','doctor'],{GROK_BIN:path.join(dir,'missing')});
  assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stdout).backends[0].available,false);
});

test('generated backend plugins contain seven usable roles and a standalone shared runtime', () => {
  assert.deepEqual(buildPlugins({check:true}).changed,[]);
  const names=['lead','staffer','researcher','reviewer','implementer','ask','jobs'];
  for(const backend of ['grok','cursor']) {
    const base=path.join(root,'plugins',backend);
    const manifest=JSON.parse(fs.readFileSync(path.join(base,'.codex-plugin/plugin.json'),'utf8'));
    assert.equal(manifest.name,backend);
    for(const name of names) {
      const dir=path.join(base,'skills',name);
      const skill=fs.readFileSync(path.join(dir,'SKILL.md'),'utf8');
      assert.match(skill,new RegExp(`^name: ${name}$`,'m'));
      const runtime=path.resolve(dir,`../../companion/${backend}-companion.mjs`);
      assert.ok(fs.existsSync(runtime));
      for(const m of skill.matchAll(/(?:\.\.\/jobs\/SKILL\.md|references\/[a-z-]+\.md)/g)) assert.ok(fs.existsSync(path.resolve(dir,m[0])),`${backend}/${name}: ${m[0]}`);
    }
    for(const file of ['agy-companion.mjs','backend-adapters.mjs','stream-worker.mjs','observation.mjs','state-lock.mjs']) {
      assert.deepEqual(fs.readFileSync(path.join(base,'companion',file)),fs.readFileSync(path.join(root,'companion',file)));
    }
  }
});
