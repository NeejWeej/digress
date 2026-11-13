"""Reordering panes by dragging their headers (Columns and Rows). A drag needs a few pixels of movement
with a mouse and a press-and-hold on touch, so clicks, header buttons, double-click rename and swiping
between panes keep working. The order is saved. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import OUT, launch_args, goto_app
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


async def setup(pg):
    async def route(r):
        u = r.request.url
        for k, v in MAP.items():
            if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
        if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
        await r.continue_()
    await pg.route('**/*', route)
    await pg.add_init_script(FAKE)
    await goto_app(pg); await pg.wait_for_timeout(1200)
    ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await ta.press('Enter'); await pg.wait_for_timeout(700)
    for word, q in [('soft dictionary', 'Why soft?'), ('square root', 'Why the root?')]:
        await pg.evaluate('''(word) => { const body = document.querySelector('.pane[data-tid=main] .msg.assistant .body');
          const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.nodeValue.indexOf(word);
          if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
          document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); }''', word)
        await pg.wait_for_timeout(150)
        await pg.locator('#popIn').fill(q); await pg.locator('#popIn').press('Enter'); await pg.wait_for_timeout(900)

order = lambda pg: pg.evaluate("[...document.querySelectorAll('#panes>.pane')].map(p=>p.querySelector('.ph-title').textContent)")


async def drag(pg, src, dx, dy, steps=12, to=None):
    box = await src.bounding_box()
    x, y = box['x'] + box['width'] * 0.45, box['y'] + 16
    if to: dx, dy = to[0] - x, to[1] - y
    await pg.mouse.move(x, y); await pg.mouse.down()
    for i in range(1, steps + 1): await pg.mouse.move(x + dx * i / steps, y + dy * i / steps); await pg.wait_for_timeout(15)
    await pg.mouse.up(); await pg.wait_for_timeout(300)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1600, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await setup(pg)
        o0 = await order(pg)
        check('three panes, branches beside main', o0 == ['What is attention?', 'Why soft?', 'Why the root?'], str(o0))
        main_ph = pg.locator('.pane[data-tid=main] .ph-main')
        await drag(pg, main_ph, 0, 0, to=(1580, 90))
        o1 = await order(pg)
        check('dragging the main header to the right moves it to the end', o1 == ['Why soft?', 'Why the root?', 'What is attention?'], str(o1))
        check('nothing is left half-dragged', await pg.locator('.pdrag').count() == 0 and await pg.locator('#panes.reordering').count() == 0)
        await pg.screenshot(path=OUT + '/pane_order.png')
        await drag(pg, pg.locator('.pane:has(.ph-title:text-is("Why the root?")) .ph-main'), 0, 0, to=(300, 90))
        o2 = await order(pg)
        check('and back: drag a branch to the front', o2[0] == 'Why the root?', str(o2))
        await drag(pg, main_ph, 3, 0, steps=3)
        check('a tiny wobble is a click, not a drag', await order(pg) == o2)
        # header buttons and rename still work
        await pg.locator('.pane:has(.ph-title:text-is("Why soft?")) [data-act=collapse]').click(); await pg.wait_for_timeout(300)
        check('header buttons still click', await pg.locator('.pane.rail').count() == 1)
        await pg.locator('.pane.rail').click(); await pg.wait_for_timeout(300)
        t = pg.locator('.pane:has(.ph-title:text-is("Why the root?")) .ph-title')
        await t.dblclick(); await pg.keyboard.type('Renamed'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(300)
        check('double-click still renames a branch', 'Renamed' in await order(pg), str(await order(pg)))
        await pg.wait_for_timeout(900)
        await pg.reload(); await pg.wait_for_timeout(1800)
        check('the order is kept after a reload', (await order(pg))[0] == 'Renamed', str(await order(pg)))
        check('"Reset order" shows once the panes are out of branching order', await pg.locator('#resetOrder').is_visible())
        await pg.locator('#resetOrder').click(); await pg.wait_for_timeout(300)
        check('…and puts them back: main, then each branch after it', await order(pg) == ['What is attention?', 'Why soft?', 'Renamed'] and not await pg.locator('#resetOrder').is_visible(), str(await order(pg)))
        await drag(pg, main_ph, 0, 0, to=(1580, 90))
        # rows
        await pg.locator('[data-v=rows]').click(); await pg.wait_for_timeout(500)
        before = await order(pg)
        await drag(pg, pg.locator('#panes>.pane').first.locator('.ph-main'), 0, 700)
        after = await order(pg)
        check('in Rows, dragging a header down moves the pane down', after != before and after.index(before[0]) > 0, f'{before} -> {after}')
        check('no page errors', not errs, '; '.join(errs[:3]))
        await pg.close()

        # touch: a quick swipe scrolls, a press-and-hold drags
        ctx = await b.new_context(viewport={'width': 412, 'height': 860}, has_touch=True, is_mobile=True, device_scale_factor=2)
        pg = await ctx.new_page(); await setup(pg)
        cdp = await ctx.new_cdp_session(pg)
        await pg.evaluate("document.querySelector('#panes').scrollLeft=0"); await pg.wait_for_timeout(200)
        o0 = await order(pg)
        box = await pg.locator('.pane[data-tid=main] .ph-main').bounding_box()
        x, y = box['x'] + 20, box['y'] + 14
        async def touch(kind, px, py): await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': px, 'y': py}]})
        await touch('touchStart', x, y)
        for i in range(1, 10): await touch('touchMove', x - 25 * i, y); await pg.wait_for_timeout(16)
        await touch('touchEnd', 0, 0); await pg.wait_for_timeout(400)
        check('touch: a quick swipe on a header does not reorder', await order(pg) == o0 and await pg.locator('.pdrag').count() == 0)
        await pg.evaluate("document.querySelector('#panes').scrollLeft=0"); await pg.wait_for_timeout(200)
        box = await pg.locator('.pane[data-tid=main] .ph-main').bounding_box()
        x, y = box['x'] + 20, box['y'] + 14
        await touch('touchStart', x, y); await pg.wait_for_timeout(500)
        for i in range(1, 30): await touch('touchMove', min(405, x + 14 * i), y); await pg.wait_for_timeout(20)
        for i in range(60): await touch('touchMove', 405 - (i % 2), y); await pg.wait_for_timeout(16)   # held at the edge: the panes scroll along
        await pg.wait_for_timeout(200)
        check('touch: holding shows the pane as picked up', await pg.locator('.pane.pdrag').count() == 1)
        mid = await order(pg)
        await touch('touchEnd', 0, 0); await pg.wait_for_timeout(400)
        check('touch: press and hold, then drag, reorders', mid != o0 and await order(pg) == mid and mid[0] != 'What is attention?', f'{o0} -> {mid}')
        await ctx.close()
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
