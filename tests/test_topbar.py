"""The top bar keeps what fits; the rest goes into the "more" (⋯) menu, so every setting (model, effort,
web, view, theme) can be reached at any width, on a phone too. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app

MAP = {'marked.min.js': ROOT + 'marked/marked.min.js', 'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
       'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js', 'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js'}
FAKE = "window.fakeLLM={use:async n=>n==='sample'?async()=>({text:'Hi.'}):null};"
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:400])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        for w, mob in [(1500, False), (900, False), (600, False), (390, True)]:
            ctx = await b.new_context(viewport={'width': w, 'height': 800}, is_mobile=mob, has_touch=mob)
            pg = await ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            async def route(r):
                u = r.request.url
                for k, v in MAP.items():
                    if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
                if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                await r.continue_()
            await pg.route('**/*', route); await pg.add_init_script(FAKE); await goto_app(pg); await pg.wait_for_timeout(1500)
            sw, cw = await pg.evaluate("(()=>{const t=document.querySelector('.top');return [t.scrollWidth,t.clientWidth]})()")
            check(f'{w}px: nothing in the top bar is cut off', sw <= cw + 1, (sw, cw))
            reach = {}
            for sel in ['#mSel', '#eSel', '#webT', '#viewSeg', '#themeB']:
                in_bar = await pg.locator(f'.top {sel}').count() and await pg.locator(f'.top {sel}').is_visible()
                reach[sel] = 'bar' if in_bar else 'menu' if await pg.locator(f'.tmore {sel}').count() else 'nowhere'
            check(f'{w}px: every setting is in the bar or the ⋯ menu', 'nowhere' not in reach.values(), reach)
            more = await pg.locator('#moreB').is_visible()
            check(f'{w}px: the ⋯ button shows exactly when something is in the menu', more == ('menu' in reach.values()), (more, reach))
            if more:
                await pg.locator('#moreB').click(); await pg.wait_for_timeout(200)
                check(f'{w}px: the menu opens', await pg.locator('.tmore.open').count() == 1)
                if reach['#eSel'] == 'menu':
                    await pg.select_option('.tmore #eSel', 'high'); await pg.wait_for_timeout(100)
                    check(f'{w}px: effort can be set from the menu', await pg.evaluate("JSON.parse(localStorage.getItem('sq:settings')).effort") == 'high')
                if reach['#themeB'] == 'menu':
                    await pg.locator('.tmore #themeB').click(); await pg.wait_for_timeout(200)
                    await pg.locator('.thmenu button[data-theme=sand]').click(); await pg.wait_for_timeout(200)
                    check(f'{w}px: the theme can be picked from the menu', await pg.evaluate('document.documentElement.dataset.theme') == 'sand')
                await pg.screenshot(path=f'{OUT}/topbar-{w}.png')
                await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape'); await pg.mouse.click(5, 700); await pg.wait_for_timeout(150)
                check(f'{w}px: it closes', await pg.locator('.tmore.open').count() == 0)
            check(f'{w}px: no page errors', not errs, errs[:3])
            await ctx.close()
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
