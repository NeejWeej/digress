"""Canvas views across two devices (two browser profiles, the real server, fake Claude Code).

Without views, each device's canvas is its own: moving cards on one doesn't move them on the other. A saved
view is shared: another device can load it (a copy: moving cards there changes neither the view nor the
first device), go back to its own arrangement with "This device", and Update the view on purpose.
Asserts and exits non-zero."""
import asyncio, json, os, shutil, sys, tempfile
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(__file__))
from common import OUT, launch_args
from test_server import start, req, CDN, FAKES

fails = []
def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what, '' if ok else str(detail)[:400])
    if not ok: fails.append(what)

async def main():
    tmp = tempfile.mkdtemp(); data = os.path.join(tmp, 'data')
    proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': data, 'FAKE_LOG': os.path.join(tmp, 'log')})
    stored = lambda cid: json.loads(req(base, 'GET', '/api/store/convs/' + cid)[1])
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args()); errs = []
            async def device():
                ctx = await b.new_context(viewport={'width': 1300, 'height': 850}); pg = await ctx.new_page()
                pg.on('pageerror', lambda e: errs.append(str(e)))
                async def route(r):
                    u = r.request.url
                    for k, v in CDN.items():
                        if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
                    if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                    await r.continue_()
                await pg.route('**/*', route); await pg.goto(base + '/'); await pg.wait_for_timeout(1500)
                return pg
            async def idle(pg):
                await pg.wait_for_timeout(300); await pg.wait_for_function("!Object.values(__digress.conv.msgs).some(m=>m.pending)", timeout=20000); await pg.wait_for_timeout(1000)
            pos = lambda pg, tid: pg.evaluate(f"(()=>{{const p=(__digress.conv.ui.cv||{{}}).pos||{{}};return p['{tid}']?[Math.round(p['{tid}'].x),Math.round(p['{tid}'].y)]:null}})()")
            async def drag(pg, tid, dx, dy):
                h = pg.locator(f'#cv .cnode[data-ctid="{tid}"] .ch .ct'); bb = await h.bounding_box()
                await pg.mouse.move(bb['x'] + 10, bb['y'] + 5); await pg.mouse.down()
                for i in range(1, 9): await pg.mouse.move(bb['x'] + 10 + dx * i / 8, bb['y'] + 5 + dy * i / 8)
                await pg.mouse.up(); await pg.wait_for_timeout(1200)
            back = lambda pg: pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            canvas = lambda pg: pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()")
            menu = lambda pg: pg.locator('#cvViews')

            A = await device()
            ta = A.locator('.pane[data-tid="main"] textarea'); await ta.fill('Explain gradients'); await ta.press('Enter'); await idle(A)
            await A.locator('.pane[data-tid="main"] [data-act="wbranch"]').first.click(); await A.wait_for_timeout(600)
            tid = await A.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
            bt = A.locator(f'.pane[data-tid="{tid}"] textarea'); await bt.fill('And in two dimensions?'); await bt.press('Enter'); await idle(A)
            cid = await A.evaluate('__digress.conv.id')
            await canvas(A); await A.wait_for_timeout(1000)
            await drag(A, tid, 260, 140)
            a_pos = await pos(A, tid)
            check(a_pos is not None, 'A moved the branch card', a_pos)

            # B, without views: its own canvas; moving cards there doesn't move A's
            B = await device()
            await B.locator(f'[data-conv="{cid}"]').first.click(); await B.wait_for_timeout(1200)
            await canvas(B); await B.wait_for_timeout(1000)
            await drag(B, tid, -200, 220)
            b_pos = await pos(B, tid)
            await back(A); await A.wait_for_timeout(1200)
            check(await pos(A, tid) == a_pos and b_pos != a_pos, 'without views, each device keeps its own canvas', [a_pos, b_pos])

            # A saves a view
            await A.locator('#zViews').click(); await A.wait_for_timeout(200)
            await menu(A).locator('form[data-vnew] input').fill('Reading setup'); await menu(A).locator('form[data-vnew] input').press('Enter'); await A.wait_for_timeout(1500)
            check('Reading setup' in await A.locator('#zViews').inner_text(), 'A saves its arrangement as a view, and the button names it')
            views = stored(cid).get('views') or {}
            vid = next(iter(views), None)
            check(vid and views[vid]['name'] == 'Reading setup' and [round(views[vid]['cv']['pos'][tid]['x']), round(views[vid]['cv']['pos'][tid]['y'])] == a_pos, 'the view is saved with the conversation, with A’s positions', views)

            # B loads it: a copy
            await back(B); await B.wait_for_timeout(1200)
            await B.locator('#zViews').click(); await B.wait_for_timeout(200)
            await B.screenshot(path=OUT + '/views_menu.png')
            items = await menu(B).locator('.vrow').all_inner_texts()
            check(any('This device' in i for i in items) and any('Reading setup' in i for i in items), 'B’s Views menu lists This device and A’s view', items)
            await menu(B).locator(f'[data-vuse="{vid}"]').click(); await B.wait_for_timeout(800)
            check(await pos(B, tid) == a_pos, 'loading the view lays B’s canvas out like A’s', [await pos(B, tid), a_pos])
            await B.screenshot(path=OUT + '/views_loaded.png')
            await drag(B, tid, 120, -60)
            moved = await pos(B, tid)
            v = stored(cid)['views'][vid]['cv']['pos'][tid]
            check(moved != a_pos and [round(v['x']), round(v['y'])] == a_pos, 'moving cards after loading changes only B, not the view', [moved, v])
            await back(A); await A.wait_for_timeout(1200)
            check(await pos(A, tid) == a_pos, '…and not A')

            # This device: back to B's own
            await B.locator('#zViews').click(); await B.wait_for_timeout(200)
            await menu(B).locator('[data-vuse=""]').click(); await B.wait_for_timeout(800)
            check(await pos(B, tid) == b_pos and 'Views' in await B.locator('#zViews').inner_text(), 'This device goes back to B’s own arrangement', [await pos(B, tid), b_pos])

            # Update, on purpose
            await B.locator('#zViews').click(); await menu(B).locator(f'[data-vuse="{vid}"]').click(); await B.wait_for_timeout(600)
            await drag(B, tid, 90, 90); upd = await pos(B, tid)
            await B.locator('#zViews').click(); await menu(B).locator(f'[data-vupd="{vid}"]').click(); await B.wait_for_timeout(1500)
            v = stored(cid)['views'][vid]['cv']['pos'][tid]
            check([round(v['x']), round(v['y'])] == upd, 'Update saves B’s canvas into the view', [v, upd])
            await back(A); await A.wait_for_timeout(1200)
            check(await pos(A, tid) == a_pos, 'A’s canvas doesn’t jump when the view changes; it gets it by loading it again')
            await A.locator('#zViews').click(); await menu(A).locator(f'[data-vuse="{vid}"]').click(); await A.wait_for_timeout(800)
            check(await pos(A, tid) == upd, '…which it does')

            # rename and delete
            await A.locator('#zViews').click(); await menu(A).locator(f'[data-vedit="{vid}"]').click()
            await menu(A).locator('form[data-vren] input').fill('Deep dive'); await menu(A).locator('form[data-vren] input').press('Enter'); await A.wait_for_timeout(1200)
            check(stored(cid)['views'][vid]['name'] == 'Deep dive', 'rename')
            await menu(A).locator(f'[data-vdel="{vid}"]').click(); await A.locator('#mOk').click(); await A.wait_for_timeout(1200)
            check(not stored(cid).get('views') and 'Views' in await A.locator('#zViews').inner_text(), 'delete')
            check(not errs, 'no page errors', errs[:3])
            await b.close()
    finally:
        proc.terminate(); shutil.rmtree(tmp, ignore_errors=True)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
