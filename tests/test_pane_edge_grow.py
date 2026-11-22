"""Resizing a pane past the edge of the screen: held near the far edge of the panes area, the pane keeps growing
and the row scrolls along, so the handle stays under the pointer.
  - Columns: the rightmost pane's handle, held at the right edge, grows the pane wider than the screen allows.
  - It starts after a moment there (EDGE_WAIT), is capped (EDGE_GROW px per second) and stops once the pointer leaves the edge.
  - On the way it stops where the pane exactly fills the panes area ("Fits the window"), and only carries on if
    it's still held after SNAP_HOLD; letting go there keeps that size.
  - Letting go keeps the width (saved in conv.ui.sizes).
  - Rows: the same at the bottom edge.
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out='Attention lets each token weigh every other token. The weights come from a softmax over scores.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

W, H = 1300, 800

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': W, 'height': H})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await answered(pg, ta.press('Enter'))
        # a branch, so there are two panes and the second is at the end
        await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').first.click()
        await pg.wait_for_function('Object.keys(__digress.conv.threads).length > 1')
        br = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        await frames(pg)
        size = lambda tid: pg.evaluate(f"(()=>{{const r=document.querySelector('.pane[data-tid=\"{tid}\"]').getBoundingClientRect();return [r.width,r.height]}})()")
        scroll = lambda: pg.evaluate("[document.querySelector('#panes').scrollLeft, document.querySelector('#panes').scrollTop]")
        gut = pg.locator(f'#panes > .pane[data-tid="{br}"] + .gut')
        edge = await pg.evaluate("(()=>{const r=document.querySelector('#panes').getBoundingClientRect();return [Math.min(r.right,innerWidth),Math.min(r.bottom,innerHeight)]})()")

        # Columns: drag the last handle to the right edge and hold it there
        w0 = (await size(br))[0]; r = await gut.bounding_box(); x, y = r['x'] + r['width'] / 2, r['y'] + 200
        await pg.mouse.move(x, y); await pg.mouse.down()
        await pg.mouse.move(edge[0] - 30, y, steps=5); await frames(pg)
        w1 = (await size(br))[0]
        fit = await pg.evaluate("(()=>{const b=document.querySelector('#panes'),cs=getComputedStyle(b);return b.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-10})()")
        await pg.mouse.move(edge[0] - 2, y); await pg.wait_for_timeout(200)
        check('a moment at the edge doesn’t grow it yet (a drag that just ends there stays as dragged)', abs((await size(br))[0] - w1) < 30, [w1, await size(br)])
        # note when it snaps (in the page's own clock), to tell "waits there" from "a slow machine took longer than the hold"
        await pg.evaluate("window.__snapAt = 0; new MutationObserver(() => { if (!window.__snapAt && document.querySelector('.gut.snap')) window.__snapAt = performance.now() }).observe(document.getElementById('panes'), {attributes: true, subtree: true, attributeFilter: ['class']})")
        try:
            await pg.wait_for_function("document.querySelector('.gut.snap')", timeout=4000); snapped = True
        except Exception: snapped = False
        ws = (await size(br))[0]
        check('held there, it grows until the pane fills the window, and stops', snapped and abs(ws - fit) < 2, [w1, ws, fit])
        check('…saying so', await pg.evaluate("!!document.querySelector('#snapTag.on')") and 'Fits the window' in await pg.locator('#snapTag').inner_text())
        await pg.wait_for_timeout(300)   # deliberate: part-way into the hold (700 ms)
        held, since = await pg.evaluate(f"[document.querySelector('#panes > .pane[data-tid=\"{br}\"]').getBoundingClientRect().width, performance.now() - window.__snapAt]")
        check('…and waits there', abs(held - fit) < 2 or since > 650, [held, fit, round(since)])   # (past the hold already: this machine is too slow to see it)
        await pg.screenshot(path=OUT + '/pane_edge_snap.png')
        await pg.wait_for_timeout(1300)
        w2 = (await size(br))[0]; sl = (await scroll())[0]
        check('still held, it carries on past the screen', w2 > fit + 150, [w0, w1, fit, w2])
        check('…capped: no more than about 700px a second', w2 - fit < 900, w2 - fit)
        check('…and the row scrolls along with it', sl > 150, sl)
        check('…the snap mark gone', not await pg.evaluate("!!document.querySelector('.gut.snap,#snapTag.on')"))
        g = await gut.bounding_box()
        check('…so the handle stays under the pointer', abs(g['x'] + g['width'] / 2 - (edge[0] - 2)) < 12, [g['x'], edge[0]])
        await pg.mouse.move(edge[0] - 300, y); await pg.wait_for_timeout(100); w3 = (await size(br))[0]
        await pg.wait_for_timeout(400); w4 = (await size(br))[0]
        check('moving away from the edge stops it', abs(w4 - w3) < 1, [w3, w4])
        # by hand: back below the window's size, then out again: it snaps again, and a firm pull takes it on
        fx = edge[0] - 300 + (fit - w4)   # where the pointer puts the pane at exactly the window's size
        await pg.mouse.move(fx - 60, y); await frames(pg)
        await pg.mouse.move(fx + 6, y, steps=3); await frames(pg)
        check('by hand, back below the window’s size and out again, it snaps again', abs((await size(br))[0] - fit) < 2 and await pg.evaluate("!!document.querySelector('.gut.snap')"), [await size(br), fit])
        await pg.mouse.move(fx + 30, y); await frames(pg)
        check('…and holds against a small push', abs((await size(br))[0] - fit) < 2, [await size(br), fit])
        await pg.mouse.move(fx + 70, y); await frames(pg)
        check('…a firmer one takes it on, the snap mark gone', abs((await size(br))[0] - (fit + 70)) < 3 and not await pg.evaluate("!!document.querySelector('.gut.snap')"), [await size(br), fit])
        await pg.mouse.up(); await frames(pg)
        saved = await pg.evaluate(f"__digress.conv.ui.sizes['{br}']")
        check('letting go keeps the width', abs(saved - (await size(br))[0]) < 2, [saved, await size(br)])
        await pg.screenshot(path=OUT + '/pane_edge_grow.png')

        # letting go at the snap leaves the pane exactly window-wide
        await pg.locator('#panes').evaluate('b=>b.scrollLeft=0')
        await pg.evaluate(f"(()=>{{__digress.conv.ui.sizes['{br}']=420;document.querySelector('.pane[data-tid=\"{br}\"]').style.flex='0 0 420px'}})()"); await frames(pg)
        r = await gut.bounding_box(); x, y = r['x'] + r['width'] / 2, r['y'] + 200
        await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(edge[0] - 2, y, steps=5)
        try:
            await pg.wait_for_function("document.querySelector('.gut.snap')", timeout=4000)
        except Exception: pass
        # right to the snap, a little left, right again: it snaps every time
        await pg.mouse.move(edge[0] - 2 - 70, y, steps=3); await frames(pg)
        check('a little left of the snap lets it go', (await size(br))[0] < fit - 50 and not await pg.evaluate("!!document.querySelector('.gut.snap')"), [await size(br), fit])
        await pg.mouse.move(edge[0] - 2, y, steps=4); await frames(pg)
        check('…and right again snaps again', abs((await size(br))[0] - fit) < 2 and await pg.evaluate("!!document.querySelector('.gut.snap')"), [await size(br), fit])
        await pg.mouse.up(); await frames(pg)
        saved = await pg.evaluate(f"__digress.conv.ui.sizes['{br}']")
        check('letting go at the snap leaves the pane exactly filling the window', abs(saved - fit) < 2 and not await pg.evaluate("!!document.querySelector('.gut.snap,#snapTag.on')"), [saved, fit])

        # Rows: the same at the bottom
        await pg.locator('#viewSeg [data-v=rows]').click(); await frames(pg)
        await pg.evaluate("document.querySelector('#panes').scrollTop=1e6"); await frames(pg)
        h0 = (await size(br))[1]; r = await gut.bounding_box(); x, y = r['x'] + 300, r['y'] + r['height'] / 2
        await pg.mouse.move(x, y); await pg.mouse.down()
        await pg.mouse.move(x, edge[1] - 30, steps=5); await frames(pg)
        h1 = (await size(br))[1]
        await pg.mouse.move(x, edge[1] - 2); await pg.wait_for_timeout(3200)
        h2 = (await size(br))[1]; st = (await scroll())[1]
        await pg.mouse.up(); await frames(pg)
        check('Rows: held at the bottom edge, the last pane keeps growing', h2 > h1 + 200, [h0, h1, h2])
        check('…and the column scrolls along', st > 0, st)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
