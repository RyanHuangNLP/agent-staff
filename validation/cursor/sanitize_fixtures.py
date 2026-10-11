#!/usr/bin/env python3
"""Build sanitized protocol fixtures from a disposable Cursor preflight suite."""
import argparse, hashlib, json, pathlib

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw-root', required=True, type=pathlib.Path)
    ap.add_argument('--output-dir', required=True, type=pathlib.Path)
    ap.add_argument('--label', required=True)
    args = ap.parse_args()
    root, out = args.raw_root.resolve(), args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    state = json.loads((root / 'state.json').read_text())
    sessions = {}
    for key, val in state.items():
        if key.endswith('session_id') and val not in sessions:
            sessions[val] = 'SESSION_' + str(len(sessions) + 1)
    for stream in sorted((root / 'logs').glob('*.stdout.ndjson')):
        for line in stream.read_text().splitlines():
            event = json.loads(line)
            val = event.get('session_id')
            if val and val not in sessions: sessions[val] = 'SESSION_' + str(len(sessions) + 1)
    nonce = state.get('nonce','')
    def clean(value):
        if isinstance(value, dict):
            # Keep event type/subtype but do not publish model thinking payload.
            if value.get('type') == 'thinking':
                return {k: clean(v) for k,v in value.items() if k not in ['text','message','content']}
            return {k: clean(v) for k,v in value.items()}
        if isinstance(value, list): return [clean(v) for v in value]
        if isinstance(value, str):
            value = value.replace(str(root), '<PREFLIGHT_ROOT>').replace(str(pathlib.Path.home()), '<USER_HOME>')
            if nonce: value = value.replace(nonce, '<MEMORY_NONCE>')
            for src, dest in sessions.items(): value = value.replace(src, dest)
            return value
        return value
    index = {'label': args.label, 'source_root': str(root), 'transformations': ['replace preflight root path', 'replace user home path', 'replace generated nonce and session IDs consistently', 'omit thinking payload while preserving type/subtype', 'preserve call_id exactly, including embedded newline', 'retain automatic-update process evidence in manifests'], 'files': []}
    for path in sorted((root / 'logs').iterdir()):
        if path.suffix not in ['.json','.ndjson','.txt']: continue
        dest = out / path.name
        if path.suffix == '.ndjson':
            lines = path.read_text().splitlines()
            values = [clean(json.loads(line)) for line in lines if line.strip()]
            dest.write_text(''.join(json.dumps(v,ensure_ascii=False) + '\n' for v in values))
        elif path.suffix == '.json':
            dest.write_text(json.dumps(clean(json.loads(path.read_text())),indent=2,ensure_ascii=False)+'\n')
        else:
            dest.write_text(clean(path.read_text()))
        index['files'].append({'fixture': dest.name, 'source': str(path), 'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'fixture_sha256': hashlib.sha256(dest.read_bytes()).hexdigest()})
    (out / 'index.json').write_text(json.dumps(index,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps({'label': args.label, 'file_count': len(index['files']), 'output_dir': str(out)}))

if __name__ == '__main__': main()
