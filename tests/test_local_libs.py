"""The page's libraries come from this server first, and from a CDN only when this server doesn't have them.
  - The server serves each file in server/libs.json from node_modules (the same bytes), cached for good; nothing
    else: another version, another file of the package, or a path outside it is 404.
  - With every CDN unreachable (a phone whose network can't reach cdn.jsdelivr.net), the page still gets all of
    them, the ones it starts with and the ones it loads later (search's), and asks no CDN for anything.
  - With no copies here (no `npm install`), it gets them from the CDNs instead.
  - A copy here that doesn't match its hash isn't run; the page takes the CDN's.
  - Fonts the same way: a font's stylesheet and the .woff2 files it names, and no other file of its package; the
    page's fonts load from here with no CDN (or Google) asked, from the CDN without copies here, and from the CDN
    when a copy here was changed.
Asserts and exits non-zero."""
import asyncio, os, sys, tempfile, urllib.request
from playwright.async_api import async_playwright
from common import BOOT_WATCH, CDN, CORS, LIBS, LIB_PATHS, ROOT, OUT, launch_args, booted, lib_path, cdn_font, lib_type
from test_server import start, req

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

CDNS = ('cdn.jsdelivr.net', 'cdnjs.cloudflare.com')
LOADED = "!!(window.marked&&window.DOMPurify&&window.hljs)"

def server_part(base):
    for l in LIBS:
        st, body = req(base, 'GET', '/lib/' + l)
        check(f'serves lib/{l}, byte for byte', st == 200 and body == open(lib_path(l), 'rb').read(), st)
    with urllib.request.urlopen(base + '/lib/' + next(l for l in LIBS if l.endswith('.js'))) as r:
        check('…as JavaScript, cached for good', r.headers['content-type'].startswith('text/javascript') and 'immutable' in r.headers['cache-control'], dict(r.headers))
    for bad in ['/lib/marked@1.0.0/marked.min.js', '/lib/marked@12.0.2/package.json', '/lib/marked@12.0.2/../../package.json',
                '/lib/marked@12.0.2/%2e%2e/%2e%2e/package.json', '/lib/marked%4012.0.2%2F..%2F..%2F..%2Fpackage.json', '/lib/']:
        st, _ = req(base, 'GET', bad)
        check(f'…and nothing else: {bad} is 404', st == 404, st)

INTER = '@fontsource-variable/inter@5.3.0/'
def font_part(base):
    woff = sorted(p for p in LIB_PATHS if p.startswith(INTER) and p.endswith('.woff2'))
    with urllib.request.urlopen(base + '/lib/' + INTER + 'index.css') as r:
        check('a font’s stylesheet is served as CSS, cached for good', r.headers['content-type'].startswith('text/css') and 'immutable' in r.headers['cache-control'], dict(r.headers))
    with urllib.request.urlopen(base + '/lib/' + woff[0]) as r:
        check('…and the font files it names, as fonts, byte for byte', r.headers['content-type'] == 'font/woff2' and r.read() == open(lib_path(woff[0]), 'rb').read(), dict(r.headers))
    for bad in [INTER + 'files/inter-latin-opsz-normal.woff2', INTER + 'package.json', INTER + 'files/../package.json', INTER + 'files/%2e%2e/package.json',
                INTER + 'opsz.css', '@fontsource-variable/inter@5.2.0/index.css']:
        st, _ = req(base, 'GET', '/lib/' + bad)
        check(f'…and nothing else of the package: {bad} is 404', st == 404, st)

FONTS_LOADED = """async (fams) => { await document.fonts.ready;
  const ok = (fam) => [...document.fonts].some(f => f.family.replace(/["']/g, '') === fam && f.status === 'loaded');
  for (let i = 0; i < 100 && !fams.every(ok); i++) await new Promise(r => setTimeout(r, 100));
  return fams.filter(f => !ok(f)) }"""
async def fonts_missing(pg, more=()):
    """The page's own fonts (and `more`, after picking Lexend) that didn't load; [] when they all did. The page's first:
    once Lexend takes over, a font not loaded yet is no longer needed, so it never would be."""
    miss = await pg.evaluate(FONTS_LOADED, ['Inter Variable', 'Source Serif 4 Variable'])
    if more:
        # a font sets only the conversation's type, so it loads once some reply text is on screen: put a line there
        await pg.evaluate("applyFont('lexend');const p=document.createElement('p');p.style.fontFamily='var(--serif)';p.textContent='A reply';document.body.appendChild(p)")
        miss += await pg.evaluate(FONTS_LOADED, list(more))
    return miss

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
            f = cdn_font(u)
            if f: return await r.fulfill(path=f, content_type=lib_type(f), headers=CORS)
            return await r.abort()
        if 'fonts.g' in u: asked.append(u); return await r.abort()
        if '/api/health' in u:
            resp = await r.fetch()
            body = (await resp.body()).replace(b'"search":true', b'"search":false')
            return await r.fulfill(response=resp, body=body)
        if '/lib/' in u:
            if not here: return await r.fulfill(status=404, body='not found')
            if any(u.endswith(t) for t in tamper):
                if u.endswith('.css'): return await r.fulfill(body='body{color:red}', content_type='text/css')
                return await r.fulfill(body='window.__tampered=true;', content_type='text/javascript')
        await r.continue_()
    await pg.route('**/*', route); await pg.add_init_script(BOOT_WATCH)
    await pg.goto(base + '/'); await booted(pg)
    return pg, errs, asked

