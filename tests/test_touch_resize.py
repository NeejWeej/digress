"""On a phone, dragging the gap between two panes (Columns view) with a finger resizes them, including
narrower than the default phone width, instead of scrolling the page. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import PAGE, OUT, launch_args, goto_app
from test_pane_zoom import MAP, FAKE

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        ctx = await b.new_context(viewport={'width': 412, 'height': 860}, has_touch=True, is_mobile=True, device_scale_factor=2)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await pg.wait_for_timeout(1200)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await ta.press('Enter'); await pg.wait_for_timeout(900)
        await pg.evaluate('''() => { const body=document.querySelector('.pane[data-tid=main] .msg.assistant .body');
          const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT); const n=w.nextNode(); const r=document.createRange(); r.setStart(n,15); r.setEnd(n,19);
          const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }''')
        await pg.wait_for_timeout(150)
        await pg.locator('#popIn').fill('Why soft?'); await pg.locator('#popIn').press('Enter'); await pg.wait_for_timeout(1200)
        main = pg.locator('.pane[data-tid=main]')
        fit = await pg.evaluate("[getComputedStyle(document.querySelector('.app')).height, innerHeight, document.scrollingElement.scrollHeight, getComputedStyle(document.body).overflow]")
        check('on a phone the app fits the visible screen and the page itself never scrolls (top bar stays put)', abs(float(fit[0][:-2]) - fit[1]) < 1 and fit[2] <= fit[1] and fit[3] == 'hidden', str(fit))
        w0 = await main.evaluate('e=>e.getBoundingClientRect().width')
        g = await pg.locator('.gut').first.bounding_box()
        check('the grip has a finger-sized touch area', await pg.evaluate("parseFloat(getComputedStyle(document.querySelector('.gut'),'::before').left)") <= -8)
        cdp = await ctx.new_cdp_session(pg)
        x, y = g['x'] + g['width'] / 2, g['y'] + g['height'] / 2
        async def touch(t, px):
            await cdp.send('Input.dispatchTouchEvent', {'type': t, 'touchPoints': [] if t == 'touchEnd' else [{'x': px, 'y': y}]})
        await touch('touchStart', x)
        for i in range(1, 13): await touch('touchMove', x - 130 * i / 12); await pg.wait_for_timeout(20)
        await touch('touchEnd', x - 130); await pg.wait_for_timeout(1200)
        w1 = await main.evaluate('e=>e.getBoundingClientRect().width')
        sl = await pg.evaluate("document.querySelector('#panes').scrollLeft")
        check('a finger drag on the grip narrows the pane (below the default phone width)', w1 < w0 - 100, f'{w0:.0f} -> {w1:.0f}')
        check('and does not scroll the panes sideways instead', sl == 0, str(sl))
        both = await pg.evaluate("[...document.querySelectorAll('.pane')].every(p=>{const r=p.getBoundingClientRect();return r.right<=innerWidth+150})")
        await pg.screenshot(path=OUT + '/touch_resize.png')
        await pg.reload(); await pg.wait_for_timeout(1500)
        w2 = await pg.locator('.pane[data-tid=main]').evaluate('e=>e.getBoundingClientRect().width')
        check('the size is kept after a reload', abs(w2 - w1) < 3, f'{w2:.0f}')
        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
