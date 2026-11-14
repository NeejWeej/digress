"""The real server (fake Claude Code): replies outlive their connection, and conversations carry versions.

Replies (server/runs.mjs): a dropped connection doesn't stop the model; the page reconnects from the line it
had and gets the rest; a reply that finishes with no page connected is written into its conversation; one
nobody comes back to is stopped and saved as cut off; Stop stops it.
Versions: a save says which version it started from; a stale one gets 409 with the current copy, one for a
deleted conversation 410. Per-device layouts, and uploaded files nothing uses any more are removed.
Asserts and exits non-zero."""
import http.client, json, os, shutil, sys, tempfile, time
sys.path.insert(0, os.path.dirname(__file__))
from test_server import start, req, check, FAKES, wait_until

def stream(base, method, path, body=None, take=None):
    """-> (connection, response, lines read). take: stop after that many lines (the connection stays open)."""
    c = http.client.HTTPConnection(base.split('//')[1], timeout=30)
    c.request(method, path, json.dumps(body) if body is not None else None, {'content-type': 'application/json'})
    r = c.getresponse(); lines = []
    while take is None or len(lines) < take:
        l = r.readline()
        if not l: break
        o = json.loads(l)
        if not o.get('hb'): lines.append(o)
    return c, r, lines

tmp = tempfile.mkdtemp(); log = os.path.join(tmp, 'claude.log'); data = os.path.join(tmp, 'data')
proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': data, 'FAKE_LOG': log,
                    'RUN_DETACH_MS': '4000', 'RUN_HEARTBEAT_MS': '500'})
