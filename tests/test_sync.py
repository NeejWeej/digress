"""Two devices on one conversation (two browser profiles, the real server, fake Claude Code).

  - Switching devices: what one added shows on the other when its tab comes back, without a reload, and the
    other keeps its own layout (view, open panes) and where it was scrolled.
  - Both asked something without seeing the other's: neither is lost; the later one becomes another version.
  - Deleted on one device while the other still has it open: the other's new question is kept as a copy.
  - A reply carries on when its page goes to another conversation, reloads, or loses its connection, and
    one that nobody came back to in time is saved as cut off, with Continue.
Asserts and exits non-zero."""
import asyncio, json, os, shutil, sys, tempfile
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(__file__))
from common import OUT, launch_args
from test_server import start, req, CDN, FAKES

fails = []
def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what, '' if ok else str(detail)[:500])
    if not ok: fails.append(what)

async def main():
    tmp = tempfile.mkdtemp(); data = os.path.join(tmp, 'data'); log = os.path.join(tmp, 'claude.log')
    proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': data, 'FAKE_LOG': log, 'RUN_DETACH_MS': '2500'})
    convs = lambda: {d['id']: d['data'] for d in json.loads(req(base, 'GET', '/api/store/convs')[1])}
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args()); errs = []
            async def device(w=1400):
                ctx = await b.new_context(viewport={'width': w, 'height': 900}); pg = await ctx.new_page()
                pg.on('pageerror', lambda e: errs.append(str(e)))
                async def route(r):
                    u = r.request.url
                    for k, v in CDN.items():
                        if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
                    if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                    await r.continue_()
                await pg.route('**/*', route); await pg.goto(base + '/'); await pg.wait_for_timeout(1500)
                return pg
            async def ask(pg, q, tid='main', wait=True):
                ta = pg.locator(f'.pane[data-tid="{tid}"] textarea'); await ta.fill(q); await ta.press('Enter')
                if wait: await idle(pg)
            async def idle(pg, t=25000):   # no reply being written
                await pg.wait_for_timeout(300)
                await pg.wait_for_function("!Object.values(__digress.conv.msgs).some(m=>m.pending)", timeout=t); await pg.wait_for_timeout(1000)
            back = lambda pg: pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))")   # the tab comes back
            texts = lambda pg, tid='main': pg.locator(f'.pane[data-tid="{tid}"] .msg.user').all_text_contents()

            A = await device()
            await ask(A, 'Question one from A')
            cid = await A.evaluate('__digress.conv.id')
            B = await device(900)
            await B.locator(f'[data-conv="{cid}"]').first.click(); await B.wait_for_timeout(1200)
            check(any('Question one from A' in t for t in await texts(B)), 'device B opens the conversation A made')

            # A goes to the canvas; B stays on panes. B asks; A comes back to its tab.
            await A.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await A.wait_for_timeout(800)
            await ask(B, 'Question two from B')
            await back(A); await A.wait_for_timeout(1500)
            card = await A.locator('#cv .cnode[data-ctid="main"]').inner_text()
            check('Question two from B' in card, 'A, coming back, shows what B asked without a reload', card[-300:])
            check(await A.evaluate('__digress.conv.ui.view') == 'canvas' and await B.evaluate('__digress.conv.ui.view') == 'panes', 'each device keeps its own view')
            await A.evaluate("document.querySelector('#viewSeg button[data-v=cols]').click()"); await A.wait_for_timeout(600)

            # A scrolled up; B adds; A catches up: A stays where it was
            for i in range(3): await ask(A, f'Filler {i} ' + 'long question text ' * 20)
            await back(B); await B.wait_for_timeout(1200)
            await A.evaluate("document.querySelector('.pane[data-tid=main] .pb').scrollTop=200"); await A.wait_for_timeout(300)
            await ask(B, 'Question three from B')
            await back(A); await A.wait_for_timeout(1500)
            st = await A.evaluate("document.querySelector('.pane[data-tid=main] .pb').scrollTop")
            check(any('Question three from B' in t for t in await texts(A)) and abs(st - 200) < 5, f'A shows B’s new question and stays scrolled where it was ({st})')

            # both ask without seeing each other's: the later save merges, and its question becomes another version
            await ask(A, 'Concurrent from A')
            await ask(B, 'Concurrent from B')   # B hasn't caught up: its save is refused, merged, saved again
            d = convs()[cid]
            users = [m['content'] for m in d['msgs'].values() if m['role'] == 'user']
            alts = [t for t in d['threads'].values() if t.get('alt')]
            main_q = [d['msgs'][i]['content'] for i in d['order']['main'] if d['msgs'][i]['role'] == 'user']
            check('Concurrent from A' in users and 'Concurrent from B' in users, 'both devices’ questions are kept', users)
            check(main_q[-1] == 'Concurrent from A' and any(d['msgs'][d['order'][t['id']][0]]['content'] == 'Concurrent from B' for t in alts),
                  'A’s (saved first) goes on in the main thread; B’s is another version from the same point', [main_q[-2:], alts])
            check(await B.locator('.vchip').count() >= 1, 'B shows the versions chip on its question')
            await back(A); await A.wait_for_timeout(1500)
            check(await A.locator('.pane[data-tid="main"] .vchip').count() >= 1, 'A sees it too once it catches up')
            await B.screenshot(path=OUT + '/sync_versions.png')

            # a reply carries on when its page goes elsewhere, and is there on return
            await ask(A, 'SLOWISH one', wait=False); await A.wait_for_timeout(700)
            await A.locator('#newConv').click(); await A.wait_for_timeout(4500)
            d = convs()[cid]; last = d['msgs'][d['order']['main'][-1]]
            check(last['content'] == 'tick ' * 30 and 'run' not in last, 'a reply finished while its page was on another conversation is saved', last)
            await A.locator(f'[data-conv="{cid}"]').first.click(); await A.wait_for_timeout(1200)
            body = await A.locator('.pane[data-tid="main"] .msg.assistant .body').last.inner_text()
            check(body.strip().startswith('tick tick') and body.count('tick') == 30, 'and it’s there on coming back', body[:120])

            # …and survives a reload in the middle
            await ask(A, 'SLOWMID two', wait=False); await A.wait_for_timeout(900)
            await A.reload(); await A.wait_for_timeout(1500)
            check(await A.evaluate("(()=>{const c=__digress.conv,m=c.msgs[c.order.main.at(-1)];return !!(m.pending&&m.run)})()"), 'after a reload mid-reply, it reconnects and is still writing')
            await idle(A)
            body = await A.locator('.pane[data-tid="main"] .msg.assistant .body').last.inner_text()
            check(body.count('tick') == 80 and 'error' not in body.lower(), 'the whole reply, once, after the reload', [body.count('tick'), body[-200:]])

            # …and a dropped connection (the server is still there): reconnects and finishes
            await ask(A, 'SLOWISH three', wait=False); await A.wait_for_timeout(900)
            await A.context.set_offline(True); await A.wait_for_timeout(1200); await A.context.set_offline(False)
            await idle(A)
            body = await A.locator('.pane[data-tid="main"] .msg.assistant .body').last.inner_text()
            check(body.count('tick') == 30, 'after the network drops for a moment, the reply finishes', [body.count('tick'), body[-200:]])

            # nobody comes back in time: cut off, kept, with Continue
            await ask(A, 'SLOW and long', wait=False); await A.wait_for_timeout(1000)
            await A.close(); await asyncio.sleep(4)
            A = await device(); await A.locator(f'[data-conv="{cid}"]').first.click(); await A.wait_for_timeout(1500)
            last = A.locator('.pane[data-tid="main"] .msg.assistant').last
            check(await last.locator('[data-act="continue"]').count() == 1 and 'Cut off' in await last.inner_text(), 'a reply nobody came back to is saved as cut off, with Continue', (await last.inner_text())[-300:])
            before = (await last.locator('.body').inner_text()).count('tick')
            # Continue asks again from where it stopped (the fake doesn't know it's a continuation: it just answers)
            await A.evaluate("PROMPTS.continueCut='Carry on, SLOWISH.'")
            await last.locator('[data-act="continue"]').click(); await idle(A)
            last = A.locator('.pane[data-tid="main"] .msg.assistant').last
            after = (await last.locator('.body').inner_text()).count('tick')
            check(after == before + 30 and await last.locator('[data-act="continue"]').count() == 0, f'Continue adds on to what was there ({before} → {after})')

            # deleted on one device while the other has it open: the other's new question is kept, as a copy
            await back(B); await B.wait_for_timeout(1000)
            await A.evaluate(f"__digress.deleteConv('{cid}')"); await A.wait_for_timeout(800)
            await ask(B, 'Asked after A deleted it', wait=False); await B.wait_for_timeout(4000)
            all_ = convs()
            copies = [c for c in all_.values() if '(from this device)' in c.get('title', '')]
            check(cid not in all_ and copies and any(m['content'] == 'Asked after A deleted it' for m in copies[0]['msgs'].values()), 'a conversation deleted elsewhere isn’t brought back; what B asked is kept as a copy', [c.get('title') for c in all_.values()])
            check(not errs, 'no page errors', errs[:3])
            await b.close()
    finally:
        proc.terminate(); shutil.rmtree(tmp, ignore_errors=True)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
