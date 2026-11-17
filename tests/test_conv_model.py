"""Each conversation keeps the model and effort it started with (the real server, fake Claude Code, two browser
profiles), so a reload, another conversation or another device never switches it.
  - The first question keeps the picker's model in the conversation (the actual model, even when it says Default);
    changing the picker or the effort while it's open changes it. Web is not kept.
  - A new conversation starts at Default; opening the first one again puts the picker back to its model and effort,
    after a reload too, and on another device. A change on one device reaches the other.
  - A model that isn't offered right now leaves the picker on Default and says so, without forgetting it.
Asserts and exits non-zero."""
import asyncio, json, os, shutil, sys, tempfile
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(__file__))
from common import OUT, launch_args, booted, answered, saved, BOOT_WATCH
from common import CORS
from test_server import start, req, CDN, FAKES

fails = []
def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what, '' if ok else str(detail)[:400])
    if not ok: fails.append(what)

SONNET, HAIKU = 'claude-sonnet-5-5', 'claude-haiku-5-5'

async def main():
    tmp = tempfile.mkdtemp(); data = os.path.join(tmp, 'data'); log = os.path.join(tmp, 'claude.log'); open(log, 'w').close()
    proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': data, 'FAKE_LOG': log})
    default = json.loads(req(base, 'GET', '/api/models')[1])['default']
    last_model = lambda: [json.loads(x) for x in open(log).read().splitlines() if x.startswith('{') and '"model"' in x][-1]['model']
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args()); errs = []
            async def device(path='/'):
                ctx = await b.new_context(viewport={'width': 1400, 'height': 850}); pg = await ctx.new_page()
                pg.on('pageerror', lambda e: errs.append(str(e)))
                async def route(r):
                    u = r.request.url
                    for k, v in CDN.items():
                        if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
                    if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                    await r.continue_()
                await pg.route('**/*', route); await pg.add_init_script(BOOT_WATCH); await pg.goto(base + path); await booted(pg)
                await ready(pg)
                return pg
            async def ready(pg):
                await pg.wait_for_function("document.querySelector('#mSel option[value=auto]')?.textContent.includes('(')")
            picker = lambda pg: pg.evaluate("[document.getElementById('mSel').value,document.getElementById('eSel').value]")
            llm = lambda pg: pg.evaluate("__digress.conv.llm||null")
            async def ask(pg, q):
                ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter')); await saved(pg)

            A = await device()
            check(await picker(A) == ['auto', 'auto'], 'a new conversation starts at Default', await picker(A))
            await A.locator('#mSel').select_option(SONNET)
            await ask(A, 'First conversation, with Sonnet')
            c1 = await A.evaluate("__digress.conv.id")
            check(await llm(A) == [SONNET, 'auto'] and last_model() == SONNET, 'the first question keeps its model in the conversation', [await llm(A), last_model()])
            await A.locator('#eSel').select_option('high'); await saved(A)
            check(await llm(A) == [SONNET, 'high'], 'changing the effort while it’s open changes it', await llm(A))

            await A.locator('#newConv').click(); await A.wait_for_function(f"__digress.conv.id!=='{c1}'")
            check(await picker(A) == ['auto', 'auto'], 'a new conversation starts at Default again', await picker(A))
            await ask(A, 'Second conversation, with Default')
            check(await llm(A) == [default, 'auto'] and last_model() == default, '…and keeps the actual model, not “Default”', await llm(A))

            await A.locator(f'.citem[data-conv="{c1}"]').click(); await A.wait_for_function(f"__digress.conv.id==='{c1}'")
            check(await picker(A) == [SONNET, 'high'], 'opening the first one again puts the picker back to its model and effort', await picker(A))
            await ask(A, 'Still Sonnet?')
            check(last_model() == SONNET, '…and its next reply uses it', last_model())
            await A.reload(); await booted(A); await ready(A)
            check(await A.evaluate("__digress.conv.id") == c1 and await picker(A) == [SONNET, 'high'], 'after a reload too', await picker(A))

            B = await device('/#c=' + c1)
            check(await picker(B) == [SONNET, 'high'], 'on another device too', await picker(B))
            await B.locator('#mSel').select_option(HAIKU); await saved(B)
            check(await llm(B) == [HAIKU, 'high'], 'changing the model while it’s open changes it', await llm(B))
            await A.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            await A.wait_for_function(f"document.getElementById('mSel').value==='{HAIKU}'", timeout=10000)
            check(True, 'a change on one device reaches the other')

            # a model that isn't offered now
            await A.evaluate("__digress.conv.llm=['gpt-gone','auto']")
            await ask(A, 'Saving it with a model that will be gone')
            await A.reload(); await booted(A); await ready(A)
            await A.wait_for_function("document.querySelector('#toast').textContent.includes('isn’t available')", timeout=5000)
            check(await picker(A) == ['auto', 'auto'], 'a model not offered now: the picker shows Default, and a toast says why', await picker(A))
            await ask(A, 'Which model now?')
            check(last_model() == default and await llm(A) == ['gpt-gone', 'auto'], '…replies use the default, and the conversation still remembers its model', [last_model(), await llm(A)])
            await A.screenshot(path=OUT + '/conv_model.png')
            check(not errs, 'no page errors', errs[:3])
            await b.close()
    finally:
        proc.terminate(); shutil.rmtree(tmp, ignore_errors=True)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
