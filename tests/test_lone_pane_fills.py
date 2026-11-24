"""A pane whose width you dragged keeps it, but when it's the only one not collapsed (or every one not collapsed has a
dragged width, and it's the last) it fills the space: collapsing
(or closing) the others no longer leaves it narrow beside empty space. Its width comes back when another pane opens;
one made wider than the screen stays that wide.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
const now = Date.now();
localStorage.setItem('fakesrv:convs/cl', JSON.stringify({id: 'cl', title: 'C', created: now, updated: now, rev: 1,
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}, b1: {id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'Fine', anchorRange: {s: 0, e: 4}, title: 'One', colorIdx: 0, created: now}, b2: {id: 'b2', parent: 'main', anchorMsg: 'a1', anchorText: 'thanks', anchorRange: {s: 6, e: 12}, title: 'Two', colorIdx: 1, created: now}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Hi', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'Fine, thanks.', ts: now}},
  order: {main: ['u1', 'a1'], b1: [], b2: []}, nextColor: 2}));
localStorage.setItem('fakesrv:layout/cl', JSON.stringify({devices: {other: {at: now, ui: {open: ['main', 'b1', 'b2'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
"""
FAKE = "window.fakeLLM = {use: async () => async () => ({text: 'ok'})};"
W = "tid => Math.round(document.querySelector(`.pane[data-tid=${tid}]`).getBoundingClientRect().width)"
ROOM = """(() => { const p = document.getElementById('panes'), cs = getComputedStyle(p); let used = 0;
  for (const c of p.children) if (!c.matches('.pane:not(.rail)')) used += c.getBoundingClientRect().width + parseFloat(getComputedStyle(c).marginLeft) + parseFloat(getComputedStyle(c).marginRight);
  return Math.round(p.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - used) })()"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        pg = await b.new_page(viewport={'width': 1440, 'height': 860}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg); await pg.wait_for_selector('.pane[data-tid=b2]')
        # drag main's handle to make it narrower
        g = await pg.locator('.pane[data-tid=main] + .gut').bounding_box(); x, y = g['x'] + g['width'] / 2, g['y'] + 200
        await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x - 80, y, steps=6); await pg.mouse.up(); await frames(pg)
        dragged = await pg.evaluate(W, 'main')
        check('dragging sets main’s width', await pg.evaluate("!!__digress.conv.ui.sizes.main"), dragged)
        for t in ('b1', 'b2'):
            await pg.locator(f'.pane[data-tid={t}] [data-act=collapse]').click(); await frames(pg, 3)
        room = await pg.evaluate(ROOM)
        check('with the others collapsed, it fills the space', abs(await pg.evaluate(W, 'main') - room) <= 2, [dragged, await pg.evaluate(W, 'main'), room])
        await pg.screenshot(path=OUT + '/lone_pane_fills.png')
        await pg.locator('.pane[data-tid=b1]').click(); await frames(pg, 3)
        check('expanding another brings its dragged width back', abs(await pg.evaluate(W, 'main') - dragged) <= 2, [dragged, await pg.evaluate(W, 'main')])
        await pg.locator('.pane[data-tid=b1] [data-act=close]').click(); await frames(pg, 3)
        check('closing the other open one: it fills again', abs(await pg.evaluate(W, 'main') - await pg.evaluate(ROOM)) <= 2, [await pg.evaluate(W, 'main'), await pg.evaluate(ROOM)])
        # two panes with dragged widths and one without, which closes (or is the one Collapse others kept, then
        # closed): the last of the two fills the rest, the first keeps its width
        await pg.evaluate("(()=>{const u=__digress.conv.ui;u.open=['main','b1','b2'];u.collapsed=[];u.sizes={main:400,b1:380}})(); document.querySelector('#viewSeg button[data-v=cols]').click()"); await frames(pg, 3)
        await pg.locator('.pane[data-tid=b2] [data-act=focus]').click(); await frames(pg, 3)
        await pg.locator('.pane[data-tid=b2] [data-act=close]').click(); await frames(pg, 3)
        mw, bw, room = await pg.evaluate(W, 'main'), await pg.evaluate(W, 'b1'), await pg.evaluate(ROOM)
        check('closing the only pane without a dragged width leaves no empty space', abs(mw + bw - room) <= 3 and abs(mw - 400) <= 2, [mw, bw, room])
        await pg.screenshot(path=OUT + '/lone_pane_fills_two.png')
        # wider than the screen on purpose: stays that wide
        await pg.evaluate("__digress.conv.ui.sizes.main = 2000; document.querySelector('#viewSeg button[data-v=cols]').click()"); await frames(pg, 3)
        check('a pane made wider than the screen stays that wide', await pg.evaluate(W, 'main') >= 1995, await pg.evaluate(W, 'main'))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
