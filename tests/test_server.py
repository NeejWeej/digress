"""End-to-end test of the self-hosted server, using fake stand-ins for Claude Code, the Anthropic API and OpenAI (ChatGPT sign-in).

Starts server/server.mjs twice (once per model provider), checks the HTTP API directly,
then drives the real app in a browser against it. Exits non-zero on the first failure.
"""
import asyncio, json, os, urllib.parse, shutil, socket, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error, http.client, http.server
from playwright.async_api import async_playwright
from common import ROOT, REPO, FIX, OUT, launch_args, BOOT_WATCH, booted, settled, saved, soon, poll

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
    'readability@0.6.0/Readability.js': ROOT + '@mozilla/readability/Readability.js',
    'turndown@7.2.0/dist/turndown.js': ROOT + 'turndown/dist/turndown.js',
    'turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js': ROOT + 'turndown-plugin-gfm/dist/turndown-plugin-gfm.js',
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


def wait_port(port, timeout=10):
    """Wait until something listens on the port (a fake we just started)."""
    end = time.time() + timeout
    while True:
        try: socket.create_connection(('127.0.0.1', port), timeout=1).close(); return
        except OSError:
            if time.time() > end: raise
            time.sleep(0.05)


def wait_until(fn, timeout=10):
    """Call fn until it returns something truthy (or the time is up); returns its last value."""
    end = time.time() + timeout
    while not (v := fn()) and time.time() < end: time.sleep(0.05)
    return v


