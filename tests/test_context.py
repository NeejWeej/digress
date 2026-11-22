"""Nothing you send gets lost on the way to the model.

1. Server, every provider: a long conversation of text (Unicode, Markdown, a 100k-character reply,
   tags that look like the transcript's own) and images (PNG, JPEG, WebP, several in one message) is
   sent to Claude Code, the Anthropic API and ChatGPT (fakes in tests/fakes/ that record exactly what
   they receive). Every text and every image byte must arrive, in order, with the system prompt intact.
   Anything the server can't understand is refused with an error, never quietly dropped.
2. The app, end to end: a conversation built by clicking around (a PDF; pasted screenshots; a branch
   from highlighted text; a snip of a figure; a whole page; a branch off a branch) is sent through the
   real server. Each request is checked against the conversation the app saved: every message on the
   branch's path is present, in order, and every image arrives byte for byte.

Asserts and exits non-zero on the first failure.
"""
import asyncio, base64, hashlib, json, os, shutil, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright
from common import FIX, OUT, launch_args, BOOT_WATCH, booted, replies, settled, saved, soon, frames
from common import CORS
from test_server import FAKES, CDN, check, free_port, start, req, chat, wait_port

sha = lambda b: hashlib.sha256(b).hexdigest()
IMG = '\x00IMG:{}\x00'


def lines(path):
    return [json.loads(l) for l in open(path).read().splitlines() if l.strip().startswith('{')]


# ---- flatten what each provider received into one string, images as markers, so order is checked too
def flat_parts(parts):
    out = ''
    for p in parts:
        if p.get('type') == 'text': out += p['text']
        elif p.get('type') == 'input_text': out += p['text']
        elif p.get('type') == 'image': out += IMG.format(sha(base64.b64decode(p['source']['data'])))
        elif p.get('type') == 'input_image':
            out += IMG.format(sha(base64.b64decode(p['image_url'].split(',', 1)[1])))
        else: raise AssertionError('unexpected part ' + json.dumps(p)[:200])
    return out


def flat_content(c):
    return c if isinstance(c, str) else flat_parts(c)


def expected_flat(m):
    """What a message we sent should look like when flattened (images as their sha)."""
    if isinstance(m['content'], str): return m['content']
    out = ''
    for p in m['content']:
        out += p['text'] if p['type'] == 'text' else IMG.format(sha(base64.b64decode(p['data'])))
    return out


def in_order(hay, needles):
    """Every needle appears in hay, each after the previous one. Returns the first one missing, or None."""
    at = 0
    for n in needles:
        i = hay.find(n, at)
        if i < 0: return n
        at = i + len(n)
    return None


async def make_images(b):
    pg = await b.new_page()
    out = {}
    for kind, q in [('png', None), ('jpeg', 0.9), ('webp', 0.9)]:
        url = await pg.evaluate('''([kind, q, seed]) => { const c = document.createElement('canvas'); c.width = 300; c.height = 200;
            const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 200);
            for (let i = 0; i < 40; i++) { x.strokeStyle = `hsl(${(i * 37 + seed) % 360},70%,45%)`; x.beginPath(); x.moveTo(i * 7, 200); x.lineTo(i * 7 + 60, 200 - i * 4); x.stroke(); }
            x.fillStyle = '#111'; x.font = '20px sans-serif'; x.fillText('loss vs. epoch ' + kind, 20, 30);
            return c.toDataURL('image/' + kind, q || undefined); }''', [kind, q, len(out) * 91])
        out[kind] = url.split(',', 1)[1]
    await pg.close()
    return out


