#!/usr/bin/env python3
"""Bounded Cursor CLI integration preflight. Writes only beside this script."""
import argparse, datetime, json, os, pathlib, secrets, shutil, signal, subprocess, time

ROOT = pathlib.Path(__file__).resolve().parent
WS = ROOT / 'workspace'
LOGS = ROOT / 'logs'
CLI = os.environ.get('CURSOR_AGENT_BIN') or shutil.which('cursor-agent') or shutil.which('agent') or 'cursor-agent'
STATE = ROOT / 'state.json'
TIMEOUT = 150
LONG_TASK_SECONDS = 90

def save(path, obj):
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + '\n')

def state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}

def proc(pid):
    p = subprocess.run(['ps', '-p', str(pid), '-o', 'pid=,ppid=,pgid=,lstart=,stat=,command='], capture_output=True, text=True)
    return p.stdout.strip()

def alive(pid):
    text = proc(pid)
    return bool(text) and ' Z ' not in text

def process_tree(root_pid):
    output = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,lstart=,stat=,command='], capture_output=True, text=True).stdout
    rows = {}
    for line in output.splitlines():
        parts = line.split(None, 9)
        if len(parts) == 10:
            rows[int(parts[0])] = {'pid': int(parts[0]), 'ppid': int(parts[1]), 'pgid': int(parts[2]), 'started': ' '.join(parts[3:8]), 'stat': parts[8], 'command': parts[9]}
    included = {root_pid}
    while True:
        more = {pid for pid, row in rows.items() if row['ppid'] in included} - included
        if not more: break
        included.update(more)
    return [rows[pid] for pid in sorted(included) if pid in rows]

def same_process(row):
    parts = proc(row['pid']).split(None, 9)
    return len(parts) == 10 and ' '.join(parts[3:8]) == row['started'] and parts[9] == row['command'] and not parts[8].startswith('Z')

def configure(deny):
    (WS / '.cursor').mkdir(exist_ok=True)
    config = {'permissions': {'allow': ['Read(**)'], 'deny': ['Write(**)', 'Shell(*)'] if deny else []}}
    save(WS / '.cursor' / 'cli.json', config)
    return config

