"""Reordering panes by dragging their grips, or a collapsed strip itself (Columns and Rows). A drag needs a few pixels of movement
with a mouse and a press-and-hold on touch, so clicks, header buttons, double-click rename and swiping
between panes keep working. The order is saved. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import OUT, launch_args, goto_app, booted, answered, saved, frames, calm, chromium_only
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


async def setup(pg):
    async def route(r):
        u = r.request.url
        for k, v in MAP.items():
            if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
        if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
        await r.continue_()
    await pg.route('**/*', route)
    await pg.add_init_script(FAKE)
    await goto_app(pg); await booted(pg)
    ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await answered(pg, ta.press('Enter'))
    for word, q in [('soft dictionary', 'Why soft?'), ('square root', 'Why the root?')]:
        await pg.evaluate('''(word) => { const body = document.querySelector('.pane[data-tid=main] .msg.assistant .body');
          const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.nodeValue.indexOf(word);
          if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
          document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); }''', word)
        await pg.locator('#popIn').fill(q); await answered(pg, pg.locator('#popIn').press('Enter'))

order = lambda pg: pg.evaluate("[...document.querySelectorAll('#panes>.pane')].map(p=>p.querySelector('.ph-title').textContent)")


async def drag(pg, src, dx, dy, steps=12, to=None):
    box = await src.bounding_box()
    x, y = box['x'] + box['width'] * 0.45, box['y'] + min(16, box['height'] / 2)
    if to: dx, dy = to[0] - x, to[1] - y
    await pg.mouse.move(x, y); await pg.mouse.down()
    for i in range(1, steps + 1): await pg.mouse.move(x + dx * i / steps, y + dy * i / steps); await pg.wait_for_timeout(15)
    await pg.mouse.up(); await pg.wait_for_timeout(300)   # deliberate: the app ignores clicks for 250 ms after a drag (quietUntil), and a drag that shouldn't move anything gets its chance to


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1600, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await setup(pg)
        o0 = await order(pg)
        check('three panes, branches beside main', o0 == ['What is attention?', 'Why soft?', 'Why the root?'], str(o0))
        main_ph = pg.locator('.pane[data-tid=main] .pgrip')
        await drag(pg, pg.locator('.pane[data-tid=main] .ph-main'), 0, 0, to=(1580, 90))
        check('dragging the header itself (not the grip) moves nothing', await order(pg) == o0, str(await order(pg)))
        await drag(pg, main_ph, 0, 0, to=(1580, 90))
        o1 = await order(pg)
        check('dragging the main pane’s grip to the right moves it to the end', o1 == ['Why soft?', 'Why the root?', 'What is attention?'], str(o1))
        check('nothing is left half-dragged', await pg.locator('.pdrag').count() == 0 and await pg.locator('#panes.reordering').count() == 0)
        await pg.screenshot(path=OUT + '/pane_order.png')
        await drag(pg, pg.locator('.pane:has(.ph-title:text-is("Why the root?")) .pgrip'), 0, 0, to=(300, 90))
        o2 = await order(pg)
        check('and back: drag a branch to the front', o2[0] == 'Why the root?', str(o2))
        await drag(pg, main_ph, 3, 0, steps=3)
        check('a tiny wobble is a click, not a drag', await order(pg) == o2)
        # header buttons and rename still work
        await pg.locator('.pane:has(.ph-title:text-is("Why soft?")) [data-act=collapse]').click(); await frames(pg)
        check('header buttons still click', await pg.locator('.pane.rail').count() == 1)
        before = await order(pg)
        await drag(pg, pg.locator('.pane.rail'), 0, 0, to=(1580, 300))
        after = await order(pg)
        check('a collapsed strip drags too: to the end', after[-1] == 'Why soft?' and after != before, f'{before} -> {after}')
        check('…and stays collapsed', await pg.locator('.pane.rail').count() == 1 and await pg.locator('.pdrag').count() == 0)
        await pg.locator('.pane.rail').click(); await frames(pg)
        check('a click on a strip still expands it', await pg.locator('.pane.rail').count() == 0)
        t = pg.locator('.pane:has(.ph-title:text-is("Why the root?")) .ph-title')
        await t.dblclick(); await pg.keyboard.type('Renamed'); await pg.keyboard.press('Enter'); await frames(pg)
        check('double-click still renames a branch', 'Renamed' in await order(pg), str(await order(pg)))
        crumbs = await pg.evaluate("[...document.querySelectorAll('#panes .ph-origin')].map(o=>[o.closest('.pane').dataset.tid,[...o.querySelectorAll('.crumb')].map(c=>c.textContent)])")
        check('every branch header’s crumbs are links, the direct parent included', all(len(c) >= 1 for tid, c in crumbs if tid != 'main'), crumbs)
        pc = pg.locator('.pane:has(.ph-title:text-is("Why soft?")) .ph-origin .crumb').last
        await pg.locator('.pane[data-tid=main] .pb').evaluate('e=>e.scrollTop=e.scrollHeight')
        before = await order(pg); await pc.click(); await calm(pg)
        flashed = await pg.locator('.pane[data-tid=main] .anchor.flash').count()
        check('clicking the direct parent shows where the branch starts (and moves no pane)', flashed > 0 and await order(pg) == before, [flashed, await order(pg)])
        await saved(pg, layout=True)
        await pg.reload(); await booted(pg)
        check('the order is kept after a reload', (await order(pg))[0] == 'Renamed', str(await order(pg)))
        check('"Reset order" shows once the panes are out of branching order', await pg.locator('#resetOrder').is_visible())
        await pg.locator('#resetOrder').click(); await frames(pg)
        check('…and puts them back: main, then each branch after it', await order(pg) == ['What is attention?', 'Why soft?', 'Renamed'] and not await pg.locator('#resetOrder').is_visible(), str(await order(pg)))
        await drag(pg, main_ph, 0, 0, to=(1580, 90))
        # rows
        await pg.locator('[data-v=rows]').click(); await calm(pg)
        before = await order(pg)
        await drag(pg, pg.locator('#panes>.pane').first.locator('.pgrip'), 0, 700)
        after = await order(pg)
        check('in Rows, dragging a grip down moves the pane down', after != before and after.index(before[0]) > 0, f'{before} -> {after}')
        await pg.locator('#panes>.pane').first.locator('[data-act=collapse]').click(); await frames(pg)
        before = await order(pg)
        await drag(pg, pg.locator('.pane.rail'), 0, 700)
        after = await order(pg)
        check('in Rows, a collapsed strip drags down too', after != before and after.index(before[0]) > 0 and await pg.locator('.pane.rail').count() == 1, f'{before} -> {after}')
        check('no page errors', not errs, '; '.join(errs[:3]))
        await pg.close()

        # touch: a swipe on the header scrolls; the grip drags
        ctx = await b.new_context(viewport={'width': 412, 'height': 860}, has_touch=True, is_mobile=True, device_scale_factor=2)
        pg = await ctx.new_page(); await setup(pg)
        cdp = await ctx.new_cdp_session(pg)
        await pg.evaluate("document.querySelector('#panes').scrollLeft=0"); await calm(pg)
        o0 = await order(pg)
        box = await pg.locator('.pane[data-tid=main] .ph-main').bounding_box()
        x, y = box['x'] + 20, box['y'] + 14
        async def touch(kind, px, py): await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': px, 'y': py}]})
        await touch('touchStart', x, y)
        for i in range(1, 10): await touch('touchMove', x - 25 * i, y); await pg.wait_for_timeout(16)
        await touch('touchEnd', 0, 0); await pg.wait_for_timeout(400)   # deliberate: a swipe that wrongly started a drag gets its chance to show
        check('touch: a swipe on a header (not the grip) does not reorder', await order(pg) == o0 and await pg.locator('.pdrag').count() == 0)
        await pg.evaluate("document.querySelector('#panes').scrollLeft=0"); await calm(pg)
        box = await pg.locator('.pane[data-tid=main] .pgrip').bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        await touch('touchStart', x, y); await pg.wait_for_timeout(30)
        for i in range(1, 30): await touch('touchMove', min(405, x + 14 * i), y); await pg.wait_for_timeout(20)
        for i in range(60): await touch('touchMove', 405 - (i % 2), y); await pg.wait_for_timeout(16)   # held at the edge: the panes scroll along
        await frames(pg)
        check('touch: dragging the grip picks the pane up (no hold needed)', await pg.locator('.pane.pdrag').count() == 1)
        mid = await order(pg)
        await touch('touchEnd', 0, 0); await frames(pg)
        check('touch: …and reorders', mid != o0 and await order(pg) == mid and mid[0] != 'What is attention?', f'{o0} -> {mid}')
        await ctx.close()
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
