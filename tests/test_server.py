"""End-to-end test of the self-hosted server, using fake stand-ins for Claude Code and the Anthropic API.

Starts server/server.mjs twice (once per model provider), checks the HTTP API directly,
then drives the real app in a browser against it. Exits non-zero on the first failure.
"""
import asyncio, json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error, http.client
from playwright.async_api import async_playwright
from common import ROOT, REPO, FIX, OUT, launch_args

FAKES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fakes')
SERVER = os.path.join(REPO, 'server', 'server.mjs')
CDN = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
passed = 0


def check(cond, what):
    global passed
    if not cond:
        print('FAIL:', what); sys.exit(1)
    passed += 1
    print('ok  ', what)


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def start(env_extra):
    port = free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'LLM_', 'CLAUDE_BIN'))}
    env.update({'PORT': str(port), 'HOST': '127.0.0.1'}, **env_extra)
    proc = subprocess.Popen(['node', SERVER], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(100):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=1); break
        except Exception:
            time.sleep(0.1)
    return proc, f'http://127.0.0.1:{port}'


def req(base, method, path, body=None, raw=None, ctype='application/json'):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(base + path, data=data, method=method, headers={'content-type': ctype})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def chat(base, payload):
    st, body = req(base, 'POST', '/api/chat', payload)
    lines = [json.loads(l) for l in body.decode().splitlines() if l.strip()] if st == 200 else [json.loads(body)]
    text = ''.join(l.get('d', '') for l in lines)
    return st, text, lines


async def browser_checks(base, data_dir):
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        errs = []

        async def page():
            ctx = await b.new_context(viewport={'width': 1400, 'height': 900})
            pg = await ctx.new_page()
            pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
            async def route(r):
                u = r.request.url
                for k, v in CDN.items():
                    if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
                if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                await r.continue_()
            await pg.route('**/*', route)
            await pg.goto(base + '/'); await pg.wait_for_timeout(1500)
            return pg

        pg = await page()
        check(await pg.title() == 'Digress', 'app served with the Digress title')
        opts = await pg.evaluate("[...document.querySelectorAll('#mSel option')].map(o=>o.value)")
        check('claude-opus-5-5' in opts and 'auto' in opts, f'model picker lists Claude Code models {opts}')
        await pg.select_option('#mSel', 'claude-opus-5-5')
        ta = pg.locator('.pane[data-tid="main"] textarea')
        await ta.fill('What is the gradient of x squared?'); await ta.press('Enter')
        await pg.wait_for_selector('.pane[data-tid="main"] .msg.assistant mjx-container', timeout=15000)
        body = await pg.locator('.pane[data-tid="main"] .msg.assistant .body').first.text_content()
        check('model=claude-opus-5-5' in body, 'reply streamed into the app with the chosen model')
        await pg.wait_for_timeout(1200)
        title = await pg.locator('#cTitle').text_content()
        await pg.screenshot(path=OUT + '/server_chat.png')

        # web toggle: off by default, on for a reply shows where it searched, and it sticks
        check(await pg.locator('#webT').is_visible() and await pg.get_attribute('#webT', 'aria-pressed') == 'false', 'web toggle shown, off by default')
        await pg.locator('#webT').click()
        check(await pg.get_attribute('#webT', 'aria-pressed') == 'true', 'web toggle turns on')
        await ta.fill('SEARCHME what is new?'); await ta.press('Enter')
        await pg.wait_for_selector('.pane[data-tid="main"] .msg.assistant .wsrc', timeout=15000)
        ws = pg.locator('.pane[data-tid="main"] .msg.assistant .wsrc').last
        check('Searched the web' in await ws.text_content() and '1 source' in await ws.text_content(), 'reply lists its search')
        await ws.locator('summary').click()
        hrefs = await ws.evaluate("e=>[...e.querySelectorAll('a')].map(a=>[a.href,a.rel])")
        check(hrefs == [['https://example.com/a', 'noopener noreferrer']], f'source links open safely {hrefs}')
        await pg.screenshot(path=OUT + '/server_web.png')
        await pg.wait_for_timeout(1200)   # let the save land
        await pg.reload(); await pg.wait_for_timeout(1500)
        check(await pg.get_attribute('#webT', 'aria-pressed') == 'true', 'web toggle remembered after reload')
        check(await pg.locator('.pane[data-tid="main"] .msg.assistant .wsrc').count() >= 1, 'search record saved with the reply')
        await pg.locator('#webT').click()
        check(await pg.get_attribute('#webT', 'aria-pressed') == 'false', 'web toggle turns back off')

        # a second browser (fresh storage) sees the same conversation, because it lives on the server
        pg2 = await page()
        items = await pg2.evaluate("[...document.querySelectorAll('.side .citem, .side [data-cid]')].map(e=>e.textContent)")
        check(any('gradient' in (i or '').lower() or (title or '') in (i or '') for i in items), f'conversation listed in a fresh browser {items[:3]}')
        msgs = await pg2.locator('.pane[data-tid="main"] .msg.assistant').count()
        check(msgs >= 1, 'conversation reopened with its reply in a fresh browser')
        check(len(os.listdir(os.path.join(data_dir, 'convs'))) >= 1, 'conversation written to the data folder')

        # documents are stored as files on the server and survive a reload
        await pg2.locator('#newDoc').click(); await pg2.wait_for_timeout(200)
        await pg2.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg2.locator('#docGo').click(); await pg2.wait_for_timeout(3500)
        check(await pg2.locator('.dpage').count() == 3, 'PDF opened (3 pages)')
        files = [f for f in os.listdir(os.path.join(data_dir, 'files')) if not f.endswith('.json')]
        check(len(files) == 1, 'PDF stored in the data folder')
        await pg2.reload(); await pg2.wait_for_timeout(3500)
        check(await pg2.locator('.dpage').count() == 3, 'PDF reloads from the server')
        await pg2.screenshot(path=OUT + '/server_doc.png')

        # stop button ends the model run
        ta2 = pg2.locator('.pane[data-tid="main"] textarea')
        await ta2.fill('SLOW please'); await ta2.press('Enter'); await pg2.wait_for_timeout(1200)
        await pg2.locator('.pane[data-tid="main"] form button[type=submit], .pane[data-tid="main"] form .send').last.click()
        await pg2.wait_for_timeout(1500)
        check('KILLED' in open(os.environ['FAKE_LOG']).read(), 'Stop in the app stops the Claude Code process')

        check(not errs, 'no page errors ' + '; '.join(errs[:5]))
        await b.close()


