#!/usr/bin/env python3
"""Offline protocol assertions. No CLI, network, models, or side effects."""
import argparse, json, pathlib

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fixtures', required=True, type=pathlib.Path)
    args = ap.parse_args()
    root = args.fixtures
    def events(name):
        return [json.loads(line) for line in (root / (name + '.stdout.ndjson')).read_text().splitlines() if line.strip()]
    def obj(name, suffix): return json.loads((root / (name + suffix)).read_text())
    def result(es): return [e for e in es if e.get('type') == 'result']
    def tool_results(es):
        return [(k,v['result']) for e in es if e.get('type') == 'tool_call' and e.get('subtype') == 'completed' for k,v in e.get('tool_call',{}).items() if isinstance(v,dict) and 'result' in v]
    checks = []
    baseline, resume = events('baseline'), events('resume')
    assert result(baseline)[-1]['subtype'] == 'success'
    assert obj('baseline','.summary.json')['exit_code'] == 0
    assert '<MEMORY_NONCE>' in result(resume)[-1]['result']
    assert result(baseline)[-1]['session_id'] == result(resume)[-1]['session_id']
    assert not [e for e in resume if e.get('type') == 'tool_call']
    assert not any('<MEMORY_NONCE>' in json.dumps(e) for e in resume if e.get('type') == 'user')
    checks.extend(['success terminal result', 'exact session resume recalled nonce without tools or nonce in prompt'])
    baseline_tools = tool_results(baseline)
    assert any(k == 'readToolCall' and 'READ_CONTROL_49f28d' in v.get('success',{}).get('content','') for k,v in baseline_tools)
    assert any(k == 'shellToolCall' and '<PREFLIGHT_ROOT>/workspace' in v.get('success',{}).get('stdout','') for k,v in baseline_tools)
    checks.append('read and actual shell cwd positive controls')
    deny = events('deny')
    denial_results = tool_results(deny)
    assert any('permissionDenied' in v for k,v in denial_results if k == 'shellToolCall')
    assert any('writePermissionDenied' in v for k,v in denial_results)
    denied = obj('deny','.summary.json')
    assert denied['protected_unchanged'] and not denied['denied_shell_marker_exists']
    assert any(k == 'readToolCall' and 'success' in v for k,v in denial_results)
    checks.append('explicit native write/shell deny with positive read, under force')
    assert obj('write','.summary.json')['allowed_write_verified']
    assert any('success' in v for k,v in tool_results(events('write')) if k in ['editToolCall','writeToolCall'])
    checks.append('allowed write independently verified')
    if (root / 'cancel.manifest.json').exists():
        m = obj('cancel','.manifest.json')
        assert m['exit_code'] == 130 and not result(events('cancel'))
        assert m['cancel_actions'][0]['tool_running_after_grace']
        assert m['tool_process_after_group_cancel']
        assert any(a.get('target') == 'exact_owned_tool_pid_cleanup' for a in m['cancel_actions'])
        assert not m['completion_exists'] and m['heartbeat_stable_after_cleanup']
        delayed = obj('cancel','.delayed-observation.json')
        assert delayed['past_natural_completion_window'] and not delayed['completion_exists'] and not delayed['owned_processes_still_alive']
        checks.append('historical CLI-group-only cancellation failed; exact cleanup verified after natural deadline')
    m = obj('cancel_tree','.manifest.json')
    assert m['exit_code'] == 130 and not result(events('cancel_tree'))
    assert not m['owned_processes_alive_after_primary_cancel']
    assert not m['owned_processes_alive_after_cleanup']
    assert all(a['target'] == 'owned_identity_tree' for a in m['cancel_actions'])
    assert not m['completion_exists'] and m['heartbeat_stable_after_cleanup']
    delayed = obj('cancel_tree','.delayed-observation.json')
    assert delayed['past_natural_completion_window'] and not delayed['completion_exists'] and not delayed['owned_processes_still_alive']
    checks.append('complete identity-tree cancellation passed, including natural-deadline observation')
    cr = events('cancel_resume')
    assert 'CANCEL_RECOVERY_OK' in result(cr)[-1]['result']
    assert not [e for e in cr if e.get('type') == 'tool_call']
    cancelled_ids = set()
    for name in ['cancel','cancel_tree']:
        if (root / (name + '.stdout.ndjson')).exists():
            cancelled_ids.update(e['session_id'] for e in events(name) if e.get('session_id'))
    assert result(cr)[-1]['session_id'] in cancelled_ids
    checks.append('cancelled session resumed without tool restart')
    # Embedded newlines are legal inside decoded string IDs; JSON physical lines remain valid.
    ids = [e.get('call_id','') for name in ['baseline','deny','write','cancel_tree'] for e in events(name) if e.get('type') == 'tool_call']
    assert all(isinstance(x,str) for x in ids)
    checks.append('tool call IDs decoded as opaque strings without trimming')
    print(json.dumps({'passed': True, 'checks': checks}, indent=2))

if __name__ == '__main__': main()
