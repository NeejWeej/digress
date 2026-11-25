"""Reordering panes by touch: a long press (about 380 ms) anywhere on a pane's header (the title area, not a button,
link, input or a title being renamed) picks the pane up, and moving the finger reorders the panes; letting go
saves the order. A swipe that moves before the hold ends does nothing (the header still scrolls), a short tap
does nothing, and no text is left selected. Chromium only (touch input through the DevTools Protocol).
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, answered, frames, calm, soon, saved, chromium_only
chromium_only('touch input through the Chrome DevTools Protocol')
from common import CORS
from test_pane_zoom import MAP

FAKE = r"""
window.fakeLLM = {use: async (n) => n !== 'sample' ? null : async (input, opts) => {
  const out = 'Attention is a soft dictionary lookup over the keys, scaled by the square root of the dimension.';
  opts.onText && opts.onText({text: out}); return {text: out, truncated: false}; }};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)

order = lambda pg: pg.evaluate("[...document.querySelectorAll('#panes>.pane')].map(p=>p.querySelector('.ph-title').textContent)")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        ctx = await b.new_context(viewport={'width': 1300, 'height': 800}, has_touch=True)
        pg = await ctx.new_page()
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
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await answered(pg, ta.press('Enter'))
        for word, q in [('soft dictionary', 'Why soft?'), ('square root', 'Why the root?')]:
            await pg.evaluate('''(word) => { const body = document.querySelector('.pane[data-tid=main] .msg.assistant .body');
              const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.nodeValue.indexOf(word);
              if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
              document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); }''', word)
            await pg.locator('#popIn').fill(q); await answered(pg, pg.locator('#popIn').press('Enter'))
        await pg.locator('[data-v=cols]').click(); await calm(pg)
        o0 = await order(pg)
        check('three panes in Columns', o0 == ['What is attention?', 'Why soft?', 'Why the root?'], str(o0))
        cdp = await ctx.new_cdp_session(pg)
        async def touch(kind, px=0, py=0): await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': px, 'y': py}]})
        title = lambda name: pg.locator(f'.pane:has(.ph-title:text-is("{name}")) .ph-title')
        async def spot(name):
            bb = await title(name).bounding_box()
            return bb['x'] + min(30, bb['width'] / 2), bb['y'] + bb['height'] / 2
        async def selection_empty(): return await pg.evaluate('getSelection().isCollapsed')

        # a quick swipe along the header: nothing is picked up
        x, y = await spot('Why soft?')
        await touch('touchStart', x, y)
        for i in range(1, 12): await touch('touchMove', x + 30 * i, y); await pg.wait_for_timeout(15)   # deliberate: a finger moving
        await pg.wait_for_timeout(500)   # deliberate: past the hold time, to see that nothing starts late
        await touch('touchEnd')
        check('a swipe that moves before the hold ends reorders nothing', await order(pg) == o0 and await pg.locator('.pdrag').count() == 0, str(await order(pg)))
        # a short tap: nothing
        await touch('touchStart', x, y); await pg.wait_for_timeout(80); await touch('touchEnd')   # deliberate: shorter than the hold
        await pg.wait_for_timeout(500)   # deliberate: nothing should start after the finger left
        check('a short tap picks nothing up', await order(pg) == o0 and await pg.locator('.pdrag').count() == 0)

        # long press on the second pane's title, drag right past the third
        x, y = await spot('Why soft?')
        await touch('touchStart', x, y)
        await pg.wait_for_function("!!document.querySelector('.pane.pdrag')", timeout=5000)
        check('holding the header picks the pane up', await pg.evaluate("document.querySelector('.pane.pdrag .ph-title').textContent") == 'Why soft?')
        check('…and no text is selected', await selection_empty(), await pg.evaluate('String(getSelection())'))
        third = await pg.locator('.pane:has(.ph-title:text-is("Why the root?"))').bounding_box()
        tx = third['x'] + third['width'] - 40
        for i in range(1, 25): await touch('touchMove', x + (tx - x) * i / 24, y); await pg.wait_for_timeout(15)   # deliberate: a finger moving
        await soon(pg, "[...document.querySelectorAll('#panes>.pane')].map(p=>p.querySelector('.ph-title').textContent).join()==='What is attention?,Why the root?,Why soft?'")
        await touch('touchEnd'); await frames(pg)
        o1 = await order(pg)
        check('moving right past the third pane reorders them', o1 == ['What is attention?', 'Why the root?', 'Why soft?'], str(o1))
        check('letting go puts the pane down', await pg.locator('.pdrag').count() == 0 and await pg.locator('#panes.reordering').count() == 0)
        check('…and no text is left selected', await selection_empty(), await pg.evaluate('String(getSelection())'))
        await saved(pg, layout=True)
        saved_order = await pg.evaluate("__digress.conv.ui.open.map(t=>t)")
        check('the order is saved in the conversation', saved_order[-1] != 'main' and len(saved_order) == 3 and saved_order[0] == 'main', str(saved_order))
        check('no page errors', not errs, '; '.join(errs[:3]))
        await ctx.close(); await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