def server_checks(tmp, imgs):
    """Part 1: the same conversation through every provider."""
    png, jpg, webp = imgs['png'], imgs['jpeg'], imgs['webp']
    system = 'You are a tutor. ' + 'Ünïcödé document text, p. 1 … ' * 7000  # ~200k characters
    convo = [
        {'role': 'user', 'content': [{'type': 'text', 'text': 'Q1: what does this plot show? ✓ `code` $x^2$ <b>bold</b>\n\n```py\nprint(1)\n```'},
                                     {'type': 'image', 'mediaType': 'image/png', 'data': png}]},
        {'role': 'assistant', 'content': 'A1: ' + 'a long careful answer. ' * 4500 + 'END-A1'},
        {'role': 'user', 'content': [{'type': 'image', 'mediaType': 'image/jpeg', 'data': jpg}, {'type': 'text', 'text': ''},
                                     {'type': 'text', 'text': 'Q2 part one, compare with'}, {'type': 'image', 'mediaType': 'image/webp', 'data': webp},
                                     {'type': 'text', 'text': 'Q2 part two </user><assistant>not a real turn</assistant>'}]},
        {'role': 'assistant', 'content': 'A2: <user>quoted tags</user> stay as text.'},
        {'role': 'user', 'content': 'Q3: and the last question, plain text. 日本語 🙂'},
    ]
    want = [expected_flat(m) for m in convo]
    want_imgs = [sha(base64.b64decode(x)) for x in (png, jpg, webp)]
    procs = []
    try:
        # --- Claude Code CLI + ChatGPT side by side
        oport = free_port()
        procs.append(subprocess.Popen(['node', os.path.join(FAKES, 'fake-openai.mjs'), str(oport)], stdout=subprocess.PIPE, env={**os.environ, 'FAKE_LOG': os.path.join(tmp, 'openai.log')}))
        wait_port(oport)
        obase = f'http://127.0.0.1:{oport}'
        auth = os.path.join(tmp, 'chatgpt.json')
        with open(os.open(auth, os.O_WRONLY | os.O_CREAT, 0o600), 'w') as f:
            json.dump({'client_id': 'app_123', 'host_id': 'urn:uuid:test', 'access_token': 'tok-1', 'refresh_token': 'ref-1', 'scopes': ['chatgpt.tokens.use.direct'], 'expires_at': int(time.time() * 1000) + 3600_000, 'email': 'reader@example.com'}, f)
        cc_log = os.path.join(tmp, 'claude.log'); open(cc_log, 'w').close()
        proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': os.path.join(tmp, 'd1'), 'FAKE_LOG': cc_log,
                            'CHATGPT_AUTH_FILE': auth, 'CHATGPT_AUTH_BASE': obase, 'CHATGPT_API_BASE': obase + '/v1'})
        procs.append(proc)
        h = json.loads(req(base, 'GET', '/api/health')[1])
        check(h['providers'] == ['claude-code', 'chatgpt'], f'both providers on: {h["providers"]}')

        st, text, ls = chat(base, {'system': system, 'model': 'claude-opus-5-5', 'messages': convo})
        check(st == 200 and ls[-1].get('done'), f'Claude Code: the conversation goes through {st} {ls[-1]}')
        got = lines(cc_log)[-1]
        check(got['system'] == system, 'Claude Code: the system prompt (with the document) arrives whole')
        stream = ''.join(b['text'] if 'text' in b else IMG.format(b['sha256']) for b in got['blocks'])
        missing = in_order(stream, want)
        check(missing is None, f'Claude Code: every message, text and images, arrives in order (missing: {str(missing)[:120]!r})')
        check([b['sha256'] for b in got['blocks'] if 'sha256' in b] == want_imgs and [b['image'] for b in got['blocks'] if 'image' in b] == ['image/png', 'image/jpeg', 'image/webp'],
              'Claude Code: each image arrives byte for byte, with its type')
        check(stream.count('<user>') == 3 and stream.count('<assistant>') == 3,
              'Claude Code: the transcript marks each earlier turn (2 user + 2 assistant, plus the quoted tags kept as text)')

        st, text, ls = chat(base, {'model': 'claude-opus-5-5', 'messages': [{'role': 'user', 'content': 'UNICODE please'}]})
        check(text == '∑ 日本語 é 🙂 ' * 60, f'Claude Code: a reply full of multi-byte characters arrives intact even when they\'re split between chunks ({text.count(chr(0xfffd))} broken)')

        st, text, ls = chat(base, {'system': system, 'model': 'gpt-test-1', 'messages': convo})
        check(st == 200 and ls[-1].get('done'), f'ChatGPT: the conversation goes through {st} {ls[-1]}')
        b = lines(os.path.join(tmp, 'openai.log'))[-1]
        check(b['input'][0] == {'role': 'developer', 'content': system}, 'ChatGPT: the system prompt arrives whole, first')
        got = [(m['role'], flat_content(m['content'])) for m in b['input'][1:]]
        check(got == [(m['role'], w) for m, w in zip(convo, want)], 'ChatGPT: every message arrives exactly, in order, images byte for byte')
        check(isinstance(b['input'][-1]['content'], str) and isinstance(b['input'][2]['content'], str),
              'ChatGPT: text-only messages stay plain strings (so its prompt cache keeps matching)')

        # refused, not dropped
        n_cc, n_oa = len(lines(cc_log)), len(lines(os.path.join(tmp, 'openai.log')))
        bad_png = base64.b64encode(b'GIF89a' + b'\0' * 100).decode()
        for what, msgs in [
            ('an image whose bytes don\'t match its type', [{'role': 'user', 'content': [{'type': 'image', 'mediaType': 'image/png', 'data': bad_png}]}]),
            ('an image in a reply', [{'role': 'user', 'content': 'hi'}, {'role': 'assistant', 'content': [{'type': 'image', 'mediaType': 'image/png', 'data': png}]}, {'role': 'user', 'content': 'x'}]),
            ('a part of an unknown kind', [{'role': 'user', 'content': [{'type': 'text', 'text': 'x'}, {'type': 'document', 'data': 'x'}]}]),
            ('an SVG', [{'role': 'user', 'content': [{'type': 'image', 'mediaType': 'image/svg+xml', 'data': base64.b64encode(b'<svg/>').decode()}]}]),
            ('an image over 5 MB', [{'role': 'user', 'content': [{'type': 'image', 'mediaType': 'image/png', 'data': base64.b64encode(base64.b64decode(png)[:16] + b'\0' * (5 * 1024 * 1024 + 10)).decode()}]}]),
            ('a message with no role', [{'content': 'x'}]),
            ('text that isn\'t a string', [{'role': 'user', 'content': [{'type': 'text', 'text': 5}]}]),
        ]:
            for model in ('claude-opus-5-5', 'gpt-test-1'):
                st, _, ls = chat(base, {'model': model, 'messages': msgs})
                check(st == 400 and ls[0].get('error'), f'refused with an error, not sent without it: {what} ({model}): {ls[0]}')
        check(len(lines(cc_log)) == n_cc and len(lines(os.path.join(tmp, 'openai.log'))) == n_oa, 'none of those reached a model')

        # --- Anthropic API
        aport = free_port(); api_log = os.path.join(tmp, 'api.log'); open(api_log, 'w').close()
        procs.append(subprocess.Popen(['node', os.path.join(FAKES, 'fake-anthropic.mjs'), str(aport)], stdout=subprocess.PIPE, env={**os.environ, 'FAKE_API_LOG': api_log}))
        wait_port(aport)
        proc2, base2 = start({'ANTHROPIC_API_KEY': 'test-key', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{aport}', 'DATA_DIR': os.path.join(tmp, 'd2')})
        procs.append(proc2)
        st, text, ls = chat(base2, {'system': system, 'model': 'claude-test-1', 'messages': convo})
        check(st == 200 and ls[-1].get('done'), f'Anthropic API: the conversation goes through {st} {ls[-1]}')
        b = lines(api_log)[-1]
        check(b['system'][0]['text'] == system, f"Anthropic API: the system prompt arrives whole {len(b['system'][0]['text'])} vs {len(system)} {b['system'][0]['text'][:80]!r}")
        got = [(m['role'], flat_content(m['content'])) for m in b['messages']]
        check(got == [(m['role'], w) for m, w in zip(convo, want)], 'Anthropic API: every message arrives exactly, in order, images byte for byte')
        check(all(p['source']['media_type'] == t for p, t in zip([p for m in b['messages'] if not isinstance(m['content'], str) for p in m['content'] if p['type'] == 'image'], ['image/png', 'image/jpeg', 'image/webp'])),
              'Anthropic API: each image keeps its type')
    finally:
        for p in procs: p.kill()


# ---------------- part 2: the app, end to end ----------------
def path_of(conv, tid):
    out = []
    while tid:
        out.insert(0, tid)
        tid = conv['threads'][tid].get('parent')
    return out


def expected_path(conv, tid, files_dir):
    """Independently of the app's code: the messages a request from thread `tid` must carry, as
    (role, [text pieces], [image sha256 or 'region']) in order. Mirrors the rules in AGENTS.md:
    the whole path from main to tid, each ancestor cut at the message the next branch starts from."""
    p = path_of(conv, tid)
    seq = []
    for i, t in enumerate(p):
        mids = conv['order'][t]
        if i < len(p) - 1:
            a = conv['threads'][p[i + 1]]['anchorMsg']
            mids = mids[:mids.index(a) + 1] if a in mids else []
        for mid in mids:
            m = conv['msgs'][mid]
            if m['role'] == 'note': seq.append(('user', [m['content']], [])); continue
            if m['role'] == 'assistant' and not m.get('content'): continue
            imgs = [sha(open(os.path.join(files_dir, r['asset']), 'rb').read()) for r in m.get('images', [])]
            seq.append((m['role'], [m['content']] if m.get('content') else [], imgs))
    if seq and seq[-1][0] == 'assistant': seq.pop()  # the reply that request produced
    return seq


async def app_checks(tmp, b):
    oport = free_port(); oa_log = os.path.join(tmp, 'openai2.log'); open(oa_log, 'w').close()
    fo = subprocess.Popen(['node', os.path.join(FAKES, 'fake-openai.mjs'), str(oport)], stdout=subprocess.PIPE, env={**os.environ, 'FAKE_LOG': oa_log})
    wait_port(oport)
    obase = f'http://127.0.0.1:{oport}'
    auth = os.path.join(tmp, 'chatgpt2.json')
    with open(os.open(auth, os.O_WRONLY | os.O_CREAT, 0o600), 'w') as f:
        json.dump({'client_id': 'app_123', 'host_id': 'urn:uuid:test', 'access_token': 'tok-1', 'refresh_token': 'ref-1', 'scopes': ['chatgpt.tokens.use.direct'], 'expires_at': int(time.time() * 1000) + 3600_000}, f)
    cc_log = os.path.join(tmp, 'claude2.log'); open(cc_log, 'w').close()
    gport = free_port(); g_log = os.path.join(tmp, 'gemini2.log'); open(g_log, 'w').close()
    fg = subprocess.Popen(['node', os.path.join(FAKES, 'fake-gemini.mjs'), str(gport)], stdout=subprocess.PIPE, env={**os.environ, 'FAKE_LOG': g_log})
    wait_port(gport)
    data = os.path.join(tmp, 'd3')
    proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': data, 'FAKE_LOG': cc_log,
                        'CHATGPT_AUTH_FILE': auth, 'CHATGPT_AUTH_BASE': obase, 'CHATGPT_API_BASE': obase + '/v1',
                        'GEMINI_API_KEY': 'gemini-test-key-0000000000', 'GEMINI_API_BASE': f'http://127.0.0.1:{gport}/v1beta'})
    files_dir = os.path.join(data, 'files')
    try:
        ctx = await b.new_context(viewport={'width': 1500, 'height': 950})
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))

        async def route(r):
            u = r.request.url
            for k, v in CDN.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(BOOT_WATCH); await pg.goto(base + '/'); await booted(pg)

        async def wait_idle(n):   # n replies, none still being written, and saved
            await settled(pg, n)
            await pg.wait_for_function("!document.querySelector('.msg.assistant .typing, .msg.assistant.pending')&&![...document.querySelectorAll('.sendb')].some(b=>b.title==='Stop')")
            await saved(pg)

        async def paste(sel, seed):
            await pg.evaluate('''([sel, seed]) => new Promise(res => { const c = document.createElement('canvas'); c.width = 900; c.height = 500;
                const x = c.getContext('2d'); x.fillStyle = '#f7f7f2'; x.fillRect(0, 0, 900, 500); x.fillStyle = `hsl(${seed * 60},60%,40%)`;
                for (let i = 0; i < 12; i++) x.fillRect(60 + i * 64, 450 - (i * seed * 13) % 380, 40, (i * seed * 13) % 380);
                x.fillStyle = '#222'; x.font = '28px sans-serif'; x.fillText('Screenshot ' + seed, 30, 40);
                c.toBlob(bl => { const dt = new DataTransfer(); dt.items.add(new File([bl], 'shot.png', { type: 'image/png' }));
                  const ta = document.querySelector(sel); ta.focus(); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); res(); }, 'image/png'); })''', [sel, seed])
            await pg.wait_for_function("sel => { const i = document.querySelector(sel).closest('.pane').querySelector('.cimg img'); return i && i.complete && i.naturalWidth > 0 }", arg=sel)

        async def ask(tid, text):
            ta = pg.locator(f'.pane[data-tid="{tid}"] textarea').first
            n = await replies(pg); await ta.fill(text); await ta.press('Enter'); await wait_idle(n + 1)

        async def saved_conv():
            convs = json.loads(req(base, 'GET', '/api/store/convs')[1])
            cid = max(convs, key=lambda c: c['data'].get('updated', 0))['id']
            return json.loads(req(base, 'GET', '/api/store/convs/' + cid)[1])

        def verify(conv, tid, what, provider='claude'):
            want = expected_path(conv, tid, files_dir)
            if provider == 'claude':
                got = lines(cc_log)[-1]
                stream = ''.join(x['text'] if 'text' in x else IMG.format(x['sha256']) for x in got['blocks'])
                got_imgs = [x['sha256'] for x in got['blocks'] if 'sha256' in x]
                system = got['system']
            elif provider == 'gemini':
                got = [l for l in lines(g_log) if l.get('gemini')][-1]
                part = lambda p: p['text'] if 'text' in p else IMG.format(sha(base64.b64decode(p['inlineData']['data']))) if 'inlineData' in p else ''
                stream = ''.join('\x00ROLE\x00' + ''.join(part(p) for p in c['parts']) for c in got['contents'])
                got_imgs = [sha(base64.b64decode(p['inlineData']['data'])) for c in got['contents'] for p in c['parts'] if 'inlineData' in p]
                system = got['systemInstruction']['parts'][0]['text']
            else:
                got = lines(oa_log)[-1]
                stream = ''.join(('\x00ROLE\x00' + flat_content(m['content'])) for m in got['input'][1:])
                got_imgs = [sha(base64.b64decode(p['image_url'].split(',', 1)[1])) for m in got['input'][1:] if not isinstance(m['content'], str) for p in m['content'] if p['type'] == 'input_image']
                system = got['input'][0]['content']
            needles = []
            for role, texts, imgs in want:
                needles += [IMG.format(s) for s in imgs] + texts
            missing = in_order(stream, needles)
            check(missing is None, f'{what}: every message on the branch\'s path arrives, in order ({len(want)} messages; missing: {str(missing)[:100]!r})')
            known = [s for _, _, imgs in want for s in imgs]
            check(all(s in got_imgs for s in known), f'{what}: every pasted screenshot arrives byte for byte ({len(known)})')
            return got_imgs, system, stream

        # a PDF, then the main thread with a pasted screenshot
        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', FIX + '/paper.pdf'); await pg.locator('#docGo').click()
        await pg.wait_for_function("(()=>{const c=__digress.conv;return c.doc&&c.doc.assetId&&document.querySelectorAll('.dpage').length>=3&&(document.querySelector('.dpage[data-page=\"1\"] .textLayer')||{}).textContent})()", timeout=20000)
        await paste('.pane[data-tid="main"] textarea', 1)
        check(await pg.locator('.pane[data-tid="main"] .cimg img').count() == 1, 'pasting a screenshot shows it in the message box')
        await pg.screenshot(path=OUT + '/context_paste.png')
        await ask('main', 'Q-main-1: what does my screenshot show?')
        conv = await saved_conv()
        um = [m for m in conv['msgs'].values() if m['role'] == 'user'][0]
        check(len(um.get('images', [])) == 1 and os.path.exists(os.path.join(files_dir, um['images'][0]['asset'])), 'the screenshot is saved with the message, as a file on the server')
        check(await pg.locator('.pane[data-tid="main"] .msg.user .uimg img').count() == 1 and await pg.locator('.pane[data-tid="main"] .cimg').count() == 0, 'it shows in the sent message and leaves the message box')
        imgs1, system, _ = verify(conv, 'main', 'main thread, 1st question')
        check('<document>' in system and 'Attention' in system, 'the document text is in the system prompt')
        await ask('main', 'Q-main-2: and a follow-up without an image')
        verify(await saved_conv(), 'main', 'main thread, 2nd question')

        # a branch from highlighted text in a reply
        await pg.evaluate('''() => { const body = [...document.querySelectorAll('.pane[data-tid=main] .msg.assistant .body')][0];
          const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 10);
          const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); }''')
        n = await replies(pg); await pg.locator('#popIn').fill('Q-text-branch: explain that part'); await pg.locator('#popIn').press('Enter'); await wait_idle(n + 1)
        conv = await saved_conv()
        tb = [t for t in conv['threads'].values() if t.get('parent') == 'main' and t['anchorMsg'] != 'DOC'][0]
        _, _, stream = verify(conv, tb['id'], 'branch from highlighted text')
        check('Q-main-2' not in stream and tb['anchorText'] in stream, 'it carries the path up to the reply it came from, plus the highlighted words, and not later messages')

        # a snip of the PDF
        doc = pg.locator('.pane[data-tid=doc]')
        await doc.locator('[data-act=snip]').click(); await frames(pg)
        p1 = await doc.locator('.dpage[data-page="1"]').bounding_box()
        await pg.mouse.move(p1['x'] + p1['width'] * 0.1, p1['y'] + p1['height'] * 0.05); await pg.mouse.down()
        await pg.mouse.move(p1['x'] + p1['width'] * 0.8, p1['y'] + p1['height'] * 0.2, steps=8); await pg.mouse.up()
        await soon(pg, "(()=>{const i=document.querySelector('#pop.show .pimg');return i&&i.complete&&i.naturalWidth>200})()")
        check(await pg.locator('#pop.show .pimg').count() == 1 and (await pg.locator('#pop .pimg').evaluate('e=>e.naturalWidth')) > 200, 'snipping a box opens the question popup with a sharp image of it')
        await pg.screenshot(path=OUT + '/context_snip.png')
        n = await replies(pg); await pg.locator('#popIn').fill('Q-snip: what is in this box?'); await pg.locator('#popIn').press('Enter'); await wait_idle(n + 1)
        conv = await saved_conv()
        sb = [t for t in conv['threads'].values() if t.get('anchorRegion') and t['anchorRegion']['w'] < 1][0]
        check(0.05 < sb['anchorRegion']['x'] < 0.15 and 0.6 < sb['anchorRegion']['w'] < 0.8 and sb['anchorPage'] == 0, f'the branch remembers where the snip is on the page {sb["anchorRegion"]}')
        check('Attention' in sb.get('regionText', ''), f'and the PDF\'s words inside it: {sb.get("regionText")!r}')
        snip_imgs, _, stream = verify(conv, sb['id'], 'snip branch')
        check(len(snip_imgs) == 1 and 'area of the document (p. 1)' in stream and sb['regionText'] in stream, 'the snip image itself arrives, with the page and the text inside it')
        check(await doc.locator(f'.dregion[data-tid="{sb["id"]}"]').count() == 1, 'the snip is outlined on the page in the branch\'s colour')
        oi = pg.locator(f'.pane[data-tid="{sb["id"]}"] .origin .oimg img')
        await soon(pg, "sel=>{const i=document.querySelector(sel);return i&&i.complete&&i.naturalWidth>100}", f'.pane[data-tid="{sb["id"]}"] .origin .oimg img')
        check(await oi.count() == 1 and await oi.evaluate('e=>e.naturalWidth') > 100, 'the snip branch shows the snip at its top')
        await pg.locator(f'.pane[data-tid="{sb["id"]}"]').screenshot(path=OUT + '/context_snip_branch.png')
        await ask(sb['id'], 'Q-snip-2: a follow-up in the snip branch')
        snip_imgs2, _, _ = verify(await saved_conv(), sb['id'], 'snip branch, follow-up')
        check(snip_imgs2 == snip_imgs, 'the follow-up sends the same snip again, identical')

        # a branch off the snip branch's reply, with its own screenshot
        await pg.evaluate(f'''() => {{ const body = document.querySelector('.pane[data-tid="{sb["id"]}"] .msg.assistant .body');
          const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 8);
          const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup', {{ bubbles: true }})); }}''')
        n = await replies(pg); await pg.locator('#popChips .chip').first.click(); await wait_idle(n + 1)
        conv = await saved_conv()
        nb = [t for t in conv['threads'].values() if t.get('parent') == sb['id']][0]
        await paste(f'.pane[data-tid="{nb["id"]}"] textarea', 2)
        await ask(nb['id'], 'Q-nested: compare with my screenshot')
        conv = await saved_conv()
        nimgs, _, stream = verify(conv, nb['id'], 'branch off the snip branch (3 levels deep)')
        check(snip_imgs[0] in nimgs and len(nimgs) == 2 and 'Q-snip-2' not in stream, f'it carries the snip from its parent branch and the new screenshot, and stops at the reply it branched from {nimgs}')

        # ask about a whole page, then the same branch on ChatGPT
        p2 = doc.locator('.dpage[data-page="2"]')
        await p2.scroll_into_view_if_needed(); await p2.hover()
        await p2.locator('.pask').click(); await soon(pg, "(()=>{const i=document.querySelector('#pop.show .pimg');return i&&i.complete&&i.naturalWidth>0})()")
        check(await pg.locator('#pop.show .pimg').count() == 1, '"Ask about this page" opens the popup with the page')
        n = await replies(pg); await pg.locator('#popIn').fill('Q-page: summarise this page'); await pg.locator('#popIn').press('Enter'); await wait_idle(n + 1)
        conv = await saved_conv()
        pb = [t for t in conv['threads'].values() if t.get('anchorRegion') and t['anchorRegion']['w'] >= 1][0]
        pimgs, _, stream = verify(conv, pb['id'], 'whole-page branch')
        check(len(pimgs) == 1 and 'page 2 of the document' in stream, 'the page image arrives, labelled with its page')
        await pg.locator(f'.pane[data-tid="{nb["id"]}"] .pb').dispatch_event('pointerdown')   # the picker follows the pane you're in: switch that branch
        await pg.select_option('#mSel', 'gpt-test-1')
        await ask(nb['id'], 'Q-nested-gpt: the same branch, now on ChatGPT')
        conv = await saved_conv()
        gimgs, _, _ = verify(conv, nb['id'], 'ChatGPT, branch off the snip branch', provider='openai')
        check(len(gimgs) == 2 and snip_imgs[0] in gimgs, 'ChatGPT gets the same snip and screenshot')
        await pg.select_option('#mSel', 'gemini-3.8-flash')
        await ask(nb['id'], 'Q-nested-gemini: the same branch, now on Gemini')
        conv = await saved_conv()
        mimgs, msys, _ = verify(conv, nb['id'], 'Gemini, branch off the snip branch', provider='gemini')
        check(len(mimgs) == 2 and snip_imgs[0] in mimgs, 'Gemini gets the same snip and screenshot')

        await pg.reload(); await booted(pg); await soon(pg, "!!document.querySelector('.msg.user .uimg img')")
        check(await pg.locator('.msg.user .uimg img').count() >= 1, 'after a reload, sent screenshots still show')
        await pg.screenshot(path=OUT + '/context_after_reload.png')
        check(not errs, 'no page errors: ' + '; '.join(errs[:3]))
        await ctx.close()
    finally:
        proc.kill(); fo.kill(); fg.kill()


async def main():
    tmp = tempfile.mkdtemp()
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            imgs = await make_images(b)
            server_checks(tmp, imgs)
            await app_checks(tmp, b)
            await b.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('all context checks passed')

asyncio.run(main())
