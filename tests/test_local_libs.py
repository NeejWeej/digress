"""The page's libraries come from this server first, and from a CDN only when this server doesn't have them.
  - The server serves each file in server/libs.json from node_modules (the same bytes), cached for good; nothing
    else: another version, another file of the package, or a path outside it is 404.
  - With every CDN unreachable (a phone whose network can't reach cdn.jsdelivr.net), the page still gets all of
    them, the ones it starts with and the ones it loads later (search's), and asks no CDN for anything.
  - With no copies here (no `npm install`), it gets them from the CDNs instead.
  - A copy here that doesn't match its hash isn't run; the page takes the CDN's.
Asserts and exits non-zero."""
import asyncio, os, sys, tempfile, urllib.request
from playwright.async_api import async_playwright
from common import BOOT_WATCH, CDN, CORS, LIBS, ROOT, OUT, launch_args, booted, lib_path
from test_server import start, req

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

CDNS = ('cdn.jsdelivr.net', 'cdnjs.cloudflare.com')
LOADED = "!!(window.marked&&window.DOMPurify&&window.hljs&&window.MathJax&&window.MathJax.tex2svg)"

def server_part(base):
    for l in LIBS:
        st, body = req(base, 'GET', '/lib/' + l)
        check(f'serves lib/{l}, byte for byte', st == 200 and body == open(lib_path(l), 'rb').read(), st)
    with urllib.request.urlopen(base + '/lib/' + LIBS[0]) as r:
        check('…as JavaScript, cached for good', r.headers['content-type'].startswith('text/javascript') and 'immutable' in r.headers['cache-control'], dict(r.headers))
    for bad in ['/lib/marked@1.0.0/marked.min.js', '/lib/marked@12.0.2/package.json', '/lib/marked@12.0.2/../../package.json',
                '/lib/marked@12.0.2/%2e%2e/%2e%2e/package.json', '/lib/marked%4012.0.2%2F..%2F..%2F..%2Fpackage.json', '/lib/']:
        st, _ = req(base, 'GET', bad)
        check(f'…and nothing else: {bad} is 404', st == 404, st)

async def open_page(b, base, here=True, cdn=True, tamper=()):
    """The app from the real server. here: its lib/ copies are served; cdn: the CDNs answer (from node_modules);
    tamper: lib/ files that come back changed."""
    # no service worker: it would fetch lib/ files itself, past this test's routes (the page's own loading is what's tested)
    ctx = await b.new_context(viewport={'width': 1200, 'height': 800}, service_workers='block'); pg = await ctx.new_page()
    errs, asked = [], []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    async def route(r):
        u = r.request.url
        if any(h in u for h in CDNS):
            asked.append(u)
            if not cdn: return await r.abort()
            for k, v in CDN.items():
                if u.endswith(k): return await r.fulfill(path=ROOT + v, content_type='application/javascript', headers=CORS)
            return await r.abort()
        if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
        if '/lib/' in u:
            if not here: return await r.fulfill(status=404, body='not found')
            if any(u.endswith(t) for t in tamper):
                return await r.fulfill(body='window.__tampered=true;', content_type='text/javascript')
        await r.continue_()
    await pg.route('**/*', route); await pg.add_init_script(BOOT_WATCH)
    await pg.goto(base + '/'); await booted(pg)
    return pg, errs, asked

async def search_loads(pg):
    await pg.keyboard.press('Control+k'); await pg.locator('#palIn').fill('attention')
    try: await pg.wait_for_function('!!window.MiniSearch', timeout=15000); return True
    except Exception: return False

async def main():
    with tempfile.TemporaryDirectory() as data:
        proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': '/nonexistent/claude'})
        try:
            server_part(base)
            async with async_playwright() as p:
                b = await p.chromium.launch(**launch_args())

                pg, errs, asked = await open_page(b, base, cdn=False)
                await pg.wait_for_function(LOADED, timeout=20000)
                check('CDNs unreachable: the page still gets marked, DOMPurify, highlight.js and MathJax', True)
                check('…and search’s library when it’s first needed', await search_loads(pg))
                await pg.screenshot(path=OUT + '/local_libs_search.png')
                check('…without asking a CDN for any of them', not asked, asked[:3])
                check('no page errors', not errs, errs[:3])
                await pg.close()

                pg, errs, asked = await open_page(b, base, here=False)
                ok = True
                try: await pg.wait_for_function(LOADED, timeout=20000)
                except Exception: ok = False
                check('no copies here: it gets them from the CDNs', ok and await search_loads(pg))
                check('…having asked the CDNs', any('marked' in u for u in asked) and any('minisearch' in u for u in asked), asked)
                check('no page errors (no copies here)', not errs, errs[:3])
                await pg.close()

                pg, errs, asked = await open_page(b, base, tamper=('marked.min.js', 'umd/index.js'))
                ok = True
                try: await pg.wait_for_function(LOADED, timeout=20000)
                except Exception: ok = False
                check('a copy here that doesn’t match its hash: the page takes the CDN’s', ok and await search_loads(pg) and any('marked' in u for u in asked) and any('minisearch' in u for u in asked), asked)
                check('…and never runs the changed one', not await pg.evaluate('!!window.__tampered'))
                await pg.close()
                await b.close()
        finally:
            proc.terminate()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
