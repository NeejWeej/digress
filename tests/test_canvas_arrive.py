"""Switching from columns to the canvas points out the card for the pane you were in: it flashes; the camera
moves only if that card is off screen; a card folded away is shown by the visible card holding it. Nothing
about either layout changes: a round trip leaves conv.ui (open panes, order, sizes, canvas folds, expanded
cards) and the panes' scroll exactly as they were. Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames, calm
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
FAKE = r"""
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{const out=('A reply with a few sentences in it. '.repeat(25)+'\n\n').repeat(3);opts.onText&&opts.onText({text:out});return {text:out,truncated:false};};
  return null;}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        async def ask(tid, q):
            ta = pg.locator(f'.pane[data-tid="{tid}"] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter'))
        await ask('main', 'Explain gradients')
        tids = []
        for q in ('First side question', 'Second side question'):
            await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').first.click(); await pg.wait_for_function('n => Object.keys(__digress.conv.threads).length > n', arg=len(tids) + 1)
            tid = await pg.evaluate(f"Object.keys(__digress.conv.threads).find(t=>t!=='main'&&!{json.dumps(tids)}.includes(t))")
            tids.append(tid); await ask(tid, q)
        b1, b2 = tids
        view = lambda v: pg.evaluate(f"document.querySelector('#viewSeg button[data-v={v}]').click()")
        state = lambda: pg.evaluate("JSON.stringify((({view,...u})=>u)(__digress.conv.ui))")
        scrolls = lambda: pg.evaluate("JSON.stringify([...document.querySelectorAll('#panes .pane')].map(p=>[p.dataset.tid,Math.round((p.querySelector('.pb')||{}).scrollTop||0)]).concat([[ 'strip',Math.round(document.getElementById('panes').scrollLeft)]]))")
        flashed = lambda: pg.evaluate("[...document.querySelectorAll('#cv .cnode.flash')].map(n=>n.dataset.ctid)")
        camxf = lambda: pg.evaluate("document.getElementById('world').style.transform")

        # visit the canvas once so it has a camera, then come back
        await view('canvas'); await calm(pg); await view('cols'); await calm(pg)
        await pg.locator(f'.pane[data-tid="{b1}"] .pb').evaluate('e=>e.scrollTop=120')
        await pg.locator(f'.pane[data-tid="{b1}"] .msg.assistant .body').first.click(); await frames(pg)
        s0, sc0 = await state(), await scrolls()

        # in view: it flashes and the camera stays
        await view('canvas'); await frames(pg); cam0 = await camxf(); await pg.wait_for_timeout(500)   # deliberate: longer than the camera's 280 ms glide, so a move would show
        check('the card for the pane you were in flashes (and only it)', await flashed() == [b1], await flashed())
        check('it was on screen, so the camera didn’t move', await camxf() == cam0, [cam0, await camxf()])
        await pg.wait_for_timeout(2600)   # (deliberate: past the flash, to see what stays)
        here = await pg.evaluate("[[...document.querySelectorAll('#cv .cnode.here')].map(n=>n.dataset.ctid),(document.getElementById('cvHereTag')||{}).textContent||'']")
        check('after the flash, the card stays quietly marked “You were here”', here == [[b1], 'You were here'], here)
        await pg.screenshot(path=OUT + '/canvas_arrive.png')
        await view('cols'); await calm(pg)
        check('round trip: the layout is exactly as it was', await state() == s0)
        await view('canvas'); await calm(pg)
        cvb = await pg.locator('#cv').bounding_box()
        bx, by = cvb['x'] + 30, cvb['y'] + cvb['height'] - 60   # empty background, bottom left
        await pg.mouse.move(bx, by); await pg.mouse.wheel(0, 40); await pg.wait_for_timeout(200)
        await pg.mouse.down(); await pg.mouse.move(bx + 80, by - 40, steps=6); await pg.mouse.up(); await pg.wait_for_timeout(200)
        check('looking around (zoom, pan) keeps the mark', await pg.locator('#cv .cnode.here').count() == 1 and await pg.locator('#cvHereTag').count() == 1)
        # wander far off, then the toolbar button glides back
        await pg.mouse.move(bx, by); await pg.mouse.down(); await pg.mouse.move(bx + 1500, by - 1200, steps=10); await pg.mouse.up(); await pg.wait_for_timeout(200)
        off = await pg.evaluate("(()=>{const c=document.getElementById('cv').getBoundingClientRect(),h=document.querySelector('#cv .cnode.here .ch').getBoundingClientRect();return h.right<c.left||h.left>c.right||h.bottom<c.top||h.top>c.bottom})()")
        check('(the test wandered off: the marked card is out of view)', off)
        btn = pg.locator('#zHere')
        check('while the mark exists, the canvas toolbar offers “You were here”', await btn.is_visible())
        await btn.click(); await pg.wait_for_timeout(600)   # (deliberate: the 280 ms glide)
        await pg.screenshot(path=OUT + '/canvas_here_button.png')
        back = await pg.evaluate("(()=>{const c=document.getElementById('cv').getBoundingClientRect(),h=document.querySelector('#cv .cnode.here .ch').getBoundingClientRect();return h.left>=c.left&&h.right<=c.right&&h.top>=c.top&&h.bottom<=c.bottom})()")
        check('…which glides back to the card, and the mark stays', back and await pg.locator('#cv .cnode.here').count() == 1)
        await pg.locator('#cv .cnode[data-ctid="main"] .ch .ct').click(); await pg.wait_for_timeout(200)
        check('it lasts the whole visit: clicking a card keeps it', await pg.locator('#cv .cnode.here').count() == 1 and await btn.is_visible())
        # drag the marked card: the label goes with it
        hh = pg.locator('#cv .cnode.here .ch .ct'); hb = await hh.bounding_box()
        await pg.mouse.move(hb['x'] + 10, hb['y'] + 5); await pg.mouse.down(); await pg.mouse.move(hb['x'] + 130, hb['y'] + 95, steps=8); await pg.mouse.up(); await pg.wait_for_timeout(300)
        gap = await pg.evaluate("(()=>{const c=document.querySelector('#cv .cnode.here').getBoundingClientRect(),t=document.getElementById('cvHereTag').getBoundingClientRect();return [Math.round(t.left-c.left),Math.round(c.top-t.bottom)]})()")
        check('dragging the marked card moves its label with it', 0 <= gap[0] <= 20 and 0 <= gap[1] <= 12 and await pg.locator('#cv .cnode.here').count() == 1, gap)
        await pg.locator('#zHereX').click(); await pg.wait_for_timeout(150)
        check('× beside the button removes the mark (and the button)', await pg.locator('#cv .cnode.here').count() == 0 and await pg.locator('#cvHereTag').count() == 0 and not await btn.is_visible())
        await view('cols'); await calm(pg); await view('canvas'); await calm(pg)   # a new visit marks again
        await view('cols'); await calm(pg)
        check('leaving the canvas clears it, and the toolbar button with it', await pg.locator('#cv .cnode.here').count() == 0 and await pg.locator('#cvHereTag').count() == 0 and not await btn.is_visible())
        await view('cols'); await calm(pg)
        check('…and so is every pane’s scroll', await scrolls() == sc0, [sc0, await scrolls()])

        # off screen: pan the canvas far away, then come back from b2
        await view('canvas'); await calm(pg)
        pt = await pg.evaluate("""(()=>{const c=document.getElementById('cv').getBoundingClientRect();
            for(let y=c.bottom-80;y>c.top+40;y-=30)for(let x=c.left+40;x<c.right-40;x+=30){const e=document.elementFromPoint(x,y);if(e&&['cv','world','edges'].includes(e.id))return [x,y]}return null})()""")
        before = await camxf()
        await pg.mouse.move(*pt); await pg.mouse.down()
        await pg.mouse.move(pt[0] - 2500, pt[1] - 2000, steps=12); await pg.mouse.up(); await frames(pg)
        far = await camxf()
        check('(the test panned the canvas away)', far != before, [before, far])
        await view('cols'); await calm(pg)
        await pg.locator(f'.pane[data-tid="{b2}"] .msg.assistant .body').first.click(); await frames(pg)
        s1 = await state()
        await view('canvas'); await calm(pg)
        vis = await pg.evaluate(f"""(()=>{{const c=document.getElementById('cv').getBoundingClientRect(),h=document.querySelector('#cv .cnode[data-ctid="{b2}"] .ch').getBoundingClientRect();
            return h.left>=c.left&&h.right<=c.right&&h.top>=c.top&&h.bottom<=c.bottom}})()""")
        check('an off-screen card: the camera pans to it', await camxf() != far and vis, [far, await camxf()])
        check('…and it flashes', b2 in await flashed())
        await view('cols'); await calm(pg)
        check('still nothing changed in the layout', await state() == s1)

        # folded away: the visible card holding it flashes; the fold stays
        await view('canvas'); await calm(pg)
        await pg.evaluate("__digress.conv.ui.cv.fold=['main']")
        await view('cols'); await calm(pg)
        await pg.locator(f'.pane[data-tid="{b1}"] .msg.assistant .body').first.click(); await frames(pg)
        s2 = await state()
        await view('canvas'); await calm(pg)
        check('a card folded away: the card holding it flashes', await flashed() == ['main'], await flashed())
        check('…and it stays folded', await pg.evaluate("JSON.stringify(__digress.conv.ui.cv.fold)") == '["main"]' and not await pg.locator(f'#cv .cnode[data-ctid="{b1}"]').count())
        await view('cols'); await calm(pg)
        check('…and the layout is untouched', await state() == s2)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