async def search_loads(pg):
    await pg.keyboard.press('Control+k'); await pg.locator('#palIn').fill('attention')
    try: await pg.wait_for_function('!!window.MiniSearch', timeout=15000); return True
    except Exception: return False

async def math_loads(pg):
    # MathJax loads lazily on first math content, not eagerly on an empty page
    eager = await pg.evaluate('!!(window.MathJax && window.MathJax.tex2svg)')
    await pg.evaluate("""(() => {
      const c = __digress.conv;
      c.msgs.m_math = { id: 'm_math', thread: 'main', role: 'assistant', content: 'Euler: $e^{i\\\\pi}+1=0$', ts: Date.now(), ver: 1 };
      c.order.main = ['m_math'];
      window.dispatchEvent(new Event('resize'));
    })()""")
    # trigger render via opening/switching view or reloading a pane with math
    await pg.locator('[data-v=canvas]').click()
    await pg.locator('.cnode.main [data-cact=exp]').click()
    try: await pg.wait_for_function('!!(window.MathJax && window.MathJax.tex2svg)', timeout=20000); return (not eager, True)
    except Exception: return (not eager, False)

async def main():
    with tempfile.TemporaryDirectory() as data:
        proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': '/nonexistent/claude'})
        try:
            server_part(base)
            font_part(base)
            async with async_playwright() as p:
                b = await p.chromium.launch(**launch_args())

                pg, errs, asked = await open_page(b, base, cdn=False)
                await pg.wait_for_function(LOADED, timeout=20000)
                check('CDNs unreachable: the page still gets marked, DOMPurify and highlight.js', True)
                lazy_ok, mj_ok = await math_loads(pg)
                check('…MathJax is lazy-loaded (not loaded on empty page) and loads from lib/ when math appears', lazy_ok and mj_ok, (lazy_ok, mj_ok))
                check('…and search’s library when it’s first needed', await search_loads(pg))
                await pg.screenshot(path=OUT + '/local_libs_search.png')
                check('…and its fonts, and a font picked later (Lexend)', not await fonts_missing(pg, ['Lexend Variable']), await fonts_missing(pg, ['Lexend Variable']))
                check('…without asking a CDN (or Google) for any of them', not asked, asked[:3])
                check('no page errors', not errs, errs[:3])
                await pg.close()

                pg, errs, asked = await open_page(b, base, here=False)
                ok = True
                try: await pg.wait_for_function(LOADED, timeout=20000)
                except Exception: ok = False
                check('no copies here: it gets them from the CDNs', ok and await search_loads(pg))
                miss = await fonts_missing(pg, ['Lexend Variable'])
                check('…and its fonts from the CDN too', not miss and any('@fontsource-variable/lexend' in u for u in asked),
                      [miss, await pg.evaluate("[...document.fonts].filter(f=>f.status!=='unloaded').map(f=>f.family+' '+f.status)"), [u for u in asked if 'fontsource' in u]])
                check('…having asked the CDNs', any('marked' in u for u in asked) and any('minisearch' in u for u in asked), asked)
                check('no page errors (no copies here)', not errs, errs[:3])
                await pg.close()

                pg, errs, asked = await open_page(b, base, tamper=('marked.min.js', 'umd/index.js', INTER + 'index.css'))
                ok = True
                try: await pg.wait_for_function(LOADED, timeout=20000)
                except Exception: ok = False
                check('a copy here that doesn’t match its hash: the page takes the CDN’s', ok and await search_loads(pg) and any('marked' in u for u in asked) and any('minisearch' in u for u in asked), asked)
                check('…and never runs the changed one', not await pg.evaluate('!!window.__tampered'))
                check('a font stylesheet here that doesn’t match its hash: the CDN’s instead, and the changed one never applies', not await fonts_missing(pg)
                      and any(INTER + 'index.css' in u for u in asked) and await pg.evaluate("getComputedStyle(document.body).color") != 'rgb(255, 0, 0)', asked)
                await pg.close()
                await b.close()
        finally:
            proc.terminate()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

if __name__ == "__main__": asyncio.run(main())
