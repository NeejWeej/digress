"""Leaving (closing, reloading) with a save pending: an edit followed at once by a reload used to be lost, on the real
server (the request started at pagehide is dropped as the page goes) and in the demo (its IndexedDB write never ran).
Now `beforeunload` starts the save and asks the browser to show its leave dialog (app.js `unsaved`, `leaveWatch`):
  - real server, Leave: the rename is saved anyway (the save started before the dialog);
  - Stay (real and demo): a toast says when it's safe to close, and a reload then keeps the rename;
  - nothing pending: no dialog.
Demo + Leave at once is a known loss (its store only writes once the page runs on): not asserted.
Asserts and exits non-zero."""
import asyncio, json, os, shutil, sys, tempfile
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(__file__))
from common import BOOT_WATCH, CORS, PDF_DRAWN_JS, booted, build_site, goto_site, launch_args, poll, quiet, saved, soon
from test_server import start, req, CDN

fails = []
def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what, '' if ok else str(detail)[:400])
    if not ok: fails.append(what)

TITLE = "id => (document.querySelector(`#side [data-conv='${id}'] .t`) || {}).innerText"
STORED = "id => fetch('api/store/convs/' + id).then(r => r.json()).then(c => c.title)"
TOAST = "()=>/safe to close or reload/.test((document.querySelector('#toast')||{}).textContent||'')"


def watch_dialogs(pg, accept):
    """Every dialog is answered at once (accept = Leave, else Stay) and noted."""
    seen = []
    async def on(d):
        seen.append(d.type)
        await (d.accept() if accept else d.dismiss())
    pg.on('dialog', lambda d: asyncio.ensure_future(on(d)))
    return seen


async def rename(pg, to):
    """Rename the open conversation through its sidebar row; -> its id. Returns right after Enter."""
    row = pg.locator('#side .citem.cur[data-conv]').first
    cid = await row.get_attribute('data-conv')
    await row.locator('.t').dblclick(position={'x': 4, 'y': 4})
    await soon(pg, "() => !!document.querySelector('#side .citem.cur .t[contenteditable]')")
    await pg.keyboard.press('Control+a'); await pg.keyboard.type(to); await pg.keyboard.press('Enter')
    return cid


async def ready(pg):
    await booted(pg)
    if await pg.evaluate("!!(__digress.conv && __digress.conv.doc && __digress.conv.doc.kind === 'pdf')"): await pg.wait_for_function(PDF_DRAWN_JS)
    await saved(pg)


async def stay_and_quiet(open_page, new_ctx, label):
    """Stay: the rename is saved while the dialog is up, a toast says so, a reload keeps it; with nothing pending, no dialog."""
    ctx = await new_ctx(); pg = await open_page(ctx); await ready(pg)
    dialogs = watch_dialogs(pg, accept=False)
    cid = await rename(pg, f'{label} stayed')
    await pg.evaluate("location.reload()")   # at once: the save hasn't started yet (it waits 0.7 s)
    check(await soon(pg, TOAST, timeout=20000), f'{label}: staying, a toast says it is safe to close once saved', dialogs)
    check(dialogs == ['beforeunload'], f'{label}: the browser asked once', dialogs)
    check(await pg.evaluate(STORED, cid) == f'{label} stayed', f'{label}: the rename reached the store', await pg.evaluate(STORED, cid))
    await quiet(pg)
    await pg.reload(); await ready(pg)
    check(await pg.evaluate(TITLE, cid) == f'{label} stayed' and dialogs == ['beforeunload'], f'{label}: a reload then keeps the rename, with no dialog', [await pg.evaluate(TITLE, cid), dialogs])
    await rename(pg, f'{label} quiet'); await saved(pg); await quiet(pg)
    await pg.reload(); await ready(pg)
    check(await pg.evaluate(TITLE, cid) == f'{label} quiet' and dialogs == ['beforeunload'], f'{label}: with nothing pending a reload shows no dialog', [await pg.evaluate(TITLE, cid), dialogs])
    await ctx.close()


async def main():
    tmp = tempfile.mkdtemp()
    proc, base = start({'DATA_DIR': os.path.join(tmp, 'data')})
    site = os.path.join(tmp, 'site'); build_site(site)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            errs = []
            st, _ = req(base, 'PUT', '/api/store/convs/leave1', {'id': 'leave1', 'title': 'Leave test', 'created': 1, 'updated': 1, 'nextColor': 0,
                'threads': {'main': {'id': 'main', 'parent': None, 'title': 'Main thread', 'colorIdx': -1}},
                'msgs': {'m1': {'id': 'm1', 'thread': 'main', 'role': 'user', 'content': 'Hello'}}, 'order': {'main': ['m1']}})
            check(st == 200, 'the real server took a seeded conversation', st)
            async def new_ctx(): return await b.new_context(viewport={'width': 1400, 'height': 900})
            async def open_real(ctx, errs=errs):
                pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
                async def route(r):
                    u = r.request.url
                    for k, v in CDN.items():
                        if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
                    if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                    await r.continue_()
                await pg.route('**/*', route); await pg.add_init_script(BOOT_WATCH)
                await pg.goto(base); return pg
            async def open_demo(ctx):
                pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
                await goto_site(pg, site); return pg

            # Leave: the save started before the dialog, so the rename lands anyway
            ctx = await new_ctx(); pg = await open_real(ctx, errs=[]); await ready(pg)   # (leaving with the save in flight: WebKit calls the request it cuts off an error)
            dialogs = watch_dialogs(pg, accept=True)
            cid = await rename(pg, 'Real left')
            await pg.evaluate("location.reload()")
            def stored():
                st, body = req(base, 'GET', f'/api/store/convs/{cid}')
                return json.loads(body).get('title') if st == 200 else None
            check(await poll(lambda: stored() == 'Real left'), 'real server: leaving anyway, the rename is saved', stored())
            check(dialogs == ['beforeunload'], 'real server: reloading right after a rename asks first', dialogs)
            check(await soon(pg, "id => (document.querySelector(`#side [data-conv='${id}'] .t`) || {}).innerText === 'Real left'", cid, timeout=15000), 'real server: …and the page shows it after the reload')
            await ctx.close()

            await stay_and_quiet(open_real, new_ctx, 'real server')
            await stay_and_quiet(open_demo, new_ctx, 'demo')
            await b.close()
            check(not errs, 'no page errors', errs[:3])
    finally:
        proc.terminate(); shutil.rmtree(tmp, ignore_errors=True)
    print('\n' + (f'{len(fails)} failed: {fails}' if fails else 'all passed'))
    sys.exit(1 if fails else 0)


asyncio.run(main())
