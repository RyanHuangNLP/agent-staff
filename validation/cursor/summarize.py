#!/usr/bin/env python3
"""Create a concise machine-readable report from actual preflight artifacts."""
import argparse, datetime, json, pathlib

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--raw-root',required=True,type=pathlib.Path)
    ap.add_argument('--output-dir',required=True,type=pathlib.Path)
    args=ap.parse_args()
    root,out=args.raw_root.resolve(),args.output_dir.resolve()
    logs=root/'logs'
    names=['baseline','resume','deny','write','cancel_tree','cancel_resume']
    data={}
    for name in names:
        data[name]={
            'manifest':json.loads((logs/(name+'.manifest.json')).read_text()),
            'summary':json.loads((logs/(name+'.summary.json')).read_text()),
            'events':[json.loads(line) for line in (logs/(name+'.stdout.ndjson')).read_text().splitlines() if line.strip()]
        }
    def terminal(name): return [e for e in data[name]['events'] if e.get('type')=='result']
    def tools(name): return [e for e in data[name]['events'] if e.get('type')=='tool_call']
    def typed_results(name): return [(k,v['result']) for e in tools(name) if e.get('subtype')=='completed' for k,v in e.get('tool_call',{}).items() if isinstance(v,dict) and 'result' in v]
    def success(name): return data[name]['manifest']['exit_code']==0 and bool(terminal(name)) and terminal(name)[-1].get('subtype')=='success'
    versions=[{'case':name,'before':data[name]['manifest'].get('cli_version_before'),'after':data[name]['manifest'].get('cli_version_after')} for name in names]
    models=sorted({e['model'] for name in names for e in data[name]['events'] if e.get('type')=='system' and e.get('model')})
    baseline_tools=typed_results('baseline')
    deny_tools=typed_results('deny')
    cm=data['cancel_tree']['manifest']
    delayed=json.loads((logs/'cancel_tree.delayed-observation.json').read_text())
    state=json.loads((root/'state.json').read_text())
    checks={
      'baseline_protocol_and_cwd':success('baseline') and any(k=='shellToolCall' and str(root/'workspace') in v.get('success',{}).get('stdout','') for k,v in baseline_tools),
      'exact_resume_nonce':success('resume') and data['resume']['summary'].get('nonce_recalled',False) and not tools('resume') and terminal('resume')[-1]['session_id']==state['session_id'],
      'explicit_write_deny':any('writePermissionDenied' in v for k,v in deny_tools) and data['deny']['summary'].get('protected_unchanged',False),
      'explicit_shell_deny':any(k=='shellToolCall' and 'permissionDenied' in v for k,v in deny_tools) and not data['deny']['summary'].get('denied_shell_marker_exists',True),
      'deny_positive_read_control':any(k=='readToolCall' and 'READ_CONTROL_49f28d' in v.get('success',{}).get('content','') for k,v in deny_tools),
      'allowed_write_verified':success('write') and data['write']['summary'].get('allowed_write_verified',False),
      'complete_identity_tree_cancel':cm.get('exit_code')==130 and not terminal('cancel_tree') and not cm.get('owned_processes_alive_after_primary_cancel') and not cm.get('owned_processes_alive_after_cleanup') and cm.get('heartbeat_stable_after_cleanup') and not cm.get('completion_exists'),
      'cancel_observed_after_natural_deadline':delayed.get('past_natural_completion_window',False) and not delayed.get('completion_exists',True) and not delayed.get('owned_processes_still_alive',True),
      'cancel_resume_without_tool_restart':success('cancel_resume') and data['cancel_resume']['summary'].get('cancel_resume_replied',False) and not tools('cancel_resume') and terminal('cancel_resume')[-1]['session_id']==state['cancel_tree_session_id'],
      'all_observed_owned_processes_cleaned':all(not data[name]['manifest'].get('survivors_after_postrun_cleanup',[]) for name in names),
    }
    assistants=[e for e in data['baseline']['events'] if e.get('type')=='assistant']
    last_assistant=''.join(c.get('text','') for c in assistants[-1].get('message',{}).get('content',[]) if c.get('type')=='text') if assistants else ''
    report={
      'provider':'cursor','status':'verified_current_version' if all(checks.values()) else 'needs_attention',
      'generated_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'raw_evidence_root':str(root),
      'live_call_count':len(names),'default_model_used':True,'observed_models':models,'versions':versions,
      'checks':{key:{'passed':bool(value)} for key,value in checks.items()},
      'protocol':{'format':'stream-json','partial_output_enabled':False,'thinking_events_observed':any(e.get('type')=='thinking' for name in names for e in data[name]['events']),'tool_call_id_embedded_newline_observed':any('\n' in e.get('call_id','') for name in names for e in tools(name)),'aggregate_result_differs_from_last_assistant':bool(terminal('baseline')) and terminal('baseline')[-1]['result']!=last_assistant,'permission_denial_turn_exits_successfully':success('deny')},
      'cancellation':{'strategy':'verified owned PID/start-time/command identities, including descendants in separate process groups','exit_code':cm['exit_code'],'heartbeat_before':cm.get('heartbeat_before_cancel'),'heartbeat_after':cm.get('heartbeat_after_cleanup'),'signal_actions':cm.get('cancel_actions'),'delayed_observation':delayed,'group_only_retested_on_current_version':False},
      'not_verified':['partial-output streaming','ACP runtime protocol','OS sandbox confinement','all possible child-process detachment races','remote task cancellation','general model/task correctness','permission isolation of every web/MCP/plugin tool'],
      'permission_contract':{'single_argv':['--workspace','--resume','--mode ask|plan','--force','--trust','--sandbox enabled|disabled'],'native_config_required':['Read/Write/Shell allow/deny'],'tested_native_project_policy':{'permissions':{'allow':['Read(**)'],'deny':['Write(**)','Shell(*)']}},'do_not_mutate_real_project_policy':True},
      'auto_update':{'official_default':True,'disable_switch_confirmed':False,'historical_child_process_download_observed':True,'recommendation':'Check actual version before and after each run; revalidate on drift. Do not invent disable flags.'},
      'evidence_by_case':{name:{'stdout':'logs/'+name+'.stdout.ndjson','stderr':'logs/'+name+'.stderr.txt','manifest':'logs/'+name+'.manifest.json','summary':'logs/'+name+'.summary.json','exit_code':data[name]['manifest']['exit_code'],'duration_seconds':data[name]['manifest']['duration_seconds']} for name in names},
    }
    out.mkdir(parents=True,exist_ok=True)
    (out/'summary.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps({'status':report['status'],'checks':report['checks']},ensure_ascii=False))

if __name__=='__main__': main()
