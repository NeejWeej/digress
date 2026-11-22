"""Flashcards work offline. With the real server and the real service worker (web/sw.js): load the app once,
then lose the connection (the server stops and the network is cut). Reloading still opens the app, in
"offline" mode, with your cards (and their images) from this browser's copy; reviews made offline wait in
an outbox and reach the server once it is back. Asserts and exits non-zero."""
import asyncio, base64, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.async_api import async_playwright
from common import OUT, launch_args, BOOT_WATCH, booted, soon, frames, poll

CACHED = r"""async (asset) => { const c = await caches.open('digress-v1'), keys = new Set((await c.keys()).map(r => r.url));
  const want = [new URL('./', location.href).href, location.origin + '/prompts.js', location.origin + '/threads.js', location.origin + '/api/files/' + asset,
    ...[...document.scripts].map(s => s.src).filter(u => /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//.test(u))];
  return want.every(u => keys.has(u)) }"""   # the worker has kept the page, its scripts and the card's image

from test_server import CDN, FAKES, SERVER, free_port, req

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)


def run_server(port, data):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'LLM_', 'CLAUDE_BIN', 'CHATGPT_', 'GEMINI_', 'GOOGLE_'))}
    env.update({'ANTHROPIC_API_KEY': '', 'GEMINI_API_KEY': '', 'GOOGLE_API_KEY': '', 'PORT': str(port), 'HOST': '127.0.0.1', 'DATA_DIR': data, 'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'CHATGPT_AUTH_FILE': '/nonexistent'})
    p = subprocess.Popen(['node', SERVER], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try: urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=1); break
        except Exception: time.sleep(0.1)
    return p


async def main():
    tmp = tempfile.mkdtemp(); data = os.path.join(tmp, 'data'); port = free_port(); base = f'http://localhost:{port}'
    srv = run_server(port, data)
    try:
        # two due cards on the server, one with an image file
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC')
        st, body = req(base, 'POST', '/api/files?type=image/png', raw=png, ctype='image/png')
        asset = json.loads(body)['id']
        now = int(time.time() * 1000)
        for i, extra in enumerate([{}, {'image': {'asset': asset, 'type': 'image/png', 'w': 8, 'h': 8}}]):
            card = {'id': f'kc{i}', 'conv': 'cX', 'convTitle': 'Attention', 'thread': 'main', 'src': 'made', 'front': f'Front {i}: why scale by sqrt(d)?',
                    'back': f'Back {i}: to keep the variance at 1.', 'status': 'active', 'created': now, 'due': now - 1000, 'fsrs': None, 'reviews': [], **extra}
            req(base, 'PUT', f'/api/store/cards/kc{i}', card)

        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            ctx = await b.new_context(viewport={'width': 1300, 'height': 850}, service_workers='allow')
            async def route(r):
                u = r.request.url
                for k, v in CDN.items():
                    if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers={'access-control-allow-origin': '*'})
                if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                await r.continue_()
            await ctx.route('**/*', route)
            pg = await ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.add_init_script(BOOT_WATCH); await pg.goto(base + '/'); await booted(pg)
            check('the service worker installs', await pg.evaluate("navigator.serviceWorker.ready.then(r=>!!r.active)"))
            await pg.reload(); await booted(pg)   # now the page and its libraries go through the worker, which keeps them
            check('the page is controlled by it', await pg.evaluate('!!navigator.serviceWorker.controller'))
            check('online: the Review button shows the 2 due cards', '2 due' in await pg.locator('#reviewBtn').text_content())
            await pg.wait_for_function(CACHED, arg=asset, polling=100)

            # lose the connection: the server goes away and the network is cut
            srv.kill(); srv.wait()
            await ctx.set_offline(True)
            await pg.reload(); await booted(pg); await soon(pg, "() => (document.getElementById('reviewBtn').textContent || '').includes('2 due')")
            check('offline, the app still opens', await pg.locator('#reviewBtn').count() == 1 and await pg.evaluate("typeof marked!=='undefined'"))
            check('it says it is offline and that cards still work', 'offline' in (await pg.locator('#banner').text_content()).lower() and await pg.locator('#banner').is_visible())
            check('the cards are there, from this browser\'s copy', '2 due' in await pg.locator('#reviewBtn').text_content(), await pg.locator('#reviewBtn').text_content())
            await pg.locator('#reviewBtn').click(); await pg.locator('#cardsModal.show').wait_for()
            await pg.keyboard.press('Space'); await frames(pg)
            check('review works offline', await pg.locator('#cardsModal .krate button').count() == 4)
            await pg.keyboard.press('3'); await soon(pg, "() => { const i = document.querySelector('#cardsModal .kimg img'); return i && i.complete && i.naturalWidth === 8 }")
            check('the card with an image shows it offline', await pg.locator('#cardsModal .kimg img').count() == 1 and await pg.locator('#cardsModal .kimg img').evaluate('e=>e.complete&&e.naturalWidth===8'))
            await pg.screenshot(path=OUT + '/offline_review.png')
            await pg.keyboard.press('Space'); await pg.keyboard.press('4'); await soon(pg, "() => JSON.parse(localStorage.getItem('digress:cards-outbox')||'[]').length === 2")
            check('both ratings wait in the outbox', await pg.evaluate("JSON.parse(localStorage.getItem('digress:cards-outbox')||'[]').length") == 2)

            # back online: the reviews reach the server
            srv = run_server(port, data)
            await ctx.set_offline(False)
            await pg.evaluate("dispatchEvent(new Event('online'))")
            await poll(lambda: all(len(json.loads(req(base, 'GET', f'/api/store/cards/kc{i}')[1])['reviews']) == 1 for i in range(2)))
            await soon(pg, "() => JSON.parse(localStorage.getItem('digress:cards-outbox')||'[]').length === 0 && document.getElementById('banner').textContent.includes('Back online')")
            got = [json.loads(req(base, 'GET', f'/api/store/cards/kc{i}')[1]) for i in range(2)]
            check('back online, the offline reviews are saved on the server', all(len(c['reviews']) == 1 and c['due'] > now + 86400_000 for c in got), str([(len(c['reviews']), c['due'] - now) for c in got]))
            check('the outbox is empty', await pg.evaluate("JSON.parse(localStorage.getItem('digress:cards-outbox')||'[]').length") == 0)
            check('and the banner offers to reload', 'Back online' in await pg.locator('#banner').text_content())
            check('no page errors', not errs, '; '.join(errs[:3]))
            await b.close()
    finally:
        srv.kill(); shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(1 if fails else 0)

asyncio.run(main())