def main():
    tmp = tempfile.mkdtemp(prefix='digress-test-')
    log = os.path.join(tmp, 'fake.log'); open(log, 'w').close(); os.environ['FAKE_LOG'] = log
    fake_claude = os.path.join(FAKES, 'fake-claude.mjs')
    procs = []
    try:
        # ---- provider: Claude Code CLI ----
        data = os.path.join(tmp, 'data')
        proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': fake_claude, 'DATA_DIR': data,
                            'ANTHROPIC_API_KEY': 'should-not-reach-the-cli', 'FAKE_LOG': log})
        procs.append(proc)
        h = json.loads(req(base, 'GET', '/api/health')[1])
        check(h['app'] == 'digress' and h['llm'] and h['provider'] == 'claude-code' and h['web'] is True, f'health {h}')
        st, text, lines = chat(base, {'system': 'S' * 200000, 'model': 'claude-opus-5-5', 'effort': 'high',
                                      'messages': [{'role': 'user', 'content': 'hi'}, {'role': 'assistant', 'content': 'hello'}, {'role': 'user', 'content': 'and now?'}]})
        check(st == 200 and 'model=claude-opus-5-5 effort=high system=200000 turns=2' in text, 'Claude Code: streams, passes model, effort, a 200k system prompt and history')
        check(lines[-1].get('done') and lines[-1].get('model') == 'claude-opus-5-5', 'Claude Code: done line carries the model')
        last = json.loads(open(log).read().strip().splitlines()[-1])
        check(last['apiKeyVisible'] is False and last['tools'] == '', 'Claude Code: runs with tools off and without the API key, so it uses the subscription sign-in')
        check('<user>\nhi\n</user>' in last['prompt'] and last['prompt'].rstrip().endswith('and now?'), 'Claude Code: earlier turns go in the prompt')
        # web search: only when asked, and then only WebSearch
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'SEARCHME'}]})
        last = json.loads(open(log).read().strip().splitlines()[-1])
        check(last['tools'] == '' and not any('search' in l for l in lines), 'Claude Code: no web access unless the request asks for it')
        st, text, lines = chat(base, {'web': True, 'messages': [{'role': 'user', 'content': 'SEARCHME'}]})
        last = json.loads(open(log).read().strip().splitlines()[-1])
        check(last['tools'] == 'WebSearch' and last['allowed'] == 'WebSearch', f'Claude Code: web on allows WebSearch and nothing else {last["tools"]!r}')
        check([l['search'] for l in lines if 'search' in l] == ['fake search query'], f'Claude Code: search query relayed {lines}')
        srcs = [s for l in lines if 'sources' in l for s in l['sources']]
        check(srcs == [{'title': 'Example source', 'url': 'https://example.com/a'}], f'Claude Code: sources relayed, non-web links dropped {srcs}')
        check(text == 'Let me look.\n\nFound it: [Example](https://example.com/a).', f'Claude Code: text before and after a search kept apart {text!r}')
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'FAILAUTH'}]})
        check('error' in lines[-1] and 'sign in' in lines[-1]['error'], f'Claude Code: sign-in problems explained: {lines[-1]}')

        # abort mid-stream kills the CLI
        c = http.client.HTTPConnection(base.split('//')[1]); c.request('POST', '/api/chat', json.dumps({'messages': [{'role': 'user', 'content': 'SLOW'}]}), {'content-type': 'application/json'})
        r = c.getresponse(); r.readline(); c.close(); time.sleep(1)
        check(open(log).read().count('KILLED') == 1, 'closing the request stops the Claude Code process')

        # storage
        check(req(base, 'PUT', '/api/store/convs/c1', {'title': 'A', 'n': 1})[0] == 200, 'store: put')
        check(json.loads(req(base, 'GET', '/api/store/convs/c1')[1]) == {'title': 'A', 'n': 1}, 'store: get')
        req(base, 'PATCH', '/api/store/convs/c1', {'n': 2})
        check(json.loads(req(base, 'GET', '/api/store/convs/c1')[1])['n'] == 2, 'store: patch')
        check(any(d['id'] == 'c1' for d in json.loads(req(base, 'GET', '/api/store/convs')[1])), 'store: list')
        check(req(base, 'GET', '/api/store/convs/..%2F..%2Fetc')[0] == 400, 'store: rejects path tricks')
        check(req(base, 'GET', '/api/store/secrets/x')[0] == 404, 'store: unknown collection')
        req(base, 'DELETE', '/api/store/convs/c1')
        check(req(base, 'GET', '/api/store/convs/c1')[0] == 404, 'store: delete')
        pdf = open(FIX + '/paper.pdf', 'rb').read()
        st, b = req(base, 'POST', '/api/files?type=application/pdf', raw=pdf, ctype='application/pdf')
        fid = json.loads(b)['id']
        check(req(base, 'GET', '/api/files/' + fid)[1] == pdf, 'files: upload and download')
        check(req(base, 'POST', '/api/files?type=text/html', raw=b'<x>', ctype='text/html')[0] == 415, 'files: other types refused')
        req(base, 'DELETE', '/api/files/' + fid)
        check(req(base, 'GET', '/api/files/' + fid)[0] == 404, 'files: delete')

        asyncio.run(browser_checks(base, data))

        # ---- provider: Anthropic API ----
        api_port = free_port()
        fa = subprocess.Popen(['node', os.path.join(FAKES, 'fake-anthropic.mjs'), str(api_port)], stdout=subprocess.PIPE); procs.append(fa)
        time.sleep(0.5)
        proc2, base2 = start({'ANTHROPIC_API_KEY': 'test-key', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{api_port}', 'DATA_DIR': os.path.join(tmp, 'data2')})
        procs.append(proc2)
        h = json.loads(req(base2, 'GET', '/api/health')[1])
        check(h['provider'] == 'anthropic' and h['llm'] and h['web'], 'API key present: the Anthropic API is used')
        models = json.loads(req(base2, 'GET', '/api/models')[1])['models']
        check(['claude-test-1', 'Test One'] in models, 'API: model list comes from the API')
        st, text, _ = chat(base2, {'system': 'sys', 'model': 'claude-test-1', 'effort': 'high', 'messages': [{'role': 'user', 'content': 'x'}]})
        check('web=false effort=high cached=true n=1' in text, f'API: effort sent, system prompt cached, no tools: {text}')
        st, text, lines = chat(base2, {'web': True, 'model': 'claude-test-1', 'messages': [{'role': 'user', 'content': 'SEARCHME'}]})
        check([l.get('search') for l in lines if 'search' in l] == ['api search'], f'API: web_search query relayed {lines}')
        check(any(l.get('sources') == [{'title': 'API source', 'url': 'https://example.org/b'}] for l in lines), 'API: search results relayed as sources')
        check('resumed with server_tool_use,web_search_tool_result query=api search' in text and lines[-1].get('done'), f'API: a paused search turn is resumed with its blocks {text!r}')
        st, text, _ = chat(base2, {'model': 'claude-noeffort', 'effort': 'high', 'messages': [{'role': 'user', 'content': 'x'}]})
        check('effort=none' in text, 'API: retries without effort when a model rejects it')
        proc3, base3 = start({'ANTHROPIC_API_KEY': 'wrong', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{api_port}', 'DATA_DIR': os.path.join(tmp, 'data3')})
        procs.append(proc3)
        st, text, lines = chat(base3, {'messages': [{'role': 'user', 'content': 'x'}]})
        check(st == 502 and 'invalid' in lines[0]['error'], 'API: bad key reported')
        proc4, base4 = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': '/nonexistent/claude', 'DATA_DIR': os.path.join(tmp, 'data4')})
        procs.append(proc4)
        h = json.loads(req(base4, 'GET', '/api/health')[1])
        check(not h['llm'] and 'Claude Code CLI' in h['why'], 'missing CLI explained')
        print(f'\nall {passed} checks passed')
    finally:
        for pr in procs: pr.kill()
        shutil.rmtree(tmp, ignore_errors=True)


main()
