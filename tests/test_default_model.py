"""The default model is a preference you set in the app, shared by your devices (the real server, fake Claude
Code, two browser profiles): pick a model, click the star beside the picker, and "Default" means that model
on every device, for every reply that asks for Default. Asserts and exits non-zero."""
import asyncio, json, os, shutil, sys, tempfile
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(__file__))
from common import saved, quiet, OUT, launch_args, booted, answered, BOOT_WATCH
from common import CORS
from test_server import start, req, CDN, FAKES

fails = []
def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what, '' if ok else str(detail)[:400])
    if not ok: fails.append(what)

async def main():
    tmp = tempfile.mkdtemp(); data = os.path.join(tmp, 'data'); log = os.path.join(tmp, 'claude.log'); open(log, 'w').close()
    proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': data, 'FAKE_LOG': log})
    models = lambda: json.loads(req(base, 'GET', '/api/models')[1])
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args()); errs = []
            async def device():
                ctx = await b.new_context(viewport={'width': 1400, 'height': 850}); pg = await ctx.new_page()
                pg.on('pageerror', lambda e: errs.append(str(e)))
                async def route(r):
                    u = r.request.url
                    for k, v in CDN.items():
                        if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
                    if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                    await r.continue_()
                await pg.route('**/*', route); await pg.add_init_script(BOOT_WATCH); await pg.goto(base + '/'); await booted(pg)
                await pg.wait_for_function("document.querySelector('#mSel option[value=auto]')?.textContent.includes('(')")
                return pg
            label = lambda pg: pg.evaluate("(s=>[s.value,s.selectedOptions[0].textContent])(document.getElementById('mSel'))")
            star = lambda pg: pg.locator('#mDef')

            A = await device()
            v, l = await label(A); built_in = models()['default']
            check(v == 'auto' and 'Opus' in l and not await star(A).is_visible(), 'at first “Default” is the built-in model, and there’s no star', [v, l])
            await A.locator('#mSel').select_option('claude-sonnet-5-5')
            check(await star(A).is_visible() and 'Sonnet' in (await star(A).get_attribute('title') or await star(A).get_attribute('data-tip') or ''), 'picking another model shows a star to make it the default')
            await star(A).click()
            await A.wait_for_function("document.querySelector('#mSel').value==='auto'&&document.querySelector('#mSel').selectedOptions[0].textContent.includes('Sonnet')")
            v, l = await label(A)
            check(v == 'auto' and l == 'Default (Sonnet 5.5)' and not await star(A).is_visible(), 'the star makes it the default; the picker follows Default again', [v, l])
            m = models()
            check(m['default'] == 'claude-sonnet-5-5' and m['chosen'] == 'claude-sonnet-5-5' and json.load(open(os.path.join(data, 'prefs.json')))['defaultModel'] == 'claude-sonnet-5-5', 'the server keeps it', m)

            ta = A.locator('.pane[data-tid=main] textarea'); await ta.fill('Which model answers?'); await answered(A, ta.press('Enter'))
            calls = [json.loads(x) for x in open(log).read().splitlines() if x.startswith('{') and '"model"' in x]
            check(calls and calls[-1]['model'] == 'claude-sonnet-5-5', 'a reply asking for Default goes to the new default', calls[-1:] and calls[-1]['model'])

            B = await device()
            auto = lambda pg: pg.evaluate("document.querySelector('#mSel option[value=auto]').textContent")
            v, l = await label(B)
            check(await auto(B) == 'Default (Sonnet 5.5)', 'another device sees the same default', await auto(B))
            check(v == 'claude-sonnet-5-5', '…and the conversation started with it shows the model it started with, by name', [v, l])
            await saved(A); await quiet(A)   # not in the middle of a save or a check: WebKit reports a request cut off by the reload as a page error
            await A.reload(); await booted(A)   # BOOT_WATCH is an init script, so it runs again
            await A.wait_for_function("document.querySelector('#mSel option[value=auto]')?.textContent.includes('(')")
            check(await auto(A) == 'Default (Sonnet 5.5)' and (await label(A))[0] == 'claude-sonnet-5-5', 'and it lasts across reloads', [await auto(A), await label(A)])

            # changing it on B reaches A when A's tab comes back
            await B.locator('#mSel').select_option('claude-haiku-5-5'); await star(B).click()
            await B.wait_for_function("document.querySelector('#mSel').selectedOptions[0].textContent.includes('Haiku')")
            await A.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            await A.wait_for_function("document.querySelector('#mSel option[value=auto]').textContent.includes('Haiku')", timeout=10000)
            check(True, 'a change on one device shows on another when its tab comes back')
            code = req(base, 'PUT', '/api/prefs', {'defaultModel': 'not-a-model'})[0]
            check(code == 400, 'the server refuses a model no provider offers', code)
            req(base, 'PUT', '/api/prefs', {'defaultModel': None})
            check(models()['default'] == built_in, 'clearing it goes back to the built-in default')
            await A.screenshot(path=OUT + '/default_model.png')
            check(not errs, 'no page errors', errs[:3])
            await b.close()
    finally:
        proc.terminate(); shutil.rmtree(tmp, ignore_errors=True)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
