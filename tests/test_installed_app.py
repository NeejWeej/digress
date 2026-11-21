"""Digress as an installed app (Install app on Android).
  - The server serves the manifest (standalone, its icons) and the icons, with the right types and sizes.
  - The status bar color (theme-color) is the top bar's, and follows the theme.
  - Installed, Android's back closes what's open on top (a menu, search, the sidebar on a phone), never a pane;
    with nothing open, the first back says how to leave and keeps the app, so only a second one right after leaves.
  - Zen never goes full screen, installed or not (Android turns pinch-zoom off in full screen).
  - In a browser tab, none of that: back behaves as before.
"Installed" and "touch screen" are what matchMedia says, so the test answers those queries itself.
Asserts and exits non-zero."""
import asyncio, json, os, struct, sys, tempfile
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames
from common import CORS
from test_server import start, req

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const out='Attention weighs every token.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
INSTALLED = r"""(() => { const mm = window.matchMedia.bind(window);
  window.matchMedia = q => /display-mode: (standalone|fullscreen|minimal-ui)|pointer: coarse/.test(q)
    ? mm('(min-width: 0px)') : mm(q); })();"""
UNFOLD = "document.querySelectorAll('.thmenu.open .thgrp[aria-expanded=false]').forEach(b=>b.click())"   # open every section of the theme menu
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def png_size(b): return struct.unpack('>II', b[16:24])

def server_part():
    with tempfile.TemporaryDirectory() as data:
        proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': '/nonexistent/claude'})
        try:
            st, body = req(base, 'GET', '/manifest.webmanifest')
            m = json.loads(body) if st == 200 else {}
            check('server: the manifest is served', st == 200 and m.get('display') == 'standalone' and m.get('start_url') == './' and m.get('scope') == './', [st, body[:200]])
            for ic in m.get('icons', []):
                s2, png = req(base, 'GET', '/' + ic['src'])
                w, h = png_size(png) if s2 == 200 else (0, 0)
                check(f"server: {ic['src']} ({ic['purpose']}) is served at {ic['sizes']}", s2 == 200 and f'{w}x{h}' == ic['sizes'], [s2, w, h])
            check('…including a maskable one and a 512px one', any(i['purpose'] == 'maskable' for i in m.get('icons', [])) and any(i['sizes'] == '512x512' for i in m.get('icons', [])))
            import urllib.request
            with urllib.request.urlopen(base + '/manifest.webmanifest') as r:
                check('…as application/manifest+json', r.headers['content-type'] == 'application/manifest+json', r.headers['content-type'])
            st, body = req(base, 'GET', '/')
            check('the page links it, with a theme-color', b'rel="manifest" href="manifest.webmanifest"' in body and b'name="theme-color"' in body)
        finally:
            proc.terminate()

async def open_app(b, installed, w=1300, h=800):
    pg = await b.new_page(viewport={'width': w, 'height': h}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    async def route(r):
        u = r.request.url
        for k, v in MAP.items():
            if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
        if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
        await r.continue_()
    await pg.route('**/*', route); await pg.add_init_script(FAKE)
    if installed: await pg.add_init_script(INSTALLED)
    await goto_app(pg); await booted(pg); await frames(pg)
    return pg, errs

async def back(pg):
    await pg.evaluate('history.back()'); await pg.wait_for_timeout(250)

async def main():
    server_part()
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())

        # the status bar color
        pg, errs = await open_app(b, False)
        tc = lambda: pg.evaluate("document.querySelector('meta[name=theme-color]').content")
        panel = lambda: pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()")
        check('theme-color is the top bar’s color', await tc() == await panel(), [await tc(), await panel()])
        await pg.locator('#themeB').click(); await pg.evaluate(UNFOLD); await pg.locator('.thmenu.open button[data-theme=nord]').click(); await frames(pg)
        check('…and follows the theme', await tc() == await panel() and await tc() != '#fffdf9', await tc())
        await pg.keyboard.press('Escape')
        # a browser tab: no extra history entry; Zen doesn't go full screen
        check('in a browser tab, back is left alone (no extra history entry)', not await pg.evaluate('history.state&&history.state.digressBack'))
        await pg.locator('#zenB').click() if await pg.locator('#zenB').is_visible() else await pg.keyboard.press('Control+.')
        await frames(pg)
        check('…and Zen doesn’t go full screen', await pg.evaluate("document.documentElement.closest('#x')===null && !document.fullscreenElement") and await pg.evaluate("document.querySelector('#app').classList.contains('zen')"))
        await pg.close()

        # installed, on a phone-sized screen
        pg, errs = await open_app(b, True, 400, 820)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await answered(pg, ta.press('Enter'))
        await frames(pg)
        check('installed: an extra history entry keeps back inside the app', await pg.evaluate('!!(history.state&&history.state.digressBack)'))
        panes = lambda: pg.evaluate("document.querySelectorAll('#panes > .pane').length")
        n0 = await panes()

        await pg.locator('#tSide').click(); await frames(pg)
        check('(set up: the sidebar is open over the panes)', await pg.evaluate("document.querySelector('#app').classList.contains('sideopen')"))
        await back(pg)
        check('back closes the sidebar', not await pg.evaluate("document.querySelector('#app').classList.contains('sideopen')"))
        check('…and stays in the app, ready for the next back', await pg.evaluate('!!(history.state&&history.state.digressBack)'))

        await pg.keyboard.press('Control+k'); await frames(pg)
        check('(set up: search is open)', await pg.evaluate("document.querySelector('#pal').classList.contains('show')"))
        await back(pg)
        check('back closes search', not await pg.evaluate("document.querySelector('#pal').classList.contains('show')"))

        await pg.evaluate("document.querySelector('#toast').classList.remove('show')")
        await back(pg)
        toast = await pg.locator('#toast').inner_text()
        check('with nothing open, back says how to leave', 'Swipe back again to leave' in toast, toast)
        check('…closes no pane', await panes() == n0, [n0, await panes()])
        check('…and leaves the extra entry off for a moment (so a second back leaves)', not await pg.evaluate('!!(history.state&&history.state.digressBack)'))
        await pg.wait_for_timeout(2700)
        check('…then puts it back', await pg.evaluate('!!(history.state&&history.state.digressBack)'))

        # Zen doesn't go full screen, even installed on a touch screen: full screen turns off pinch-zoom on Android
        await pg.keyboard.press('Control+.'); await pg.wait_for_timeout(300)
        check('installed on a touch screen: Zen hides the top bar but doesn’t go full screen', await pg.evaluate("document.querySelector('#app').classList.contains('zen') && !document.fullscreenElement"))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
