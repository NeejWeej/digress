"""Closing a pane keeps the branches under it open, and every expanded pane can be resized.
  - ✕ on a pane closes just that pane; open branches under it stay open. A toast says so and offers
    "Close them too", which closes them as well.
  - The rightmost pane has a handle on its right edge, so its width can be changed even after it got a
    saved width; double-clicking that handle resets it.
  - A handle next to a collapsed strip resizes the pane on its other side (it did nothing before).
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, soon, frames, calm
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const q=input[input.length-1].content;
  const out='Attention lets each token weigh every other token. The weights come from a softmax over scores.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1600, 'height': 860})
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
            ta = pg.locator(f'.pane[data-tid="{tid}"] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter')); await frames(pg)
        async def branch_from(tid, q):
            before = await pg.evaluate('Object.keys(__digress.conv.threads)')
            await pg.locator(f'.pane[data-tid="{tid}"] [data-act="wbranch"]').first.click()
            await pg.wait_for_function('n => Object.keys(__digress.conv.threads).length > n', arg=len(before))
            new = await pg.evaluate(f"Object.keys(__digress.conv.threads).find(t=>!{json.dumps(before)}.includes(t))")
            await ask(new, q); return new
        async def relayout():   # the Columns button lays the panes out again from conv.ui (sizes kept)
            await pg.locator('#viewSeg [data-v=cols]').click(); await frames(pg)
        opened = lambda: pg.evaluate('__digress.conv.ui.open')
        width = lambda tid: pg.evaluate(f"document.querySelector('.pane[data-tid=\"{tid}\"]').getBoundingClientRect().width")
        async def drag(gut, dx):
            r = await gut.bounding_box(); x, y = r['x'] + r['width'] / 2, r['y'] + r['height'] / 2
            await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x + dx / 2, y); await pg.mouse.move(x + dx, y); await pg.mouse.up(); await frames(pg)

        await ask('main', 'Explain attention')
        b1 = await branch_from('main', 'Why a softmax?')
        b1a = await branch_from(b1, 'Why not a sigmoid?')
        await calm(pg)
        check('setup: main, a branch and a branch of it are open', await opened() == ['main', b1, b1a], await opened())

        # ✕ closes just that pane
        await pg.locator(f'.pane[data-tid="{b1}"] [data-act=close]').click(); await calm(pg)
        o = await opened()
        check('✕ closes the pane but leaves the branch under it open', b1 not in o and b1a in o, o)
        toast = pg.locator('#toast.show')
        check('a toast says the branch under it is still open', await toast.count() == 1 and 'still open' in await toast.inner_text(), await pg.locator('#toast').inner_text())
        await pg.screenshot(path=OUT + '/close_toast.png')
        await toast.locator('.tact').click(); await calm(pg)
        o = await opened()
        check('"Close them too" closes it as well', b1a not in o and o == ['main'], o)
        check('…and the toast goes away', not await pg.locator('#toast.show').count())

        # closing a pane with nothing open under it: no toast with a button
        await pg.evaluate(f"__digress.conv.ui.open.push('{b1}')"); await relayout(); await soon(pg, f"!!document.querySelector('.pane[data-tid=\"{b1}\"]')")
        await calm(pg)
        await pg.locator(f'.pane[data-tid="{b1}"] [data-act=close]').click(); await calm(pg)
        check('no "Close them too" when nothing is open under it', not await pg.locator('#toast.show .tact').count())

        # ✕ only closes: the parent stays where you'd scrolled it, even far from where the branch came from (that's Back)
        for i in range(8): await ask('main', f'And then what happens, part {i + 1}?')
        await pg.evaluate(f"__digress.conv.ui.open.push('{b1}')"); await relayout(); await soon(pg, f"!!document.querySelector('.pane[data-tid=\"{b1}\"]')")
        # (scrolled to the end: closing widens the parent and its text reflows, so compare what's in view, not pixels)
        pb = pg.locator('.pane[data-tid="main"] .pb'); await pb.evaluate('e=>e.scrollTop=e.scrollHeight'); await calm(pg)
        at_end = "e=>[Math.round(e.scrollTop), e.scrollHeight-e.clientHeight-e.scrollTop<4]"
        y0 = await pb.evaluate(at_end)
        await pg.locator(f'.pane[data-tid="{b1}"] [data-act=close]').click(); await calm(pg)
        # (the parent reflows after the close and WebKit, with no scroll anchoring, puts the view back a moment later: wait for the end, then read)
        await soon(pg, "()=>{const e=document.querySelector('.pane[data-tid=\"main\"] .pb');return e.scrollHeight-e.clientHeight-e.scrollTop<4}")
        y1 = await pb.evaluate(at_end)
        check('✕ leaves the parent showing what it showed (its end), not where the branch came from', y0[0] > 300 and y0[1] and y1[1], [y0, y1])

        # the rightmost pane can be resized
        await pg.evaluate(f"(()=>{{const u=__digress.conv.ui;u.open=['main','{b1}','{b1a}'];u.collapsed=[];u.sizes={{}}}})()")
        await relayout(); await calm(pg)
        last_gut = pg.locator(f'#panes > .pane[data-tid="{b1a}"] + .gut')
        check('the rightmost pane has a handle on its right edge', await last_gut.count() == 1)
        w0 = await width(b1a); await drag(last_gut, -50)
        w1 = await width(b1a)
        check('dragging it makes the rightmost pane narrower', abs((w0 - 50) - w1) < 6, [w0, w1])
        # a saved width on the rightmost pane (it was sized somewhere else, then ended up last) can still change
        await pg.evaluate(f"(()=>{{const u=__digress.conv.ui;u.sizes['{b1a}']=420}})()"); await relayout(); await frames(pg)
        await drag(last_gut, 100)
        w2 = await width(b1a)
        check('…even when it already has a saved width', abs(w2 - 520) < 6, w2)
        await last_gut.dblclick(); await frames(pg)
        check('double-clicking its handle resets it', f'{b1a}' not in await pg.evaluate('__digress.conv.ui.sizes'), await pg.evaluate('__digress.conv.ui.sizes'))

        # a handle next to a collapsed strip resizes the pane on its other side
        await pg.locator(f'.pane[data-tid="{b1}"] [data-act=collapse]').click(); await calm(pg)
        mid_gut = pg.locator(f'#panes > .pane[data-tid="{b1}"] + .gut')
        w0 = await width(b1a); await drag(mid_gut, 80)
        w1 = await width(b1a)
        check('the handle after a collapsed strip resizes the next pane (toward it = narrower)', abs((w0 - 80) - w1) < 6, [w0, w1])
        check('…and the strip stays a strip', await pg.locator(f'.pane[data-tid="{b1}"].rail').count() == 1)
        await mid_gut.dblclick(); await frames(pg)
        check('…double-clicking it resets that pane', f'{b1a}' not in await pg.evaluate('__digress.conv.ui.sizes'))
        await pg.screenshot(path=OUT + '/resize.png')

        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
