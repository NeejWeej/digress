"""Export and import.
  - A conversation exports as a .digress file (gzipped JSON): every thread, message, takeaway and pasted image,
    without its layout, pins, reading mark or flashcard schedules; the document only when asked (else doc.left,
    and whoever opens it attaches their own copy); cards only when asked, and they arrive in the inbox, fresh.
  - Importing it (the document dialog's file picker) makes a new conversation with new ids next to the original,
    with its image and document stored again, and opens it.
  - Markdown and an Anki CSV export too. A file that isn't Digress's is refused with a toast.
  - Exporting sends nothing anywhere: no request but GETs while it runs.
Asserts and exits non-zero."""
import asyncio, gzip, json, os, sys, tempfile
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon, OUT, settle

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
SEED = r"""
const now = Date.now(), day = 864e5;
localStorage.setItem('fakesrv:file/img1', JSON.stringify({type: 'image/png', data: '%s'}));
localStorage.setItem('fakesrv:file/docf', JSON.stringify({type: 'text/markdown', data: btoa('# Notes\n\nThe gradient tells each weight which way to move.')}));
localStorage.setItem('fakesrv:convs/cx1', JSON.stringify({id: 'cx1', title: 'Backprop, explained', created: now - day, updated: now, rev: 3, pinned: true,
  doc: {kind: 'text', name: 'notes.md', assetId: 'docf', source: 'https://example.com/notes.md', mark: ['o', 12]},
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1},
    b1: {id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'the gradient', anchorRange: {s: 20, e: 32}, title: 'Why the gradient', colorIdx: 0, created: now - 1000, llm: ['claude-gone-9', 'high'], pinned: true}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'What is backprop?', ts: now - 5000, images: [{asset: 'img1', type: 'image/png', w: 1, h: 1}]},
    a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'Backprop computes the gradient of the loss for every weight.', model: 'claude-sonnet-5-5', ts: now - 4000},
    u2: {id: 'u2', role: 'user', thread: 'b1', content: 'Why the gradient?', ts: now - 3000},
    a2: {id: 'a2', role: 'assistant', thread: 'b1', content: 'Because the gradient points uphill, so you step the other way.', ts: now - 2000},
    n1: {id: 'n1', role: 'note', thread: 'main', fromThread: 'b1', content: 'Step against the gradient.', ts: now - 1000}},
  order: {main: ['u1', 'a1', 'n1'], b1: ['u2', 'a2']}, nextColor: 1, llm: ['claude-sonnet-5-5', 'auto']}));
localStorage.setItem('fakesrv:cards/k1', JSON.stringify({id: 'k1', conv: 'cx1', convTitle: 'Backprop, explained', thread: 'b1', at: {thread: 'b1', msg: 'a2'}, where: 'Why the gradient', src: 'highlight',
  front: 'Which way does the gradient point?', back: 'Uphill.', quote: {text: 'Because the gradient points uphill', msg: 'a2'}, status: 'active', created: now - 900, due: now + day,
  fsrs: {S: 3, D: 5, state: 'review', last: now - 100}, reviews: [{at: now - 100, g: 3}]}));
""" % PNG

FAKE = "window.fakeLLM = {use: async () => async (m, o) => { o.onText({text: 'ok'}); return {text: 'ok'} }};"

