"""Google Gemini as a provider, and Connections (the real server, against tests/fakes/fake-gemini.mjs).
  - No key: Gemini is off. A key added in the app is checked with Google first (a bad one is refused), kept in
    data/keys.json readable only by this user (0600), and never comes back: only where it's from and its last 4.
  - With a key: its chat models are listed (not embeddings), replies stream with token counts and the context window,
    effort becomes a thinking level, Web on sends Google Search (its query and sources come through), the key goes
    in the x-goog-api-key header, a rate limit says so plainly. Removing it turns Gemini off; a key set in .env can't
    be removed from the app. Another site can't set a key (the server only answers its own page).
Asserts and exits non-zero."""
import json, os, shutil, stat, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.dirname(__file__))
from test_server import start, req, chat, free_port, FAKES

fails = []
def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what, '' if ok else str(detail)[:300])
    if not ok: fails.append(what)

KEY = 'gemini-test-key-0000000000'

def main():
    tmp = tempfile.mkdtemp(); procs = []
    try:
        gport = free_port(); glog = os.path.join(tmp, 'gemini.log'); open(glog, 'w').close()
        procs.append(subprocess.Popen(['node', os.path.join(FAKES, 'fake-gemini.mjs'), str(gport)], stdout=subprocess.PIPE, env={**os.environ, 'FAKE_LOG': glog}))
        time.sleep(0.5)
        data = os.path.join(tmp, 'data')
        proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': '/nonexistent/claude', 'DATA_DIR': data, 'GEMINI_API_BASE': f'http://127.0.0.1:{gport}/v1beta',
                            'GEMINI_WAIT_MS': '3000', 'GEMINI_RETRY_MS': '200'}); procs.append(proc)
        conns = lambda: {p['id']: p for p in json.loads(req(base, 'GET', '/api/connections')[1])['providers']}
        c = conns()
        check(set(c) == {'claude-code', 'anthropic', 'chatgpt', 'gemini'} and not c['gemini']['on'] and c['gemini']['from'] is None, 'Connections lists the providers; Gemini starts off', c)
        st, body = req(base, 'PUT', '/api/connections/gemini', {'key': 'not-a-real-key-but-long-enough'})
        check(st == 400 and 'rejected' in json.loads(body)['error'], 'a key Google rejects is refused, and says so', [st, body])
        check(not os.path.exists(os.path.join(data, 'keys.json')), '…and nothing is kept')
        st, body = req(base, 'PUT', '/api/connections/gemini', {'key': 'has spaces in it so no good'})
        check(st == 400, 'something that isn’t a key is refused before asking Google', st)
        st, body = req(base, 'PUT', '/api/connections/gemini', {'key': KEY}, headers={'origin': 'https://evil.example'})
        check(st == 403, 'another site can’t set a key', st)
        st, body = req(base, 'PUT', '/api/connections/gemini', {'key': KEY})
        g = {p['id']: p for p in json.loads(body)['providers']}['gemini'] if st == 200 else {}
        check(st == 200 and g.get('on') and g.get('from') == 'app' and g.get('last4') == '0000', 'a good key turns Gemini on (from the app, last 4 shown)', [st, body])
        check(KEY not in body.decode() and KEY not in req(base, 'GET', '/api/connections')[1].decode(), 'the key never comes back to the page')
        kf = os.path.join(data, 'keys.json')
        check(os.path.exists(kf) and stat.S_IMODE(os.stat(kf).st_mode) == 0o600 and json.load(open(kf)).get('gemini') == KEY, 'it’s kept in data/keys.json, readable only by this user (0600)', oct(stat.S_IMODE(os.stat(kf).st_mode)) if os.path.exists(kf) else 'missing')

        ids = [m[0] for m in json.loads(req(base, 'GET', '/api/models')[1])['models']]
        check('gemini-3.8-flash' in ids and 'gemini-3.5-flash-lite' in ids and not any(x in i for i in ids for x in ('embedding', 'nano-banana', 'omni')), 'its chat models are listed, not embeddings, the image model or Omni', ids)
        st, text, lines = chat(base, {'system': 'Be brief.', 'messages': [{'role': 'user', 'content': 'Hello'}], 'model': 'gemini-3.8-flash', 'effort': 'high', 'web': False})
        done = lines[-1] if lines else {}
        check(st == 200 and text.startswith('gemini reply web=false thinking=high n=1 system=true') and done.get('done'), 'a reply streams from Gemini (system prompt, effort as a thinking level)', [st, text, lines[-1:]])
        u = done.get('usage') or {}
        check(u.get('ctx', 0) > 0 and u.get('out') == 11 and u.get('window') == 1048576, 'with token counts and the context window', u)
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'SEARCHME please'}], 'model': 'gemini-3.8-flash', 'web': True})
        check(any(l.get('search') == 'gemini search' for l in lines) and any(l.get('sources') for l in lines) and 'Searched' in text, 'Web on: Google Search runs, its query and sources come through', lines)
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'SEARCHME please'}], 'model': 'gemini-3.8-flash', 'web': False})
        check('web=false' in text, '…Web off sends no search tool', text)
        # the document tools' schemas, as Google checks them (lists stay lists; nothing it doesn't take)
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'Hello with tools'}], 'model': 'gemini-3.8-flash', 'tools': True})
        last = [json.loads(l) for l in open(glog) if l.strip()][-1]
        decl = {f['name']: f['parameters'] for t in last.get('tools', []) for f in t.get('functionDeclarations', [])}
        check(st == 200 and 'gemini reply' in text and decl.get('search', {}).get('required') == ['query'] and decl.get('read_pages', {}).get('required') == ['from'],
              'the document tools go with schemas Google accepts (required stays a list)', [st, text[:80], decl.get('search')])
        # a model that refuses both a thinking level and search with the tools: both dropped, one after the other
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'Hello old model'}], 'model': 'gemini-old-1', 'effort': 'high', 'web': True, 'tools': True})
        last = [json.loads(l) for l in open(glog) if l.strip()][-1]
        check(st == 200 and 'gemini reply' in text and 'thinkingConfig' not in last.get('generationConfig', {}) and not any('googleSearch' in t for t in last.get('tools', [])),
              'a model that refuses a thinking level and search-with-tools still answers (both dropped)', [st, text[:120], lines[-1:]])
        sent = [json.loads(l) for l in open(glog) if l.strip()]
        check(all(KEY not in json.dumps(s) for s in sent), 'the key isn’t in the request body (it goes in a header)')
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'RATELIMIT'}], 'model': 'gemini-3.8-flash'})
        err = (lines[-1] if lines else {}).get('error', '')
        check('rate limit' in err.lower() and 'free-tier' in err, 'a rate limit says so plainly', err)
        # Google overloaded: a quick "high demand" is tried again; always busy says so plainly; no answer at all ends
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'BUSYONCE'}], 'model': 'gemini-3.8-flash'})
        check(st == 200 and 'gemini reply' in text, 'a quick "high demand" refusal is tried again, and answers', [st, text[:80], lines[-1:]])
        t0 = time.time(); st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'OVERLOAD'}], 'model': 'gemini-3.8-flash'})
        err = (lines[-1] if lines else {}).get('error', '')
        check('busy right now' in err and time.time() - t0 < 5, 'still busy: it says so plainly (after two quick retries)', [err, round(time.time() - t0, 1)])
        t0 = time.time(); st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'HANG'}], 'model': 'gemini-3.8-flash'})
        err = (lines[-1] if lines else {}).get('error', '')
        check('hasn’t answered in 3 seconds' in err and time.time() - t0 < 8, 'no answer at all: it stops after the wait and says so, instead of thinking for minutes', [err, round(time.time() - t0, 1)])
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'FREESEARCH'}], 'model': 'gemini-3.8-flash', 'web': True})
        err = (lines[-1] if lines else {}).get('error', '')
        check('web search isn’t included' in err and 'turn Web off' in err, 'Web on with a free key: the quota error points at web search, not at sending too much', err)
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'FREESEARCH'}], 'model': 'gemini-3.8-flash', 'web': False})
        check(st == 200 and 'gemini reply' in text, '…and with Web off the same question answers', [st, text[:60]])
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'CUTOFF'}], 'model': 'gemini-3.8-flash'})
        check(lines and lines[-1].get('truncated') is True, 'a reply cut at the length limit is marked so', lines[-1:])
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': 'see'}, {'type': 'image', 'mediaType': 'image/png', 'data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='}]}], 'model': 'gemini-3.8-flash'})
        last = [json.loads(l) for l in open(glog) if l.strip()][-1]
        check(any('inlineData' in p for p in last['contents'][0]['parts']), 'images go to Gemini as inline data', last['contents'][0]['parts'])

        st, body = req(base, 'DELETE', '/api/connections/gemini')
        check(st == 200 and not conns()['gemini']['on'] and 'gemini' not in json.load(open(kf)), 'removing the key turns Gemini off and drops it from data/keys.json', [st, body])
        check(not any(m[0].startswith('gemini') for m in json.loads(req(base, 'GET', '/api/models')[1])['models']), '…and its models go')
        proc.terminate()

        # a key in .env: on, from .env, and not removable from the app
        proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': '/nonexistent/claude', 'DATA_DIR': os.path.join(tmp, 'd2'), 'GEMINI_API_BASE': f'http://127.0.0.1:{gport}/v1beta', 'GEMINI_API_KEY': KEY}); procs.append(proc)
        g = conns()['gemini']
        check(g['on'] and g['from'] == 'env' and g['last4'] == '0000', 'a key in .env shows as from .env', g)
        st, body = req(base, 'DELETE', '/api/connections/gemini')
        check(st == 409 and '.env' in json.loads(body)['error'], '…and can’t be removed from the app (it says where to)', [st, body])
    finally:
        for p in procs: p.terminate()
        shutil.rmtree(tmp, ignore_errors=True)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

main()
