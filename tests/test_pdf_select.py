"""Selecting text in a PDF doesn't jump when the pointer (or a phone's selection handle) crosses the gaps
between words: dragging into a gap (between lines, say) keeps the selection near the pointer instead of
grabbing the rest of the line or page. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import PAGE, OUT, FIX, launch_args, goto_app, booted, frames, settle, pdf_drawn
from common import CORS
from test_pane_zoom import MAP, FAKE

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1200, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', FIX + '/paper.pdf'); await pg.locator('#docGo').click(); await pdf_drawn(pg); await settle(pg)
        lines = await pg.evaluate("[...document.querySelectorAll('.dpage[data-page=\"1\"] .textLayer span')].map(s=>{const r=s.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})")
        l1, l2 = lines[1], lines[2]
        sx, sy = l1[0] + 40, (l1[1] + l1[3]) / 2
        async def drag(ex, ey):
            await pg.mouse.move(sx, sy); await pg.mouse.down()
            for i in range(1, 13): await pg.mouse.move(sx + (ex - sx) * i / 12, sy + (ey - sy) * i / 12); await pg.wait_for_timeout(25)
            s = await pg.evaluate('getSelection().toString()'); await pg.mouse.up()
            await pg.mouse.click(1150, 880); await frames(pg)
            return s
        s = await drag(l1[0] + 60, (l1[3] + l2[1]) / 2)
        check('dragging into the gap between lines stays near the pointer', len(s.strip()) < 10, repr(s))
        s = await drag(l1[2] - 5, (l1[1] + l1[3]) / 2)
        check('ordinary selection still works', 'differentiable dictionary' in s, repr(s))
        check('the gap filler is back at the end of the page afterwards', await pg.evaluate("[...document.querySelectorAll('.textLayer')].every(t=>t.lastElementChild.classList.contains('endOfContent')&&!t.classList.contains('selecting'))"))
        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