async def main():
    tmp = tempfile.mkdtemp()
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        ctx = await b.new_context(viewport={'width': 1280, 'height': 860}, accept_downloads=True)
        pg = await ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        sent = []; pg.on('request', lambda r: sent.append((r.method, r.url)) if r.method != 'GET' else None)
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg)
        await pg.wait_for_function("__digress.conv && __digress.conv.id === 'cx1'")

        async def export(fmt, doc=False, cards=False, name='out'):
            await pg.evaluate("document.querySelector('[data-expconv=cx1]').click()")
            await pg.wait_for_selector('#modal.show')
            await pg.locator(f'[name=xfmt][value={fmt}]').check()
            if doc: await pg.locator('#xDoc').check()
            if cards: await pg.locator('#xCards').check()
            async with pg.expect_download() as dl:
                await pg.locator('#mOk').click()
            d = await dl.value
            path = os.path.join(tmp, name + '-' + d.suggested_filename); await d.save_as(path)
            return path, d.suggested_filename

        await pg.evaluate("document.querySelector('[data-expconv=cx1]').click()"); await pg.wait_for_selector('#modal.show')
        check('the export dialog offers Digress, Shareable link, Markdown and Anki', await pg.locator('[name=xfmt]').count() == 4)
        check('…the document and the cards are left out unless ticked', not await pg.locator('#xDoc').is_checked() and not await pg.locator('#xCards').is_checked())
        check('…and it says nothing is uploaded', 'Nothing is uploaded' in await pg.locator('#mBody').inner_text())
        await settle(pg, 400); await pg.locator('#modal .mbox').screenshot(path=OUT + '/export_dialog.png')
        await pg.locator('#mCancel').click()

        sent.clear()
        path, fname = await export('digress', cards=True, name='a')
        check('the file is named after the conversation', fname.replace('_', ' ') == 'Backprop, explained.digress', fname)   # (WebKit's downloads turn spaces into _)
        raw = open(path, 'rb').read()
        check('it is gzipped', raw[:2] == b'\x1f\x8b')
        f = json.loads(gzip.decompress(raw))
        c = f['conversations'][0]
        check('it has every message and thread', set(c['msgs']) == {'u1', 'a1', 'u2', 'a2', 'n1'} and set(c['threads']) == {'main', 'b1'})
        check('…each branch’s model', c['threads']['b1'].get('llm') == ['claude-gone-9', 'high'])
        check('…without layout, version, pins or the reading mark', not any(k in c for k in ('ui', 'rev', 'pinned')) and 'pinned' not in c['threads']['b1'] and 'mark' not in c['doc'])
        check('…without the document unless asked (marked as left out)', 'assetId' not in c['doc'] and c['doc'].get('left') is True and 'docf' not in f['files'])
        check('…with the pasted image', 'img1' in f['files'] and f['files']['img1']['data'] == json.loads(PNG and '"%s"' % PNG))
        k = f['cards']
        check('…and the card, without its schedule or reviews', len(k) == 1 and 'fsrs' not in k[0] and 'reviews' not in k[0] and 'due' not in k[0] and k[0]['quote']['text'], k)
        check('exporting sent nothing anywhere', not sent, sent)

        md, mdname = await export('md', name='b')
        text = open(md, encoding='utf-8').read()
        check('Markdown: a section per thread, the branch under its passage, the takeaway', mdname.endswith('.md') and '## Main thread' in text and '### Why the gradient' in text and '> the gradient' in text and 'Takeaway from “Why the gradient”' in text, text[:600])
        csv, cname = await export('anki', name='c')
        rows = open(csv, encoding='utf-8').read().splitlines()
        check('Anki: the header Anki reads, then front, back, source and a tag', rows[:4] == ['#separator:comma', '#html:false', '#columns:Front,Back,Source,Tags', '#tags column:4'] and rows[4].startswith('"Which way does the gradient point?","Uphill.","Because the gradient points uphill","digress::Backprop,_explained"'), rows[:5])

        # import: through the document dialog's file picker
        await pg.locator('#newDoc').click(); await pg.wait_for_selector('#docModal.show')
        await pg.locator('#docFile').set_input_files(path)
        ok = await soon(pg, "__digress.conv && __digress.conv.id !== 'cx1' && __digress.conv.title === 'Backprop, explained'")
        check('importing opens it as a new conversation', ok)
        nc = await pg.evaluate("JSON.parse(JSON.stringify(__digress.conv))")
        nb1 = next((t for tid, t in nc['threads'].items() if tid != 'main'), None)
        nu1 = next((m for m in nc['msgs'].values() if m['role'] == 'user' and m['thread'] == 'main'), None)
        na2 = next((m for m in nc['msgs'].values() if m['role'] == 'assistant' and nb1 and m['thread'] == nb1['id']), None)
        check('…with every message, branch (with remapped safe ids) and the branch’s model',
              len(nc['msgs']) == 5 and nb1 and nb1['id'] != 'b1' and nb1['llm'] == ['claude-gone-9', 'high'] and 'u1' not in nc['msgs'])
        img = nu1['images'][0]
        check('…its image stored again, under a new id', img.get('asset') and img['asset'] != 'img1' and await pg.evaluate("a => !!localStorage.getItem('fakesrv:file/' + a)", img.get('asset')), img)
        check('…not pinned', not nc.get('pinned'))
        await pg.wait_for_selector('.docerr', timeout=10000)
        check('…and its document asks for your own copy', 'Attach your copy of “notes.md”' in await pg.locator('.docerr').inner_text())
        cards = await pg.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage[k]))")
        mine = [x for x in cards if x['conv'] == nc['id']]
        check('the card arrives in the inbox, fresh (with remapped thread/message refs)',
              len(mine) == 1 and mine[0]['status'] == 'inbox' and not mine[0]['reviews'] and mine[0]['thread'] == nb1['id'] and mine[0]['at']['msg'] == na2['id'] and mine[0]['quote']['msg'] == na2['id'], mine)
        check('the original is untouched', await pg.evaluate("JSON.parse(localStorage['fakesrv:convs/cx1']).pinned === true"))
        check('both are in the sidebar', await pg.locator('#plist .citem, #clist .citem').count() >= 2)

        # with the document
        await pg.evaluate("document.querySelector('#clist .citem[data-conv=cx1], #plist .citem[data-conv=cx1]').click()")
        await pg.wait_for_function("__digress.conv.id === 'cx1'")
        path2, _ = await export('digress', doc=True, name='d')
        f2 = json.loads(gzip.decompress(open(path2, 'rb').read()))
        check('with the document ticked, it goes in the file', f2['conversations'][0]['doc'].get('assetId') == 'docf' and 'docf' in f2['files'] and not f2['conversations'][0]['doc'].get('left'))
        before = await pg.evaluate("__digress.convList.length")
        await pg.locator('#newDoc').click(); await pg.wait_for_selector('#docModal.show')
        await pg.locator('#docFile').set_input_files(path2)
        await pg.wait_for_function("n => __digress.convList.length > n && __digress.conv.id !== 'cx1'", arg=before)
        d2 = await pg.evaluate("__digress.conv.doc")
        check('…and opens with it, stored again', d2.get('assetId') and d2['assetId'] != 'docf' and not d2.get('left'), d2)
        await pg.wait_for_selector('.docbody', timeout=10000)
        check('…readable', 'which way to move' in await pg.locator('.docbody').inner_text())

        # not a Digress file
        bad = os.path.join(tmp, 'junk.digress'); open(bad, 'wb').write(b'not json at all')
        await pg.locator('#newDoc').click(); await pg.wait_for_selector('#docModal.show')
        n0 = await pg.evaluate("__digress.convList.length")
        await pg.locator('#docFile').set_input_files(bad); await frames(pg, 6)
        check('a file that isn’t Digress’s is refused', await soon(pg, "[...document.querySelectorAll('.toast')].some(t => /Digress file/.test(t.textContent))") and await pg.evaluate("__digress.convList.length") == n0)

        # shareable link (#share=…): live estimate, defaults to current URL, optional public URL toggle, round-trip import
        await pg.evaluate("window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true });")
        sent.clear()
        await pg.evaluate("document.querySelector('[data-expconv=cx1]').click()"); await pg.wait_for_selector('#modal.show')
        await pg.locator('[name=xfmt][value=link]').check()
        await soon(pg, "() => /link/.test((document.querySelector('#xLSize')||{}).textContent||'') && !document.querySelector('#mOk').disabled")
        check('Shareable link estimates size live and defaults to current URL (images/doc/cards unchecked)',
              await pg.locator('#mOk').inner_text() == 'Copy link'
              and not await pg.locator('#xLPub').is_checked()
              and not await pg.locator('#xLImg').is_checked()
              and not await pg.locator('#xLDoc').is_checked())
        await pg.locator('#mOk').click()
        await soon(pg, "() => !!window.__copied")
        local_link = await pg.evaluate("window.__copied")
        check('copied share link uses current origin and #share=, sending nothing anywhere',
              '#share=' in local_link and not local_link.startswith('https://digress.neejweej.workers.dev/') and not sent, [local_link[:80], sent])

        # toggling "Use public Digress link" switches base URL to digress.neejweej.workers.dev
        await pg.evaluate("window.__copied = null; document.querySelector('[data-expconv=cx1]').click()"); await pg.wait_for_selector('#modal.show')
        await pg.locator('[name=xfmt][value=link]').check()
        await pg.locator('#xLPub').check()
        await soon(pg, "() => /link/.test((document.querySelector('#xLSize')||{}).textContent||'') && !document.querySelector('#mOk').disabled")
        await pg.locator('#mOk').click()
        await soon(pg, "() => !!window.__copied")
        pub_link = await pg.evaluate("window.__copied")
        check('toggling public link uses digress.neejweej.workers.dev', pub_link.startswith('https://digress.neejweej.workers.dev/#share='), pub_link[:80])

        # opening the #share= link asks to confirm first; Cancel leaves sidebar untouched, Open imports a fresh copy
        before_share = await pg.evaluate("__digress.convList.length")
        share_hash = '#' + local_link.split('#', 1)[1]
        await pg.evaluate("h => { location.hash = h; }", share_hash)
        await pg.wait_for_selector('#modal.show')
        check('opening a #share= link asks to confirm first (with title and counts)',
              'Open shared conversation?' in await pg.locator('#mTitle').inner_text()
              and 'Backprop, explained' in await pg.locator('#mBody').inner_text()
              and await pg.evaluate("__digress.convList.length") == before_share)
        check('…and clears #share= from the address bar', await pg.evaluate("!location.hash.startsWith('#share=')"), await pg.evaluate("location.hash"))
        await pg.locator('#mCancel').click(); await frames(pg)
        check('cancelling the share prompt leaves the sidebar untouched', await pg.evaluate("__digress.convList.length") == before_share)

        await pg.evaluate("h => { location.hash = h; }", share_hash)
        await pg.wait_for_selector('#modal.show')
        await pg.locator('#mOk').click()
        ok_share = await soon(pg, "n => __digress.convList.length > n && __digress.conv.title === 'Backprop, explained'", before_share, timeout=10000)
        sc = await pg.evaluate("JSON.parse(JSON.stringify(__digress.conv))")
        su1 = next((m for m in sc['msgs'].values() if m['role'] == 'user' and m['thread'] == 'main'), None)
        check('confirming Open imports the conversation without the excluded image',
              ok_share and len(sc['msgs']) == 5 and su1 and not su1.get('images') and sc['doc'].get('left') is True)
        await pg.wait_for_selector('.docerr a[href="https://example.com/notes.md"]', timeout=10000)
        check('…and shows the document’s original source link when left out',
              await pg.locator('.docerr a[href="https://example.com/notes.md"]').count() == 1)

        # shareable link with text/Markdown document included (inlined as plain UTF-8 before gzip, readable on import)
        await pg.evaluate("window.__copied = null; document.querySelector('[data-expconv=cx1]').click()"); await pg.wait_for_selector('#modal.show')
        await pg.locator('[name=xfmt][value=link]').check()
        await pg.locator('#xLDoc').check()
        await soon(pg, "() => /link/.test((document.querySelector('#xLSize')||{}).textContent||'') && !document.querySelector('#mOk').disabled")
        await pg.locator('#mOk').click()
        await soon(pg, "() => !!window.__copied")
        doc_link = await pg.evaluate("window.__copied")
        before_doc_share = await pg.evaluate("__digress.convList.length")
        await pg.evaluate("h => { location.hash = h; }", '#' + doc_link.split('#', 1)[1])
        await pg.wait_for_selector('#modal.show')
        await pg.locator('#mOk').click()
        await soon(pg, "n => __digress.convList.length > n && __digress.conv.doc && !__digress.conv.doc.left", before_doc_share, timeout=10000)
        await pg.wait_for_selector('.docbody', timeout=10000)
        check('shareable link with a Markdown doc inlines it cleanly and opens readable',
              'which way to move' in await pg.locator('.docbody').inner_text())

        # bogus #share= hash is refused cleanly and cleared
        n_bad = await pg.evaluate("__digress.convList.length")
        await pg.evaluate("location.hash = '#share=not-valid!!!'")
        check('a bogus #share= link is refused and cleared',
              await soon(pg, "() => !location.hash.startsWith('#share=') && [...document.querySelectorAll('.toast')].some(t => /Invalid|share link/.test(t.textContent))")
              and await pg.evaluate("__digress.convList.length") == n_bad)

        # branch-level export: clicking Export in a branch pane's header exports just that branch (pruning main after the fork)
        await pg.evaluate("document.querySelector('#clist .citem[data-conv=cx1], #plist .citem[data-conv=cx1]').click()")
        await pg.wait_for_function("__digress.conv.id === 'cx1'")
        await pg.locator('#tree .mnode', has_text='Why the gradient').first.click(); await frames(pg, 4)
        bpane = pg.locator('.pane[data-tid=b1]')
        check('branch header replaced Back with an Export icon button',
              await bpane.locator('[data-act=back]').count() == 0 and await bpane.locator('[data-act=export]').count() == 1)
        await bpane.locator('[data-act=export]').click(); await pg.wait_for_selector('#modal.show')
        check('branch export dialog names the branch', 'Export branch “Why the gradient”' in await pg.locator('#mTitle').inner_text())
        async with pg.expect_download() as bdl:
            await pg.locator('#mOk').click()
        bpath = os.path.join(tmp, 'branch.digress'); await (await bdl.value).save_as(bpath)
        bf = json.loads(gzip.decompress(open(bpath, 'rb').read()))
        bc = bf['conversations'][0]
        check('branch export keeps main only up to the fork (dropping takeaway n1 after it) and keeps branch b1',
              bc['title'] == 'Why the gradient' and bc['order']['main'] == ['u1', 'a1'] and bc['order']['b1'] == ['u2', 'a2'] and 'n1' not in bc['msgs'], bc['order'])

        # security: adversarial thread/message IDs in a #share= link are remapped and never execute markup
        import base64
        evil_tid = '"><img src=x onerror="window.__xss=1">'
        evil_mid = '"><img src=x onerror="window.__xss=2">'
        evil_payload = {
            'digress': 1, 'exported': 1, 'cards': [], 'files': {},
            'conversations': [{
                'id': 'evil', 'title': 'Innocent title',
                'threads': {
                    'main': {'id': 'main', 'parent': None, 'title': 'Main thread', 'colorIdx': -1},
                    evil_tid: {'id': evil_tid, 'parent': 'main', 'anchorMsg': evil_mid, 'anchorText': 'hello', 'title': 'Side note', 'colorIdx': 0},
                },
                'msgs': {
                    evil_mid: {'id': evil_mid, 'role': 'assistant', 'thread': 'main', 'content': 'hello world'},
                    'u_e': {'id': 'u_e', 'role': 'user', 'thread': evil_tid, 'content': 'why?'},
                    'n_e': {'id': 'n_e', 'role': 'note', 'thread': 'main', 'fromThread': evil_tid, 'content': 'sum'},
                },
                'order': {'main': [evil_mid, 'n_e'], evil_tid: ['u_e']},
            }],
        }
        evil_tok = base64.urlsafe_b64encode(gzip.compress(json.dumps(evil_payload).encode())).decode().rstrip('=')
        before_evil = await pg.evaluate("__digress.convList.length")
        await pg.evaluate("h => { window.__xss = 0; location.hash = h; }", '#share=' + evil_tok)
        await pg.wait_for_selector('#modal.show')
        await pg.locator('#mOk').click()
        await soon(pg, "n => __digress.convList.length > n && __digress.conv.title === 'Innocent title'", before_evil, timeout=10000)
        await frames(pg, 4)
        evil_conv = await pg.evaluate("JSON.parse(JSON.stringify(__digress.conv))")
        check('imported adversarial thread/message IDs are remapped and never execute XSS',
              await pg.evaluate("window.__xss === 0")
              and all(k == 'main' or '<' not in k for k in evil_conv['threads'])
              and all('<' not in k for k in evil_conv['msgs']), evil_conv['threads'].keys())

        # security: even a pre-existing stored conversation with an adversarial thread ID renders as inert data
        pre_evil = evil_payload['conversations'][0]
        pre_evil['id'] = 'cx_evil_stored'
        pre_evil['title'] = 'Pre-existing evil'
        await pg.evaluate("c => { window.__xss2 = 0; localStorage.setItem('fakesrv:convs/cx_evil_stored', JSON.stringify(c)); }", pre_evil)
        await pg.reload(); await booted(pg)
        await pg.evaluate("document.querySelector('#clist .citem[data-conv=cx_evil_stored]').click()")
        await pg.wait_for_function("__digress.conv && __digress.conv.id === 'cx_evil_stored'")
        await pg.locator('#tree .mnode', has_text='Side note').first.click(); await frames(pg, 4)
        check('pre-existing stored adversarial thread ID renders inert in sidebar and panes',
              await pg.evaluate("!window.__xss && !window.__xss2 && document.querySelectorAll('#tree img[src=x], .pane img[src=x]').length === 0"))

        # security: cyclic parent graph in a #share= link is rejected cleanly without hanging the tab
        cyc_payload = {
            'digress': 1, 'exported': 1, 'cards': [], 'files': {},
            'conversations': [{
                'id': 'cyc', 'title': 'Loop',
                'threads': {
                    'main': {'id': 'main', 'parent': None, 'title': 'Main'},
                    'ta': {'id': 'ta', 'parent': 'tb', 'anchorMsg': 'mb', 'title': 'A'},
                    'tb': {'id': 'tb', 'parent': 'ta', 'anchorMsg': 'ma', 'title': 'B'},
                },
                'msgs': {
                    'ma': {'id': 'ma', 'role': 'assistant', 'thread': 'ta', 'content': 'a'},
                    'mb': {'id': 'mb', 'role': 'assistant', 'thread': 'tb', 'content': 'b'},
                },
                'order': {'main': [], 'ta': ['ma'], 'tb': ['mb']},
            }],
        }
        cyc_tok = base64.urlsafe_b64encode(gzip.compress(json.dumps(cyc_payload).encode())).decode().rstrip('=')
        before_cyc = await pg.evaluate("__digress.convList.length")
        await pg.evaluate("h => { location.hash = h; }", '#share=' + cyc_tok)
        check('cyclic parent graph in #share= link is rejected immediately without hanging',
              await soon(pg, "() => !location.hash.startsWith('#share=') && [...document.querySelectorAll('.toast')].some(t => /damaged/.test(t.textContent))", timeout=5000)
              and await pg.evaluate("__digress.convList.length") == before_cyc)

        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
