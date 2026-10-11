"""Read-only classifier of sanitized, manually normalized evidence (not CLI JSON).
Input JSON: applicable/enabled/hooks_discovered/hooks_trusted/fresh_lifecycle
are booleans; caller_id/session_id/worktree/expected_worktree are strings;
resolution is caller-env/ancestry/other; state is active/ended; source is
live/historical/unknown; commit/checkpoint_commit are exact SHAs;
checkpoint_id/checkpoint_session/local_sha/remote_sha are strings;
usage is a nonnegative numeric value or null; dirty/diverged are booleans.
Only populate facts independently verified; omit unavailable facts.
No collection, subprocesses, transcript access, network or writes. Max input 16 KiB.
"""
import json
import sys
import re


def classify(e):
    if e.get('applicable') is not True:
        return {'scope': 'excluded', 'live_capture': 'not evaluated'}
    live = (all(e.get(k) is True for k in
                ('enabled', 'hooks_discovered', 'hooks_trusted', 'fresh_lifecycle'))
            and e.get('resolution') in ('caller-env', 'ancestry')
            and bool(e.get('caller_id')) and e.get('caller_id') == e.get('session_id')
            and bool(e.get('worktree')) and e.get('worktree') == e.get('expected_worktree')
            and e.get('source') == 'live' and e.get('state') == 'active')
    sha = lambda value: isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', value) is not None
    linked = (bool(e.get('checkpoint_id')) and sha(e.get('local_sha'))
              and sha(e.get('commit')) and e.get('commit') == e.get('checkpoint_commit')
              and bool(e.get('session_id')) and e.get('session_id') == e.get('checkpoint_session'))
    usage = e.get('usage')
    usage_known = type(usage) in (int, float) and usage >= 0
    return {'scope': 'applicable',
            'live_capture': 'verified from supplied evidence' if live else 'unverified',
            'history': 'historical' if e.get('source') == 'historical' else 'not established as historical',
            'local_linkage': 'verified from supplied evidence' if linked else 'unverified',
            'remote_sync': ('matching exact SHA from supplied evidence' if linked and e.get('remote_sha') == e.get('local_sha')
                            else 'unverified'),
            'usage': usage if usage_known else 'unavailable',
            'checkout': {'dirty': e.get('dirty') if type(e.get('dirty')) is bool else 'unknown', 'diverged': e.get('diverged') if type(e.get('diverged')) is bool else 'unknown'},
            'dashboard_ingestion': 'separate observation required'}


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError('provide one sanitized JSON evidence file')
        with open(sys.argv[1], 'rb') as f:
            data = f.read(16385)
        if len(data) > 16384:
            raise ValueError('input exceeds 16 KiB')
        evidence = json.loads(data)
        if not isinstance(evidence, dict):
            raise ValueError('input must be an object')
        # No arbitrary values or private input bytes are echoed on failures.
        result = classify(evidence)
        output = json.dumps(result, allow_nan=False)
        if len(output) > 2048:
            raise ValueError('normalized result exceeds output bound')
        print(output)
    except (OSError, ValueError, TypeError):
        print('Invalid or unreadable sanitized evidence; no result.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
