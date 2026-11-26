"""The trash, and deleting a conversation without taking another one's document with it.
  Page (the in-page fake server):
  - The sidebar's delete moves a conversation to Trash (no question asked; the toast's Undo brings it back). The open
    one is swapped for the next conversation. In Trash: days left, Restore, and Delete for good (asks first, says
    the flashcards stay).
  - Search leaves out what's in the trash; startup doesn't open it.
  - Deleting a conversation for good leaves its document's file alone: another conversation may use it.
  Real server:
  - At startup a conversation trashed more than TRASH_DAYS ago is deleted, with its layout and search index, and so
    is a file nothing else uses; one another conversation uses stays. A recently trashed one stays.
  - DELETE of a conversation keeps a file another conversation uses.
Asserts and exits non-zero."""
import asyncio, json, os, sys, tempfile, time
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, saved, frames, new_conv, soon, settle
from common import CORS
from test_server import start, req

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out='Bayes says to weigh the prior by the likelihood.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

C = "__digress.conv"
rows = lambda pg, box: pg.evaluate(f"[...document.querySelectorAll('#{box} .citem[data-conv]')].map(r=>r.dataset.conv)")

async def page_part(p):
    b = await p.chromium.launch(**launch_args())
    pg = await b.new_page(viewport={'width': 1400, 'height': 860})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    async def route(r):
        u = r.request.url
        for k, v in MAP.items():
            if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
        if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
        await r.continue_()
    await pg.route('**/*', route); await pg.add_init_script(FAKE)
    await goto_app(pg); await booted(pg)
    ids = []
    for q in ['What is a prior?', 'Why do zebras have stripes?']:
        if ids: await new_conv(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter')); await saved(pg)
        ids.append(await pg.evaluate(f"{C}.id"))
    a, bb = ids
    await soon(pg, f"() => document.querySelectorAll('#clist .citem[data-conv]').length + document.querySelectorAll('#plist .citem[data-conv]').length >= 2")

    # trash the open one
    await pg.locator(f'#clist .citem[data-conv="{bb}"]').hover()
    await pg.locator(f'#clist .citem[data-conv="{bb}"] [data-del]').click()
    await soon(pg, f"() => __digress.conv.id === '{a}'")
    check('delete moves the open conversation to the trash, no question asked, and opens the next one', await pg.locator('#modal.show').count() == 0 and await pg.evaluate(f"{C}.id") == a)
    check('…it shows under Trash, not in the list', bb in await rows(pg, 'xlist') and bb not in await rows(pg, 'clist'), [await rows(pg, 'xlist'), await rows(pg, 'clist')])
    check('…saved as trashed', await pg.evaluate(f"JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith('convs/{bb}')))).trashed > 0"))
    check('…the toast offers Undo', 'Moved to the trash' in await pg.locator('#toast').inner_text() and await pg.locator('#toast .tact').inner_text() == 'Undo')
    await pg.locator('#toast .tact').click()
    await soon(pg, f"() => [...document.querySelectorAll('#clist .citem[data-conv]')].some(r=>r.dataset.conv==='{bb}')")
    check('Undo brings it back', bb not in await rows(pg, 'xlist'))

    # trash the other one (not open): Restore from the Trash section
    await pg.locator(f'#clist .citem[data-conv="{bb}"]').hover(); await pg.locator(f'#clist .citem[data-conv="{bb}"] [data-del]').click()
    await soon(pg, f"() => [...document.querySelectorAll('#xlist .citem')].some(r=>r.dataset.conv==='{bb}')")
    await pg.locator('#trashToggle').click(); await frames(pg)
    left = await pg.locator(f'#xlist .citem[data-conv="{bb}"] .xleft').inner_text()
    check('Trash says how long is left', left == '7 days left', left)
    await pg.screenshot(path=OUT + '/trash.png')
    # search leaves it out
    await pg.keyboard.press('ControlOrMeta+k'); await pg.locator('#palIn').fill('zebras'); await settle(pg, 600)
    res = await pg.evaluate("[...document.querySelectorAll('#palRes [data-i]')].map(r=>r.className+': '+r.textContent.slice(0,60))")
    await pg.locator('#palIn').fill(''); await settle(pg, 300)
    recents = await pg.locator('#palRes').inner_text()
    check('search leaves out what’s in the trash', not any('zebra' in r.lower() and 'describe' not in r.lower() for r in res) and 'zebras' not in recents.lower(), [res, recents[:200]])
    await pg.keyboard.press('Escape')
    await pg.locator(f'#xlist .citem[data-conv="{bb}"]').hover(); await pg.locator(f'#xlist .citem[data-conv="{bb}"] [data-restore]').click()
    await soon(pg, f"() => [...document.querySelectorAll('#clist .citem')].some(r=>r.dataset.conv==='{bb}')")
    check('Restore moves it back', bb not in await rows(pg, 'xlist'))

    # delete for good, from the trash
    await pg.locator(f'#clist .citem[data-conv="{bb}"]').hover(); await pg.locator(f'#clist .citem[data-conv="{bb}"] [data-del]').click()
    await soon(pg, f"() => [...document.querySelectorAll('#xlist .citem')].some(r=>r.dataset.conv==='{bb}')")
    await pg.locator(f'#xlist .citem[data-conv="{bb}"]').hover(); await pg.locator(f'#xlist .citem[data-conv="{bb}"] [data-delnow]').click()
    check('Delete for good asks first', await pg.locator('#modal.show').count() == 1 and 'can’t be undone' in await pg.locator('#mBody').inner_text())
    await pg.locator('#mOk').click()
    await soon(pg, f"() => !Object.keys(localStorage).some(k=>k.endsWith('convs/{bb}'))")
    check('…and then it’s gone', bb not in await rows(pg, 'xlist') + await rows(pg, 'clist'))

    # a document's file stays when another conversation uses it
    await pg.locator('#newDoc').click(); await pg.locator('#docPaste').fill('# Priors\n\nA prior is what you believe before the evidence.')
    await pg.locator('#docGo').click(); await pg.locator('.pane[data-tid=doc]').wait_for(); await saved(pg)
    did, asset = await pg.evaluate(f"[{C}.id,{C}.doc.assetId]")
    await pg.locator('.pane[data-tid=doc] .ph [data-act=newfromdoc]').click(); await soon(pg, f"() => __digress.conv.id !== '{did}'"); await saved(pg)
    async def trash_and_ask(cid):
        await pg.evaluate("document.getElementById('toast').textContent=''")
        await pg.locator(f'.citem[data-conv="{cid}"]').first.hover(); await pg.locator(f'.citem[data-conv="{cid}"] [data-del]').first.click()
        await soon(pg, f"() => [...document.querySelectorAll('#xlist .citem')].some(r=>r.dataset.conv==='{cid}')")
        await soon(pg, "() => document.getElementById('toast').textContent.includes('Moved to the trash')")
        t = await pg.locator('#toast').inner_text()
        await pg.locator(f'#xlist .citem[data-conv="{cid}"]').hover(); await pg.locator(f'#xlist .citem[data-conv="{cid}"] [data-delnow]').click()
        await pg.locator('#modal.show').wait_for()
        return t, await pg.locator('#mBody').inner_text()
    t, body = await trash_and_ask(did)
    check('trashing one whose document another conversation uses doesn’t say the document goes', 'with its document' not in t, t)
    check('Delete for good says the document stays when another conversation uses it', 'Priors' in body and 'stays' in body and 'deleted too' not in body, body)
    await pg.locator('#mOk').click(); await soon(pg, f"() => !Object.keys(localStorage).some(k=>k.endsWith('convs/{did}'))")
    check('…and leaves its file', await pg.evaluate(f"Object.keys(localStorage).some(k=>k.endsWith('file/{asset}'))"), asset)
    nid = await pg.evaluate(f"{C}.id")
    t, body = await trash_and_ask(nid)
    check('trashing the last conversation on a document says the document goes with it', 'with its document “Priors”' in t, t)
    check('Delete for good warns when the document is deleted too (no other conversation uses it)', 'Its document, Priors, is deleted too' in body, body)
    await pg.screenshot(path=OUT + '/trash_doc_warning.png')
    await pg.keyboard.press('Escape'); await frames(pg)

    # startup doesn't open a trashed conversation
    await pg.reload(); await booted(pg); await settle(pg, 800)
    check('startup doesn’t open what’s in the trash', await pg.evaluate(f"{C}.id") != nid)
    check('no page errors', not errs, errs[:3])
    await b.close()

def server_part():
    tmp = tempfile.mkdtemp(prefix='digress-trash-'); data = os.path.join(tmp, 'data')
    for d in ['convs', 'files', 'layouts', 'index']: os.makedirs(os.path.join(data, d))
    now = int(time.time() * 1000); day = 864e5
    X, Y, Z = 'a' * 32, 'b' * 32, 'c' * 32
    def conv(id, trashed=0, asset=None):
        c = {'id': id, 'title': id, 'created': now, 'updated': now, 'rev': 1, 'threads': {'main': {'id': 'main', 'parent': None}}, 'msgs': {}, 'order': {'main': []}}
        if trashed: c['trashed'] = trashed
        if asset: c['doc'] = {'kind': 'pdf', 'name': id, 'assetId': asset}
        json.dump(c, open(os.path.join(data, 'convs', id + '.json'), 'w'), separators=(',', ':'))   # as the app writes them
        json.dump({'id': id, 'e': []}, open(os.path.join(data, 'index', id + '.json'), 'w'))
        json.dump({'devices': {}}, open(os.path.join(data, 'layouts', id + '.json'), 'w'))
    for f in [X, Y, Z]:
        open(os.path.join(data, 'files', f), 'wb').write(b'%PDF-1.4')
        json.dump({'type': 'application/pdf', 'created': now - 2 * day}, open(os.path.join(data, 'files', f + '.meta.json'), 'w'))
    conv('old1', now - 8 * day, X); conv('keep', 0, X); conv('old2', now - 8 * day, Y); conv('recent', now - 1 * day, Z)
    conv('gone', 0, Z)
    proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': '/nonexistent/claude'})
    try:
        ex = lambda *p: os.path.exists(os.path.join(data, *p))
        has_conv = lambda cid: req(base, 'GET', f'/api/store/convs/{cid}')[0] == 200
        has_idx = lambda cid: req(base, 'GET', f'/api/store/index/{cid}')[0] == 200
        for _ in range(50):
            if not has_conv('old1') and not has_conv('old2') and not ex('files', Y): break   # (the file goes a moment after its conversation)
            time.sleep(0.1)
        check('server: legacy JSON folders migrated to SQLite with backup', ex('digress.db') and ex('_legacy_json', 'convs'))
        check('server: trashed over 7 days ago is deleted at startup, with its layout and search index', not has_conv('old1') and not has_idx('old1') and not has_conv('old2'))
        check('server: …its file goes when nothing else uses it', not ex('files', Y))
        check('server: …and stays when another conversation uses it', ex('files', X))
        check('server: recently trashed stays, with its file', has_conv('recent') and ex('files', Z))
        st, _ = req(base, 'DELETE', '/api/store/convs/gone')
        check('server: deleting a conversation keeps a file another (trashed) one still uses', st == 200 and ex('files', Z) and not has_idx('gone'))
    finally:
        proc.kill()

async def main():
    server_part()
    async with async_playwright() as p:
        await page_part(p)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