killed = lambda: open(log).read().count('KILLED') if os.path.exists(log) else 0
try:
    ask = lambda q, **kw: {'messages': [{'role': 'user', 'content': q}], **kw}
    # reconnecting: the model kept going while nobody was connected
    c, r, first = stream(base, 'POST', '/api/chat', ask('SLOWISH', chat='1' * 32), take=3); c.close(); time.sleep(0.8)   # deliberate: a while with nobody connected
    c, r, rest = stream(base, 'GET', '/api/chat/run/' + '1' * 32 + '?from=3'); c.close()
    text = ''.join(l.get('d', '') for l in first + rest)
    check(text == 'tick ' * 30 and rest[-1].get('done'), f'a dropped connection reconnects from the line it had and gets the rest ({len(text)} chars)')
    check(killed() == 0, '…and the model wasn’t stopped meanwhile')
    c, r, again = stream(base, 'GET', '/api/chat/run/' + '1' * 32 + '?from=0'); c.close()
    check(''.join(l.get('d', '') for l in again) == 'tick ' * 30, 'a finished reply can still be fetched again (a page that reloaded)')
    check(req(base, 'GET', '/api/chat/run/' + 'f' * 32)[0] == 404, 'an unknown reply: 404')

    # finished with no page connected: written into its conversation
    conv = lambda msgs: {'id': 'c9', 'title': 'T', 'threads': {'main': {'id': 'main'}}, 'order': {'main': list(msgs)}, 'msgs': msgs}
    st, b = req(base, 'PUT', '/api/store/convs/c9', conv({'q1': {'id': 'q1', 'role': 'user', 'thread': 'main', 'content': 'hi'},
                                                          'a1': {'id': 'a1', 'role': 'assistant', 'thread': 'main', 'content': '', 'run': '2' * 32}}))
    rev0 = json.loads(b)['rev']
    c, r, _ = stream(base, 'POST', '/api/chat', ask('SLOWISH', chat='2' * 32, save={'conv': 'c9', 'msg': 'a1'}), take=1); c.close()
    wait_until(lambda: 'run' not in json.loads(req(base, 'GET', '/api/store/convs/c9')[1])['msgs']['a1'], timeout=15)   # the server wrote it in
    d = json.loads(req(base, 'GET', '/api/store/convs/c9')[1])
    check(d['msgs']['a1']['content'] == 'tick ' * 30 and 'run' not in d['msgs']['a1'] and d['msgs']['a1'].get('model'), f'a reply that finished with no page connected is saved into its message {d["msgs"]["a1"]}')
    check(d['rev'] == rev0 + 1, '…as a new version, so open tabs catch up')

    # nobody comes back: stopped after RUN_DETACH_MS, saved as cut off
    d['msgs']['a2'] = {'id': 'a2', 'role': 'assistant', 'thread': 'main', 'content': '', 'run': '3' * 32}; d['order']['main'].append('a2')
    req(base, 'PUT', '/api/store/convs/c9', d)
    k0 = killed()
    c, r, _ = stream(base, 'POST', '/api/chat', ask('SLOW', chat='3' * 32, save={'conv': 'c9', 'msg': 'a2'}), take=2); c.close()
    wait_until(lambda: killed() > k0 and 'run' not in json.loads(req(base, 'GET', '/api/store/convs/c9')[1])['msgs']['a2'], timeout=20)   # stopped after RUN_DETACH_MS (4 s) and saved
    d = json.loads(req(base, 'GET', '/api/store/convs/c9')[1]); a2 = d['msgs']['a2']
    check(killed() == k0 + 1, 'a reply nobody came back to is stopped')
    check(a2.get('cut') and a2.get('error') and a2['content'].startswith('tick') and 'run' not in a2, f'…and saved as cut off, with what it had written {a2}')

    # Stop
    c, r, _ = stream(base, 'POST', '/api/chat', ask('SLOW', chat='4' * 32), take=1)
    k0 = killed(); req(base, 'POST', '/api/chat/stop', {'chat': '4' * 32})
    rest = r.read(); c.close(); wait_until(lambda: killed() > k0)
    check(killed() == k0 + 1, 'Stop stops the model, and the stream ends')

    # heartbeats keep a quiet stream alive and are told apart from content
    c = http.client.HTTPConnection(base.split('//')[1], timeout=30)
    c.request('POST', '/api/chat', json.dumps(ask('SLOWISH', chat='5' * 32)), {'content-type': 'application/json'})
    raw = c.getresponse().read().decode(); c.close()
    check('{"hb":1}' in raw and ''.join(json.loads(l).get('d', '') for l in raw.splitlines()) == 'tick ' * 30, 'heartbeats come between the lines')

    # versions
    st, b = req(base, 'PUT', '/api/store/convs/v1', {'title': 'A'}); r1 = json.loads(b)['rev']
    st, b = req(base, 'PUT', '/api/store/convs/v1', {'title': 'B'}, headers={'x-base-rev': str(r1)})
    check(st == 200 and json.loads(b)['rev'] == r1 + 1, 'a save from the current version goes through')
    st, b = req(base, 'PUT', '/api/store/convs/v1', {'title': 'C'}, headers={'x-base-rev': str(r1)})
    check(st == 409 and json.loads(b)['current']['title'] == 'B', 'a save from an older version gets 409 with the current copy')
    check(json.loads(req(base, 'GET', '/api/store/convs/v1?rev=1')[1]) == {'rev': r1 + 1}, 'GET ?rev: just the version')
    req(base, 'PATCH', '/api/store/convs/v1', {'pinned': True})
    check(json.loads(req(base, 'GET', '/api/store/convs/v1?rev=1')[1])['rev'] == r1 + 2, 'a PATCH is a new version too')
    req(base, 'DELETE', '/api/store/convs/v1')
    check(req(base, 'PUT', '/api/store/convs/v1', {'title': 'D'}, headers={'x-base-rev': str(r1 + 2)})[0] == 410, 'a save to a conversation deleted elsewhere: 410 (it isn’t brought back)')

    # layouts, per device
    req(base, 'PUT', '/api/store/convs/L1', {'title': 'L'})
    req(base, 'PUT', '/api/layout/L1?device=dA', {'open': ['main'], 'view': 'canvas'}); req(base, 'PUT', '/api/layout/L1?device=dB', {'open': ['main'], 'view': 'panes'})
    devs = json.loads(req(base, 'GET', '/api/layout/L1')[1])['devices']
    check(devs['dA']['ui']['view'] == 'canvas' and devs['dB']['ui']['view'] == 'panes', 'each device keeps its own layout')
    check(json.loads(req(base, 'PUT', '/api/layout/nope?device=dA', {'open': []})[1]) == {'ok': False}, 'no layout for a conversation that isn’t saved')
    req(base, 'DELETE', '/api/store/convs/L1')
    check(json.loads(req(base, 'GET', '/api/layout/L1')[1]) == {'devices': {}}, 'deleting a conversation deletes its layouts')

    # files nothing uses any more go with the conversation (after a while: a page uploads before it saves)
    fid = lambda b: json.loads(b)['id']
    used = fid(req(base, 'POST', '/api/files?type=text/plain', raw=b'used', ctype='text/plain')[1])
    orphan = fid(req(base, 'POST', '/api/files?type=text/plain', raw=b'mine', ctype='text/plain')[1])
    req(base, 'PUT', '/api/store/convs/F1', {'title': 'keep', 'doc': {'kind': 'text', 'assetId': used}})
    req(base, 'PUT', '/api/store/convs/F2', {'title': 'go', 'msgs': {'u': {'images': [{'asset': orphan, 'type': 'text/plain'}]}}})
    req(base, 'DELETE', '/api/store/convs/F2')
    check(req(base, 'GET', '/api/files/' + orphan)[0] == 200, 'a file uploaded minutes ago is left alone')
    for n in os.listdir(os.path.join(data, 'files')):
        if n.endswith('.meta.json'):
            p = os.path.join(data, 'files', n); m = json.load(open(p)); m['created'] -= 3600e3; json.dump(m, open(p, 'w'))
    req(base, 'PUT', '/api/store/convs/F3', {'title': 'x'}); req(base, 'DELETE', '/api/store/convs/F3')
    check(req(base, 'GET', '/api/files/' + orphan)[0] == 404 and req(base, 'GET', '/api/files/' + used)[0] == 200, 'deleting a conversation removes files nothing uses, and keeps the rest')
finally:
    proc.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print('\nall passed')