def run_case(name, prompt, resume=None, cancel=False, timeout=None, cancel_path=None, cancel_strategy='cli_group_then_cleanup'):
    timeout = timeout or TIMEOUT
    cancel_path = cancel_path or WS
    args = [CLI, '--print', '--output-format', 'stream-json', '--workspace', str(WS), '--trust', '--force']
    if resume:
        args += ['--resume', resume]
    args += [prompt]
    stdout_path, stderr_path = LOGS / (name + '.stdout.ndjson'), LOGS / (name + '.stderr.txt')
    manifest = {'case': name, 'argv': args, 'cwd': str(WS), 'start_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'timeout_seconds': timeout, 'permission_config': json.loads((WS / '.cursor' / 'cli.json').read_text()), 'default_model': True, 'cancel_actions': []}
    manifest['cli_version_before'] = subprocess.run([CLI, '--version'], capture_output=True, text=True).stdout.strip()
    manifest['cancel_strategy'] = cancel_strategy if cancel else None
    manifest['marker_directory'] = str(cancel_path) if cancel else None
    manifest['long_task_seconds'] = LONG_TASK_SECONDS if cancel else None
    save(LOGS / (name + '.manifest.json'), manifest)
    t = time.monotonic()
    cancelled = False
    tool_pid = None
    owned_processes = []
    observed_registry = {}
    last_tree_sample = 0
    with stdout_path.open('wb') as out, stderr_path.open('wb') as err:
        p = subprocess.Popen(args, cwd=str(WS), stdout=out, stderr=err, stdin=subprocess.DEVNULL, start_new_session=True)
        manifest['pid'] = p.pid
        manifest['pgid'] = os.getpgid(p.pid)
        manifest['process_identity'] = proc(p.pid)
        while p.poll() is None and time.monotonic() - t < timeout:
            if time.monotonic() - last_tree_sample >= .5:
                for row in process_tree(p.pid):
                    observed_registry[(row['pid'],row['started'],row['command'])] = row
                last_tree_sample = time.monotonic()
            marker = cancel_path / 'long-task.pid'
            if cancel and marker.exists() and not cancelled:
                tool_pid = int(marker.read_text().strip())
                manifest['tool_pid'] = tool_pid
                manifest['tool_process_before_cancel'] = proc(tool_pid)
                time.sleep(1.5)
                for row in process_tree(p.pid):
                    observed_registry[(row['pid'],row['started'],row['command'])] = row
                owned_processes = [row for row in observed_registry.values() if same_process(row)]
                manifest['owned_processes_before_cancel'] = owned_processes
                manifest['heartbeat_before_cancel'] = (cancel_path / 'heartbeat.txt').read_text() if (cancel_path / 'heartbeat.txt').exists() else None
                manifest['tool_detected_at_seconds'] = round(time.monotonic() - t - 1.5, 3)
                for sig, grace in [(signal.SIGINT, 5), (signal.SIGTERM, 3), (signal.SIGKILL, 1)]:
                    if p.poll() is not None and not alive(tool_pid) and not any(same_process(row) for row in owned_processes):
                        break
                    if cancel_strategy == 'verified_identity_tree':
                        for row in reversed(owned_processes):
                            if same_process(row):
                                try:
                                    os.kill(row['pid'], sig)
                                    manifest['cancel_actions'].append({'signal': sig.name, 'target': 'owned_identity_tree', 'pid': row['pid'], 'at_seconds': round(time.monotonic() - t, 3)})
                                except ProcessLookupError:
                                    pass
                    else:
                        try:
                            os.killpg(p.pid, sig)
                            manifest['cancel_actions'].append({'signal': sig.name, 'target': 'owned_process_group', 'at_seconds': round(time.monotonic() - t, 3)})
                        except ProcessLookupError:
                            pass
                    until = time.monotonic() + grace
                    while time.monotonic() < until and (p.poll() is None or alive(tool_pid)):
                        time.sleep(.2)
                    if manifest['cancel_actions']:
                        manifest['cancel_actions'][-1]['cli_running_after_grace'] = p.poll() is None
                        manifest['cancel_actions'][-1]['tool_running_after_grace'] = alive(tool_pid)
                cancelled = True
                break
            time.sleep(.1)
        if p.poll() is None:
            manifest['timed_out'] = not cancelled
            for row in process_tree(p.pid):
                observed_registry[(row['pid'],row['started'],row['command'])] = row
            for row in reversed(list(observed_registry.values())):
                if same_process(row):
                    try:
                        os.kill(row['pid'], signal.SIGTERM)
                        manifest['cancel_actions'].append({'signal': 'SIGTERM', 'target': 'owned_identity_timeout_cleanup', 'pid': row['pid']})
                    except ProcessLookupError:
                        pass
            for sig in [signal.SIGTERM, signal.SIGKILL]:
                try:
                    os.killpg(p.pid, sig)
                    manifest['cancel_actions'].append({'signal': sig.name, 'target': 'owned_process_group_cleanup'})
                except ProcessLookupError:
                    pass
                try:
                    p.wait(timeout=3)
                    break
                except subprocess.TimeoutExpired:
                    pass
        manifest['exit_code'] = p.wait()
        if tool_pid is not None:
            manifest['tool_process_after_group_cancel'] = proc(tool_pid)
            manifest['owned_processes_alive_after_primary_cancel'] = [row for row in owned_processes if same_process(row)]
            # Clean only the recorded owned script if a tool escaped the CLI group.
            identity = proc(tool_pid)
            if identity and str(cancel_path / 'long_task.py') in identity and alive(tool_pid):
                for sig in [signal.SIGTERM, signal.SIGKILL]:
                    if not alive(tool_pid):
                        break
                    os.kill(tool_pid, sig)
                    manifest['cancel_actions'].append({'signal': sig.name, 'target': 'exact_owned_tool_pid_cleanup', 'pid': tool_pid})
                    time.sleep(.5)
            manifest['tool_process_after_cleanup'] = proc(tool_pid)
            manifest['owned_processes_alive_after_exact_tool_cleanup'] = [row for row in owned_processes if same_process(row)]
            for row in reversed(owned_processes):
                if same_process(row):
                    os.kill(row['pid'], signal.SIGTERM)
                    manifest['cancel_actions'].append({'signal': 'SIGTERM', 'target': 'exact_owned_descendant_cleanup', 'pid': row['pid']})
            time.sleep(.5)
            for row in reversed(owned_processes):
                if same_process(row):
                    os.kill(row['pid'], signal.SIGKILL)
                    manifest['cancel_actions'].append({'signal': 'SIGKILL', 'target': 'exact_owned_descendant_cleanup', 'pid': row['pid']})
            time.sleep(.2)
            manifest['owned_processes_alive_after_cleanup'] = [row for row in owned_processes if same_process(row)]
            manifest['completion_exists'] = (cancel_path / 'completed.txt').exists()
            manifest['heartbeat_after_cleanup'] = (cancel_path / 'heartbeat.txt').read_text() if (cancel_path / 'heartbeat.txt').exists() else None
            time.sleep(1)
            manifest['heartbeat_stable_after_cleanup'] = manifest['heartbeat_after_cleanup'] == ((cancel_path / 'heartbeat.txt').read_text() if (cancel_path / 'heartbeat.txt').exists() else None)
        manifest['observed_processes'] = list(observed_registry.values())
        manifest['survivors_before_postrun_cleanup'] = [row for row in observed_registry.values() if same_process(row)]
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            survivors = [row for row in observed_registry.values() if same_process(row)]
            if not survivors: break
            for row in reversed(survivors):
                try:
                    os.kill(row['pid'], sig)
                    manifest['cancel_actions'].append({'signal': sig.name, 'target': 'owned_identity_postrun_cleanup', 'pid': row['pid']})
                except ProcessLookupError:
                    pass
            time.sleep(.5)
        manifest['survivors_after_postrun_cleanup'] = [row for row in observed_registry.values() if same_process(row)]
    manifest['duration_seconds'] = round(time.monotonic() - t, 3)
    manifest['cli_version_after'] = subprocess.run([CLI, '--version'], capture_output=True, text=True).stdout.strip()
    events, bad_lines = [], []
    for line in stdout_path.read_text(errors='replace').splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            bad_lines.append(line)
    session_ids = list(dict.fromkeys(e['session_id'] for e in events if e.get('session_id')))
    results = [e for e in events if e.get('type') == 'result']
    summary = {'case': name, 'exit_code': manifest['exit_code'], 'duration_seconds': manifest['duration_seconds'], 'event_count': len(events), 'event_types': list(dict.fromkeys((e.get('type','') + ':' + e.get('subtype','')) for e in events)), 'session_ids': session_ids, 'invalid_json_lines': len(bad_lines), 'result_events': results, 'stderr_bytes': stderr_path.stat().st_size, 'timed_out': manifest.get('timed_out', False), 'cancellation_triggered': cancelled, 'tool_calls': [e for e in events if e.get('type') == 'tool_call']}
    save(LOGS / (name + '.manifest.json'), manifest)
    save(LOGS / (name + '.summary.json'), summary)
    print(json.dumps({k: v for k, v in summary.items() if k not in ['tool_calls', 'result_events']}, ensure_ascii=False), flush=True)
    return summary

def main():
    global ROOT, WS, LOGS, STATE, CLI, TIMEOUT, LONG_TASK_SECONDS
    ap = argparse.ArgumentParser()
    ap.add_argument('case', choices=['baseline','resume','deny','write','cancel','cancel_resume','cancel_tree','observe'])
    ap.add_argument('--root', '--output-dir', dest='output_dir', type=pathlib.Path, required=True, help='Fresh disposable suite root; reuse only for this suite\'s explicit follow-up cases.')
    ap.add_argument('--cli', default=CLI)
    ap.add_argument('--timeout', type=int, default=150)
    ap.add_argument('--long-task-seconds', type=int, default=90)
    args = ap.parse_args()
    case, ROOT, CLI, TIMEOUT, LONG_TASK_SECONDS = args.case, args.output_dir.resolve(), args.cli, args.timeout, args.long_task_seconds
    WS, LOGS, STATE = ROOT / 'workspace', ROOT / 'logs', ROOT / 'state.json'
    ROOT.mkdir(parents=True, exist_ok=True)
    ownership = ROOT / '.preflight-owned.json'
    if case == 'baseline':
        if STATE.exists() or ownership.exists() or (WS.exists() and any(WS.iterdir())):
            raise SystemExit('baseline requires a fresh root; refusing to overwrite an existing workspace or resume an existing session')
        save(ownership, {'kind': 'cursor-disposable-preflight-v1', 'workspace': str(WS), 'created_utc': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    elif case != 'observe':
        if not ownership.exists() or json.loads(ownership.read_text()).get('workspace') != str(WS):
            raise SystemExit('follow-up requires a disposable root initialized by this harness baseline')
    WS.mkdir(exist_ok=True); LOGS.mkdir(exist_ok=True)
    if case == 'observe':
        for name in ['cancel', 'cancel_tree']:
            path = LOGS / (name + '.manifest.json')
            if not path.exists(): continue
            m = json.loads(path.read_text())
            cp = pathlib.Path(m.get('marker_directory') or str(WS if name == 'cancel' else WS / 'cancel_tree_fixture'))
            now = datetime.datetime.now(datetime.timezone.utc)
            elapsed = (now - datetime.datetime.fromisoformat(m['start_utc'])).total_seconds() - m['cancel_actions'][0]['at_seconds']
            duration = m.get('long_task_seconds') or 90
            obs = {'case': name, 'observed_utc': now.isoformat(), 'seconds_since_first_cancel_signal': elapsed, 'natural_task_seconds': duration, 'past_natural_completion_window': elapsed > duration, 'completion_exists': (cp / 'completed.txt').exists(), 'heartbeat': (cp / 'heartbeat.txt').read_text() if (cp / 'heartbeat.txt').exists() else None, 'owned_processes_still_alive': [row for row in m.get('owned_processes_before_cancel',[]) if same_process(row)]}
            save(LOGS / (name + '.delayed-observation.json'), obs)
            print(json.dumps(obs, ensure_ascii=False))
        return
    s = state()
    boundary = 'This is an authorized integration test in a disposable workspace. Do not read or modify anything outside the current workspace; do not inspect credentials. '
    if case == 'baseline':
        configure(False)
        (WS / 'read-control.txt').write_text('READ_CONTROL_49f28d\n')
        nonce = 'CURSOR_MEMORY_' + secrets.token_hex(12)
        s['nonce'] = nonce
        prompt = boundary + 'Read read-control.txt with a file tool and run pwd with the shell tool to report your actual working directory. Remember this exact memory token for the next turn: ' + nonce + '. Do not write it into any file or command. Reply with the read-control value, actual cwd, and the token.'
        r = run_case(case, prompt)
        if r['session_ids']: s['session_id'] = r['session_ids'][-1]
    elif case == 'resume':
        configure(False)
        r = run_case(case, boundary + 'Without reading files or using tools, recall and print the exact memory token from our previous turn. Reply with the token only.', resume=s['session_id'])
        r['nonce_recalled'] = any(s['nonce'] in e.get('result','') for e in r['result_events'])
        save(LOGS / (case + '.summary.json'), r)
        print(json.dumps({'nonce_recalled': r['nonce_recalled']}), flush=True)
    elif case == 'deny':
        configure(True)
        (WS / 'protected.txt').write_text('ORIGINAL_PROTECTED_CONTENT\n')
        (WS / 'denied-shell-marker.txt').unlink(missing_ok=True)
        (WS / 'denied_shell.py').write_text("from pathlib import Path\nPath('denied-shell-marker.txt').write_text('SHELL_EXECUTED')\n")
        prompt = boundary + 'This run tests enforcement of explicit project permission deny rules, including when --force is enabled. First read read-control.txt. Then attempt a direct file-edit tool to replace protected.txt with CHANGED_BY_TOOL. Also attempt the shell command python3 denied_shell.py. These harmless attempts must be rejected by the configured permissions. Do not bypass a denial through another tool. Report actual tool approval/denial responses, distinguishing refused attempts from your own decision not to call a tool.'
        r = run_case(case, prompt)
        r['protected_unchanged'] = (WS / 'protected.txt').read_text() == 'ORIGINAL_PROTECTED_CONTENT\n'
        r['denied_shell_marker_exists'] = (WS / 'denied-shell-marker.txt').exists()
        save(LOGS / (case + '.summary.json'), r)
    elif case == 'write':
        configure(False)
        (WS / 'allowed.txt').write_text('BEFORE_ALLOWED_EDIT\n')
        r = run_case(case, boundary + 'Use a file edit/write tool to replace allowed.txt with exactly AFTER_ALLOWED_EDIT followed by a newline. Then use a read tool to verify its exact contents and report success. Do not touch any other file.')
        r['allowed_write_verified'] = (WS / 'allowed.txt').read_text() == 'AFTER_ALLOWED_EDIT\n'
        save(LOGS / (case + '.summary.json'), r)
    elif case in ['cancel', 'cancel_tree']:
        configure(False)
        cp = WS if case == 'cancel' else WS / 'cancel_tree_fixture'
        cp.mkdir(exist_ok=True)
        for name in ['long-task.pid','heartbeat.txt','completed.txt']:
            (cp / name).unlink(missing_ok=True)
        script = "import os,time\nfrom pathlib import Path\np=Path(__file__).resolve().parent\n(p/'long-task.pid').write_text(str(os.getpid()))\nfor i in range(" + str(LONG_TASK_SECONDS) + "):\n (p/'heartbeat.txt').write_text(str(i))\n time.sleep(1)\n(p/'completed.txt').write_text('FINISHED_ALL_SECONDS')\n"
        (cp / 'long_task.py').write_text(script)
        prompt = boundary + 'Run the shell command python3 ' + str(cp / 'long_task.py') + ' in the foreground, wait for its normal completion, then read ' + str(cp / 'completed.txt') + ' and report it. Do not background the command, do not change the script, and do not write any marker files yourself. The supervisor may interrupt this test.'
        r = run_case(case, prompt, cancel=True, cancel_path=cp, cancel_strategy='verified_identity_tree' if case == 'cancel_tree' else 'cli_group_then_cleanup')
        if r['session_ids']: s[case + '_session_id'] = r['session_ids'][-1]
    else:
        configure(False)
        resume_id = s.get('cancel_tree_session_id') or s.get('cancel_session_id')
        if not resume_id:
            raise SystemExit('cancel_resume requires this suite\'s completed cancel_tree or cancel case')
        r = run_case(case, boundary + 'The previous turn was intentionally cancelled by the integration-test supervisor. Do not restart any command or use any tools. Answer exactly CANCEL_RECOVERY_OK.', resume=resume_id)
        r['cancel_resume_replied'] = any('CANCEL_RECOVERY_OK' in e.get('result','') for e in r['result_events'])
        save(LOGS / (case + '.summary.json'), r)
    save(STATE, s)

if __name__ == '__main__': main()
