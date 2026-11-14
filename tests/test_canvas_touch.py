"""Canvas on a phone: one-finger pan, two-finger pinch zoom, dragging a card by its header,
and scrolling inside a card without moving the canvas. Touches go through CDP so Chromium's
real gesture handling (touch-action, pointercancel) applies. Asserts and exits non-zero."""
import asyncio, re, sys
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, launch_args, goto_app, booted, answered, calm

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
}
FAKE = r"""
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{
    const out=Array.from({length:40},(_,i)=>'Paragraph '+i+' about attention and how the scores are scaled.').join('\n\n');
    opts.onText&&opts.onText({text:out});return {text:out,truncated:false};};
  return null;}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain attention'); await answered(pg, ta.press('Enter'))
        await pg.locator('[data-v=canvas]').click(); await pg.locator('.cnode').first.wait_for(); await calm(pg)
        cdp = await ctx.new_cdp_session(pg)

        async def touch(paths, steps=10):
            """paths: list of ((x0,y0),(x1,y1)), one per finger, moved together."""
            pts = lambda t: [{'x': a[0] + (c[0] - a[0]) * t, 'y': a[1] + (c[1] - a[1]) * t, 'id': i} for i, (a, c) in enumerate(paths)]
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': pts(0)})
            for s in range(1, steps + 1):
                await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': pts(s / steps)})
                await pg.wait_for_timeout(16)
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            await calm(pg)   # until nothing moves (a fling, or a camera that shouldn't move)

        async def camera():
            t = await pg.evaluate("document.getElementById('world').style.transform")
            x, y, k = map(float, re.findall(r'-?[\d.]+', t)[:3])
            return x, y, k

        # an empty spot on the canvas (not on a card or the zoom tools)
        spot = await pg.evaluate("""(()=>{const r=document.getElementById('cv').getBoundingClientRect();
          for(let y=r.bottom-90;y>r.top+20;y-=20)for(let x=r.left+20;x<r.right-20;x+=20){const e=document.elementFromPoint(x,y);
            if(e&&e.closest('#cv')&&!e.closest('.cnode,.cvtools'))return [x,y]}return null})()""")
        check('found an empty canvas spot', spot is not None)
        sx, sy = spot

        x0, y0, k0 = await camera()
        await touch([((sx, sy), (sx + 80, sy - 120))])
        x1, y1, k1 = await camera()
        check('one-finger pan moves the camera', abs(x1 - x0 - 80) < 6 and abs(y1 - y0 + 120) < 6, f'dx={x1 - x0:.0f} dy={y1 - y0:.0f}')

        cx, cy = 195, sy - 150
        await touch([((cx - 40, cy), (cx - 90, cy)), ((cx + 40, cy), (cx + 90, cy))])   # 2.25x, under the 2.5 cap
        x2, y2, k2 = await camera()
        check('pinch out zooms in', abs(k2 - k1 * 2.25) < 0.08, f'k {k1:.2f} -> {k2:.2f}')
        # the world point under the pinch centre should stay under it
        wx, wx2 = (cx - x1) / k1, (cx - x2) / k2
        check('pinch keeps its centre fixed', abs(wx - wx2) < 4, f'{wx:.1f} vs {wx2:.1f}')
        await touch([((cx - 90, cy), (cx - 40, cy)), ((cx + 90, cy), (cx + 40, cy))])
        _, _, k3 = await camera()
        check('pinch in zooms back out', abs(k3 - k1) < 0.05, f'k {k2:.2f} -> {k3:.2f}')
        check('page itself did not zoom', await pg.evaluate('visualViewport.scale') == 1)

        await pg.locator('#zFit').click(); await calm(pg)
        card = pg.locator('.cnode').last
        hb = await card.locator('.ch').bounding_box(); left0 = await card.evaluate('e=>e.offsetLeft')
        hx, hy = hb['x'] + 40, hb['y'] + hb['height'] / 2
        _, _, kf = await camera()
        await touch([((hx, hy), (hx + 60, hy + 40))])
        left1 = await card.evaluate('e=>e.offsetLeft')
        check('dragging a card header moves the card', abs((left1 - left0) * kf - 60) < 8, f'{left0} -> {left1}')

        # open a card so it has a scrollable body, then scroll it with a finger
        if not await pg.locator('.cnode.exp .cfull').count():
            await pg.locator('.cnode [data-cact=exp]').first.tap(); await calm(pg)
        f = pg.locator('.cnode .cfull').first
        if await f.count():
            await f.evaluate('e=>e.scrollTop=0')
            fb = await f.bounding_box(); cam0 = await camera()
            fx, fy = fb['x'] + fb['width'] / 2, fb['y'] + min(fb['height'] - 20, 300)
            await touch([((fx, fy), (fx, fy - 150))])
            st = await f.evaluate('e=>e.scrollTop')
            check('finger scroll inside a card scrolls it', st > 50, f'scrollTop={st}')
            check('...and leaves the canvas alone', await camera() == cam0)
        else:
            check('expanded card has a body', False)

        await pg.screenshot(path=OUT + '/touch1.png')
        check('no page errors', not errs, '; '.join(errs[:5]))
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