def start(env_extra):
    port = free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'LLM_', 'CLAUDE_BIN', 'CHATGPT_'))}
    # never pick up a real ChatGPT sign-in from this machine
    env.update({'PORT': str(port), 'HOST': '127.0.0.1', 'CHATGPT_AUTH_FILE': '/nonexistent/chatgpt.json'}, **env_extra)
    proc = subprocess.Popen(['node', SERVER], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(100):
        try:
            urllib.request.urlopen(f'http://{env["HOST"]}:{port}/api/health', timeout=1); break
        except Exception:
            time.sleep(0.1)
    return proc, f'http://127.0.0.1:{port}'


def req(base, method, path, body=None, raw=None, ctype='application/json', headers=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(base + path, data=data, method=method, headers={'content-type': ctype, **(headers or {})})
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
            await pg.add_init_script(BOOT_WATCH); await pg.goto(base + '/'); await booted(pg)
            return pg

        pg = await page()
        check((await pg.title()).startswith('Digress'), 'app served with the Digress title')
        opts = await pg.evaluate("[...document.querySelectorAll('#mSel option')].map(o=>o.value)")
        check('claude-opus-5-5' in opts and 'auto' in opts, f'model picker lists Claude Code models {opts}')
        await pg.select_option('#mSel', 'claude-opus-5-5')
        ta = pg.locator('.pane[data-tid="main"] textarea')
        await ta.fill('What is the gradient of x squared?'); await ta.press('Enter')
        await pg.wait_for_selector('.pane[data-tid="main"] .msg.assistant mjx-container', timeout=15000)
        body = await pg.locator('.pane[data-tid="main"] .msg.assistant .body').first.text_content()
        check('model=claude-opus-5-5' in body, 'reply streamed into the app with the chosen model')
        await settled(pg, 1)
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
        await settled(pg, 2); await saved(pg)   # let the save land
        await pg.reload(); await booted(pg)
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
        await pg2.locator('#newDoc').click()
        await pg2.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg2.locator('#docGo').click()
        await soon(pg2, "()=>{const c=__digress.conv;return c.doc&&c.doc.assetId&&document.querySelectorAll('.dpage').length>=3}", timeout=15000)
        check(await pg2.locator('.dpage').count() == 3, 'PDF opened (3 pages)')
        files = [f for f in os.listdir(os.path.join(data_dir, 'files')) if not f.endswith('.json')]
        check(len(files) == 1, 'PDF stored in the data folder')
        await saved(pg2)
        await pg2.reload(); await booted(pg2); await soon(pg2, "document.querySelectorAll('.dpage').length>=3", timeout=15000)
        check(await pg2.locator('.dpage').count() == 3, 'PDF reloads from the server')
        await pg2.screenshot(path=OUT + '/server_doc.png')

        # a document from a link: risky links ask first, then it opens and shows where it came from
        site = os.environ['FAKE_SITE']
        await pg2.locator('#newDoc').click()
        await pg2.locator('#docPaste').fill(f'http://{site}/paper.pdf')
        await pg2.locator('#docGo').click(); await soon(pg2, "document.querySelector('#docGo').textContent==='Open anyway'")
        m = await pg2.locator('#docMsg').text_content()
        check('isn’t encrypted' in m and 'bare IP' in m and await pg2.locator('#docGo').text_content() == 'Open anyway', f'a risky link asks before downloading {m!r}')
        await pg2.locator('#docGo').click()
        await soon(pg2, "!!document.querySelector('.pane[data-tid=doc] .docsrc')&&document.querySelectorAll('.dpage').length>=3", timeout=15000)
        check(await pg2.locator('.dpage').count() == 3, 'after Open anyway, the PDF from the link opens')
        src = await pg2.locator('.pane[data-tid="doc"] .docsrc').evaluate("a=>[a.textContent,a.href,a.rel,a.target]")
        check(src == ['127.0.0.1', f'http://{site}/paper.pdf', 'noopener noreferrer', '_blank'], f'the document shows where it came from {src}')
        await pg2.screenshot(path=OUT + '/server_doc_link.png')
        await pg2.locator('#newDoc').click()
        await pg2.locator('#docPaste').fill(f'http://{site}/page.html')
        await pg2.locator('#docGo').click(); await pg2.wait_for_function("document.querySelector('#docGo').textContent==='Open anyway'")
        await pg2.locator('#docGo').click(); await soon(pg2, "document.querySelector('#docMsg').textContent.includes('find an article')")
        check('find an article' in await pg2.locator('#docMsg').text_content(), 'a web page with no article in it explains what to do instead')
        await pg2.locator('#docCancel').click()

        # stop button ends the model run
        ta2 = pg2.locator('.pane[data-tid="main"] textarea')
        await ta2.fill('SLOW please'); await ta2.press('Enter')
        await pg2.wait_for_function("(()=>{const c=__digress.conv,m=c.msgs[c.order.main.at(-1)];return m.pending&&m.content.includes('tick')})()")   # the CLI is writing
        await pg2.locator('.pane[data-tid="main"] form button[type=submit], .pane[data-tid="main"] form .send').last.click()
        await poll(lambda: 'KILLED' in open(os.environ['FAKE_LOG']).read())
        check('KILLED' in open(os.environ['FAKE_LOG']).read(), 'Stop in the app stops the Claude Code process')

        check(not errs, 'no page errors ' + '; '.join(errs[:5]))
        await b.close()


def fake_site():
    """A tiny website for "open a document from a link": a PDF, Markdown, a web page, redirects and a big file."""
    pdf = open(os.path.join(FIX, 'paper.pdf'), 'rb').read()
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            port = self.server.server_address[1]
            routes = {
                '/paper.pdf': (200, 'application/pdf', pdf), '/sneaky': (200, 'text/html', pdf),   # a PDF however it's labelled
                '/notes.md': (200, 'text/markdown; charset=utf-8', '# Notes\n\nSoftmax turns scores into weights.'.encode()),
                '/page.html': (200, 'text/html', b'<!doctype html><html><body>hi</body></html>'),
                '/app.exe': (200, 'application/octet-stream', b'MZ\x00\x01'),
                '/big.pdf': (200, 'application/pdf', b'%PDF-1.4\n' + b'0' * (2 * 1024 * 1024)),
                '/to-pdf': (302, f'/paper.pdf', b''),
                '/to-private': (302, f'http://127.0.0.1:{port + 1}/x', b''),
                '/to-localname': (302, f'http://localhost:{port}/paper.pdf', b''),
                '/to-file': (302, 'file:///etc/passwd', b''),
            }
            st, ct, body = routes.get(self.path, (404, 'text/plain', b'nope'))
            self.send_response(st)
            if st == 302: self.send_header('location', ct)
            else: self.send_header('content-type', ct); self.send_header('content-length', str(len(body)))
            self.end_headers()
            try: self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass   # the server hung up on a too-big file: expected
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'127.0.0.1:{srv.server_address[1]}'


def doc_link_checks(base, site):
    """Opening a document from a link: only public addresses, risky links need an OK, only documents kept."""
    def fetch(url, confirm=None, headers=None):
        st, body = req(base, 'POST', '/api/fetch-doc', {'url': url, 'confirm': confirm or []}, headers=headers)
        return st, body
    ok = ['http', 'ip', 'port']   # the fake site is plain http on a bare IP and an odd port, so it always needs this OK
    st, body = fetch(f'http://{site}/paper.pdf')
    j = json.loads(body)
    check(st == 409 and sorted(w['code'] for w in j['warnings']) == ['http', 'ip', 'port'] and all(w['text'] for w in j['warnings']), f'an http link to a bare IP and odd port needs your OK first {j}')
    pdf = open(os.path.join(FIX, 'paper.pdf'), 'rb').read()
    r = urllib.request.urlopen(urllib.request.Request(base + '/api/fetch-doc', data=json.dumps({'url': f'http://{site}/to-pdf', 'confirm': ok}).encode(), headers={'content-type': 'application/json'}))
    check(r.status == 200 and r.read() == pdf and r.headers['x-doc-kind'] == 'pdf' and r.headers['x-doc-name'] == 'paper'
          and urllib.parse.unquote(r.headers['x-doc-url']) == f'http://{site}/paper.pdf', 'after your OK: a PDF downloads, following a same-site redirect, with its name and final address')
    st, body = fetch(f'http://{site}/sneaky', ok)
    check(st == 200 and body == pdf, 'a PDF is recognised by its contents, not the label the site gives it')
    r = urllib.request.urlopen(urllib.request.Request(base + '/api/fetch-doc', data=json.dumps({'url': f'http://{site}/page.html', 'confirm': ok}).encode(), headers={'content-type': 'application/json'}))
    check(r.status == 200 and r.headers['x-doc-kind'] == 'html' and r.headers['content-type'].startswith('text/plain') and r.read().startswith(b'<!doctype html>'),
          'a web page comes back as plain text (never served as a page) for the browser to pull the article out of')
    st, body = fetch(f'http://{site}/notes.md', ok)
    check(st == 200 and body.startswith(b'# Notes'), 'a Markdown file downloads as text')
    for path, code, words, what in [
        ('/app.exe', 415, 'PDF, Markdown and text', 'other file types are refused'),
        ('/big.pdf', 413, 'over 1 MB', 'files over the upload limit are refused'),
        ('/to-private', 400, 'private or local address', 'a redirect to another local port is refused'),
        ('/to-localname', 400, 'local network name', 'a redirect to localhost is refused'),
        ('/to-file', 400, 'http and https', 'a redirect to a file:// address is refused')]:
        st, body = fetch(f'http://{site}{path}', ok)
        check(st == code and words in json.loads(body)['error'], f'{what} ({st} {json.loads(body)["error"]!r})')
    for url, words in [('http://127.0.0.1:9/x.pdf', 'private'), ('http://10.1.2.3/x.pdf', 'private'), ('http://192.168.1.1/', 'private'),
                       ('http://169.254.169.254/latest/meta-data/', 'private'), ('http://100.100.100.100/', 'private'), ('http://[::1]/', 'private'),
                       ('http://[::ffff:127.0.0.1]/', 'private'), ('http://[fd00::1]/', 'private'), ('http://2130706433/', 'private'), ('http://0x7f.1/', 'private'),
                       ('http://localhost/x.pdf', 'local network name'), ('https://printer.local/', 'local network name'), ('https://nas/', 'local network name'),
                       ('https://box.tail1234.ts.net/', 'local network name'), ('file:///etc/passwd', 'http and https'), ('ftp://example.com/a.pdf', 'http and https'),
                       ('https://user:pw@example.com/a.pdf', 'username or password'), ('not a link', 'look like a link')]:
        st, body = fetch(url, ['http', 'ip', 'port'])
        check(st == 400 and words in json.loads(body)['error'], f'never fetched, even with every OK given: {url}')
    st, body = fetch('https://example.com:8443/a.pdf')
    check(st == 409 and [w['code'] for w in json.loads(body)['warnings']] == ['port'], 'an unusual port needs your OK first')
    st, _ = fetch(f'http://{site}/paper.pdf', ok, headers={'origin': 'https://evil.example'})
    check(st == 403, 'another website cannot make the server download things')
    # DNS rebinding: a public-looking name that resolves to this machine is caught at connect time
    script = ("import dns from 'node:dns'; dns.lookup = (h, o, cb) => cb(null, [{address: '127.0.0.1', family: 4}]);"
              "const { fetchDocument } = await import(process.argv[1]);"
              "try { await fetchDocument('https://rebind.example/a.pdf', {maxBytes: 1e6}); console.log('FETCHED') } catch (e) { console.log(e.status, e.message) }")
    out = subprocess.run(['node', '--input-type=module', '-e', script, os.path.join(REPO, 'server', 'fetchdoc.mjs')], capture_output=True, text=True).stdout
    check(out.startswith('400') and 'private or local' in out, f'a name that resolves to a private address is refused (DNS rebinding) {out!r}')
    # and the opposite: ordinary internet addresses must get through (a blocklist that blocks everything is a bug too)
    script = ("const { publicAddress: p } = await import(process.argv[1]);"
              "console.log(JSON.stringify([['8.8.8.8','144.92.158.111','1.1.1.1','2606:4700:4700::1111','2a00:1450:4001:80b::200e'].map(p),"
              "['127.0.0.1','10.0.0.1','172.16.5.4','192.168.0.1','100.64.0.1','169.254.169.254','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','::ffff:8.8.8.8','fe80::1','fd12::1','64:ff9b::a00:1','2002:a00:1::1'].map(p)]))")
    out = json.loads(subprocess.run(['node', '--input-type=module', '-e', script, os.path.join(REPO, 'server', 'fetchdoc.mjs')], capture_output=True, text=True).stdout)
    check(all(out[0]) and not any(out[1]), f'public IPv4 and IPv6 addresses are allowed, private and special ones are not {out}')


def chatgpt_checks(tmp, fake_claude, log, procs):
    """ChatGPT on the plan route, against tests/fakes/fake-openai.mjs: sign-in, refresh, requests, events."""
    oport = free_port()
    fo = subprocess.Popen(['node', os.path.join(FAKES, 'fake-openai.mjs'), str(oport)], stdout=subprocess.PIPE); procs.append(fo)
    wait_port(oport)
    obase = f'http://127.0.0.1:{oport}'
    auth = os.path.join(tmp, 'cfg', 'chatgpt.json')
    cli_env = {**{k: v for k, v in os.environ.items() if not k.startswith('CHATGPT_')}, 'CHATGPT_AUTH_FILE': auth, 'CHATGPT_AUTH_BASE': obase, 'CHATGPT_API_BASE': obase + '/v1'}

    # sign in: the CLI prints a link; "the browser" follows it, OpenAI redirects to the CLI's loopback listener
    lport = free_port()
    cli = subprocess.Popen(['node', os.path.join(REPO, 'server', 'chatgpt.mjs'), 'login', '--no-browser'], env={**cli_env, 'CHATGPT_LOGIN_PORT': str(lport)}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    url = None
    for _ in range(50):
        line = cli.stdout.readline()
        if line.startswith(obase + '/api/accounts/authorize?'): url = line.strip(); break
    check(url and f'redirect_uri=http%3A%2F%2F127.0.0.1%3A{lport}%2Fauth%2Fcallback' in url and 'agent_name_hint=Digress' in url, 'ChatGPT login: prints the sign-in link with a loopback callback')
    with urllib.request.urlopen(url, timeout=10) as r: r.read()
    out = cli.communicate(timeout=20)[0]
    check(cli.returncode == 0 and 'Connected as reader@example.com' in out, f'ChatGPT login: PKCE code exchange and signed ID token accepted: {out!r}')
    rec = json.load(open(auth))
    check(rec['client_id'] == 'app_123' and rec['access_token'] == 'tok-login' and rec['host_id'].startswith('urn:uuid:') and oct(os.stat(auth).st_mode & 0o777) == '0o600',
          'ChatGPT login: sign-in saved owner-only, with its own app registration')
    st = subprocess.run(['node', os.path.join(REPO, 'server', 'chatgpt.mjs'), 'status'], env=cli_env, capture_output=True, text=True).stdout
    check('"connected": true' in st and 'tok-' not in st and 'ref-' not in st, 'ChatGPT status: says connected, prints no tokens')

    # the server, with Claude Code and ChatGPT side by side; the token is about to expire, so it gets refreshed
    rec['expires_at'] = 0; json.dump(rec, open(auth, 'w'))
    proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': fake_claude, 'DATA_DIR': os.path.join(tmp, 'data5'), 'FAKE_LOG': log,
                        'CHATGPT_AUTH_FILE': auth, 'CHATGPT_AUTH_BASE': obase, 'CHATGPT_API_BASE': obase + '/v1'})
    procs.append(proc)
    h = json.loads(req(base, 'GET', '/api/health')[1])
    check(h['providers'] == ['claude-code', 'chatgpt'] and h['web'], f'ChatGPT: available next to Claude once signed in {h}')
    models = json.loads(req(base, 'GET', '/api/models')[1])['models']
    check(['gpt-test-1', 'GPT Test'] in models and ['claude-opus-5-5', 'Opus 5.5'] in models and not any(m[0] == 'gpt-hidden' for m in models), 'ChatGPT: its listed models join the picker, hidden ones don\'t')
    rec = json.load(open(auth))
    check(rec['access_token'].startswith('tok-r') and rec['refresh_token'].startswith('ref-r') and rec['expires_at'] > time.time() * 1000 and oct(os.stat(auth).st_mode & 0o777) == '0o600',
          'ChatGPT: an expiring sign-in is renewed and the rotated tokens saved')
    last = lambda: json.loads(open(log).read().strip().splitlines()[-1])
    hist = [{'role': 'user', 'content': 'hi'}, {'role': 'assistant', 'content': 'hello'}, {'role': 'user', 'content': 'and now?'}]
    stc, text, lines = chat(base, {'system': 'D' * 5000, 'model': 'gpt-test-1', 'effort': 'high', 'messages': hist})
    check(stc == 200 and text == 'gpt reply effort=high tools=0 dev=5000 n=4' and lines[-1] == {'done': True, 'model': 'gpt-test-1-2026', 'truncated': False}, f'ChatGPT: streams a reply with effort, system prompt and history {text!r} {lines[-1]}')
    b = last()
    check(b['store'] is False and b['stream'] is True and 'tools' not in b and 'max_output_tokens' not in b and b['token'] == rec['access_token'], 'ChatGPT: store:false, stream:true, no tools at all when web is off')
    check([m['role'] for m in b['input']] == ['developer', 'user', 'assistant', 'user'] and b['input'][-1]['content'] == 'and now?', 'ChatGPT: system prompt first as a developer message, then the history as separate turns (cacheable prefix)')
    key = b['prompt_cache_key']
    chat(base, {'system': 'D' * 5000, 'model': 'gpt-test-1', 'effort': 'high', 'messages': hist + [{'role': 'assistant', 'content': 'x'}, {'role': 'user', 'content': 'more'}]})
    b2 = last()
    check(b2['prompt_cache_key'] == key and b2['input'][:4] == b['input'], 'ChatGPT: a follow-up keeps the same cache key and an unchanged prefix')
    stc, text, lines = chat(base, {'model': 'gpt-test-1', 'messages': [{'role': 'user', 'content': 'SEARCHME'}]})
    check('tools' not in last() and not any('search' in l for l in lines), 'ChatGPT: no web search unless the request asks for it')
    stc, text, lines = chat(base, {'web': True, 'model': 'gpt-test-1', 'messages': [{'role': 'user', 'content': 'SEARCHME'}]})
    b = last()
    check(b['tools'] == [{'type': 'web_search'}] and b['include'] == ['web_search_call.action.sources'], f'ChatGPT: web on offers web_search and nothing else {b.get("tools")}')
    check([l['search'] for l in lines if 'search' in l] == ['gpt search'], f'ChatGPT: search query relayed {lines}')
    srcs = [s['url'] for l in lines if 'sources' in l for s in l['sources']]
    check(srcs == ['https://example.net/c', 'https://example.net/d'], f'ChatGPT: searched and cited pages relayed, non-web links dropped {srcs}')
    check(text == 'Let me check.\n\nFound: [net](https://example.net/c).', f'ChatGPT: text before and after a search kept apart {text!r}')
    stc, text, lines = chat(base, {'model': 'gpt-test-1', 'effort': 'max', 'messages': [{'role': 'user', 'content': 'x'}]})
    check('effort=none' in text, 'ChatGPT: retries without a reasoning effort the model rejects')
    stc, text, lines = chat(base, {'model': 'gpt-test-1', 'messages': [{'role': 'user', 'content': 'LIMIT'}]})
    check('error' in lines[-1] and 'usage limit' in lines[-1]['error'], f'ChatGPT: plan limit explained {lines[-1]}')
    stc, text, lines = chat(base, {'model': 'gpt-test-1', 'messages': [{'role': 'user', 'content': 'DROP'}]})
    check('error' in lines[-1] and 'dropped' in lines[-1]['error'], 'ChatGPT: a reply cut off without response.completed is an error, not a finished reply')
    stc, text, lines = chat(base, {'model': 'claude-opus-5-5', 'messages': [{'role': 'user', 'content': 'x'}]})
    check('Fake reply. model=claude-opus-5-5' in text, 'ChatGPT: Claude models still go to Claude')

    # a sign-in file others can read is not used
    os.chmod(auth, 0o644)
    check(json.loads(req(base, 'GET', '/api/health')[1])['providers'] == ['claude-code'], 'ChatGPT: a sign-in file readable by others is refused')
    os.chmod(auth, 0o600)
    out = subprocess.run(['node', os.path.join(REPO, 'server', 'chatgpt.mjs'), 'logout'], env=cli_env, capture_output=True, text=True).stdout
    rec2 = json.load(open(auth)); revoked = json.loads(urllib.request.urlopen(obase + '/revoked').read())
    check('revoked' in out and 'refresh_token' not in rec2 and rec2['client_id'] == 'app_123' and len(revoked) == 1 and revoked[0].startswith('ref-r'),
          'ChatGPT logout: refresh token revoked, tokens forgotten, app registration kept')
    check(json.loads(req(base, 'GET', '/api/health')[1])['providers'] == ['claude-code'], 'ChatGPT: signing out removes it without a restart')


def main():
    tmp = tempfile.mkdtemp(prefix='digress-test-')
    log = os.path.join(tmp, 'fake.log'); open(log, 'w').close(); os.environ['FAKE_LOG'] = log
    fake_claude = os.path.join(FAKES, 'fake-claude.mjs')
    procs = []
    try:
        # ---- provider: Claude Code CLI ----
        data = os.path.join(tmp, 'data')
        site_srv, site = fake_site()
        os.environ['FAKE_SITE'] = site
        proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': fake_claude, 'DATA_DIR': data, 'DOC_FETCH_TEST_ALLOW': site, 'MAX_UPLOAD_MB': '1',
                            'ANTHROPIC_API_KEY': 'should-not-reach-the-cli', 'FAKE_LOG': log})
        procs.append(proc)
        # only requests addressed to this server, from its own page, get through (DNS rebinding, cross-site POSTs)
        port = base.rsplit(':', 1)[1]
        check(req(base, 'GET', '/api/store/convs', headers={'host': 'evil.example:' + port})[0] == 403, 'a request addressed to another site name is refused (DNS rebinding)')
        check(req(base, 'GET', '/', headers={'host': 'evil.example'})[0] == 403, 'the page itself is refused under another site name')
        check(req(base, 'POST', '/api/chat', {'messages': [{'role': 'user', 'content': 'hi'}]}, headers={'origin': 'https://evil.example'})[0] == 403, 'a cross-site POST is refused')
        check(req(base, 'POST', '/api/chat', {'messages': [{'role': 'user', 'content': 'hi'}]}, headers={'origin': 'null'})[0] == 403, 'a POST from a sandboxed or file:// page is refused')
        check(req(base, 'GET', '/api/health', headers={'host': 'localhost:' + port, 'origin': 'http://localhost:' + port})[0] == 200, 'the app\'s own origin is allowed (localhost)')
        check(req(base, 'GET', '/api/health', headers={'host': 'box.tail1234.ts.net', 'origin': 'https://box.tail1234.ts.net'})[0] == 200, 'Tailscale Serve names are allowed')
        # ALLOWED_HOSTS replaces the default list; a leading dot matches names under it; a specific HOST is allowed
        proc_h, base_h = start({'ALLOWED_HOSTS': 'mybox.lan,.home.arpa', 'DATA_DIR': os.path.join(tmp, 'data_h'), 'CLAUDE_BIN': fake_claude})
        procs.append(proc_h)
        allowed = lambda b, hst: req(b, 'GET', '/api/health', headers={'host': hst})[0] == 200
        check(allowed(base_h, 'mybox.lan') and allowed(base_h, 'pi.home.arpa') and allowed(base_h, 'localhost') and not allowed(base_h, 'box.tail1234.ts.net') and not allowed(base_h, 'home.arpa.evil.example'),
              'ALLOWED_HOSTS: exact names and .suffix entries allowed, replaces the .ts.net default')
        proc_n, base_n = start({'ALLOWED_HOSTS': 'none', 'HOST': '127.0.0.2', 'DATA_DIR': os.path.join(tmp, 'data_n'), 'CLAUDE_BIN': fake_claude})
        procs.append(proc_n)
        base_n = base_n.replace('127.0.0.1', '127.0.0.2')
        check(allowed(base_n, '127.0.0.2') and not allowed(base_n, 'box.tail1234.ts.net'), 'a specific HOST address is allowed; ALLOWED_HOSTS=none drops .ts.net')
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
        check(last['isolated'], 'Claude Code: runs without MCP servers, hooks, CLAUDE.md, skills or commands')
        check([l['search'] for l in lines if 'search' in l] == ['fake search query'], f'Claude Code: search query relayed {lines}')
        srcs = [s for l in lines if 'sources' in l for s in l['sources']]
        check(srcs == [{'title': 'Example source', 'url': 'https://example.com/a'}], f'Claude Code: sources relayed, non-web links dropped {srcs}')
        check(text == 'Let me look.\n\nFound it: [Example](https://example.com/a).', f'Claude Code: text before and after a search kept apart {text!r}')
        st, text, lines = chat(base, {'messages': [{'role': 'user', 'content': 'FAILAUTH'}]})
        check('error' in lines[-1] and 'sign in' in lines[-1]['error'], f'Claude Code: sign-in problems explained: {lines[-1]}')

        # Stop kills the CLI; a dropped connection doesn't (the reply carries on: test_runs.py)
        c = http.client.HTTPConnection(base.split('//')[1]); c.request('POST', '/api/chat', json.dumps({'chat': 'a' * 32, 'messages': [{'role': 'user', 'content': 'SLOW'}]}), {'content-type': 'application/json'})
        r = c.getresponse(); r.readline(); c.close(); time.sleep(1)   # deliberate: a second for it to (wrongly) stop
        check(open(log).read().count('KILLED') == 0, 'closing the request leaves the Claude Code process running')
        req(base, 'POST', '/api/chat/stop', {'chat': 'a' * 32}); wait_until(lambda: open(log).read().count('KILLED') >= 1)
        check(open(log).read().count('KILLED') == 1, 'Stop ends the Claude Code process')

        # storage
        check(req(base, 'PUT', '/api/store/convs/c1', {'title': 'A', 'n': 1})[0] == 200, 'store: put')
        check(json.loads(req(base, 'GET', '/api/store/convs/c1')[1]) == {'title': 'A', 'n': 1, 'rev': 1}, 'store: get (a conversation gets a version)')
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

        doc_link_checks(base, site)
        asyncio.run(browser_checks(base, data))

        # ---- provider: Anthropic API ----
        api_port = free_port()
        fa = subprocess.Popen(['node', os.path.join(FAKES, 'fake-anthropic.mjs'), str(api_port)], stdout=subprocess.PIPE); procs.append(fa)
        wait_port(api_port)
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
        chatgpt_checks(tmp, fake_claude, log, procs)
        print(f'\nall {passed} checks passed')
    finally:
        for pr in procs: pr.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
