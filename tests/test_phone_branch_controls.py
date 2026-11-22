"""A branch's controls on a phone (touch).
  - The header line takes you back to where the branch came from: tapping the quoted passage, or the parent's name in
    the breadcrumb, brings the parent pane into view, scrolled to the passage. They're real buttons: as styled spans, a
    tap went to the line around them (a phone's tap goes to the nearest clickable thing) and nothing happened.
  - The takeaway bar can be put away: its ✕ is on top (the floating search button used to cover it), and a swipe
    closes it too.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, settle, soon, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
const now = Date.now(), para = (i) => `Paragraph ${i}. Some text about the topic, going on for a while longer than a line.`;
const long = [...Array.from({length: 20}, (_, i) => para(i)), 'The special marker phrase lives here.', ...Array.from({length: 25}, (_, i) => para(i + 20))].join('\n\n');
localStorage.setItem('fakesrv:convs/ch', JSON.stringify({id: 'ch', title: 'Long', created: now, updated: now, rev: 1,
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}, b1: {id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'special marker phrase', anchorRange: {s: 0, e: 0}, title: 'About the marker', colorIdx: 0, created: now}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Tell me a lot', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: long, ts: now},
    u2: {id: 'u2', role: 'user', thread: 'b1', content: 'What is this marker?', ts: now}, a2: {id: 'a2', role: 'assistant', thread: 'b1', content: 'It marks the spot.', ts: now}},
  order: {main: ['u1', 'a1'], b1: ['u2', 'a2']}, nextColor: 1}));
localStorage.setItem('fakesrv:layout/ch', JSON.stringify({devices: {other: {at: now, ui: {open: ['main', 'b1'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
"""
# the passage is on screen: main's pane is in view, and the marker is inside main's visible area
SHOWN = """(() => { const pane = document.querySelector('.pane[data-tid=main]'), pr = pane.getBoundingClientRect();
  const pb = pane.querySelector('.pb').getBoundingClientRect(), a = pane.querySelector('.anchor[data-tid=b1]'); if (!a) return false;
  const r = a.getBoundingClientRect(); return pr.left >= -2 && pr.right <= innerWidth + 2 && r.top >= pb.top && r.bottom <= pb.bottom })()"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        pg = await b.new_page(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('s')){sessionStorage.setItem('s','1');" + SEED + "}window.fakeLLM={use:async()=>async()=>({text:'ok'})};")
        await goto_app(pg); await booted(pg); await pg.wait_for_selector('.pane[data-tid=b1]')
        async def away():   # main scrolled to its end (past the passage), the branch's pane in view
            await pg.evaluate("(()=>{const pb=document.querySelector('.pane[data-tid=main] .pb');pb.scrollTop=pb.scrollHeight;document.querySelector('.pane[data-tid=b1]').scrollIntoView()})()"); await settle(pg, 100)
        await away()
        check('to start: the passage isn’t on screen', not await pg.evaluate(SHOWN))
        quote = pg.locator('.pane[data-tid=b1] .ph-origin [data-back]')
        check('the header’s quote is a button', await quote.evaluate("e => e.tagName") == 'BUTTON')
        await quote.tap(); await settle(pg, 300)
        check('tapping the quote brings the parent into view, at the passage', await soon(pg, SHOWN), await pg.evaluate("document.getElementById('panes').scrollLeft"))
        await pg.screenshot(path=OUT + '/header_quote_touch.png')
        await away()
        crumb = pg.locator('.pane[data-tid=b1] .ph-origin [data-crumb]').first
        check('the parent’s name in the breadcrumb is a button too', await crumb.evaluate("e => e.tagName") == 'BUTTON' and (await crumb.inner_text()) == 'Main')
        await crumb.tap(); await settle(pg, 300)
        check('…and tapping it does the same', await soon(pg, SHOWN))
        # the takeaway bar: its ✕ isn't covered, and a swipe puts it away
        await pg.evaluate("document.querySelector('.pane[data-tid=b1]').scrollIntoView()"); await settle(pg, 100)
        tk = pg.locator('.pane[data-tid=b1] .tk')
        await pg.locator('.pane[data-tid=b1] .ph [data-act=take]').tap(); await frames(pg, 3)
        x = pg.locator('.pane[data-tid=b1] .tk [data-act=take]'); bb = await x.bounding_box()
        top = await pg.evaluate("([x, y]) => { const e = document.elementFromPoint(x, y); return e && !!e.closest('.tk [data-act=take]') }", [bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2])
        check('the takeaway bar’s ✕ is on top, not under the floating search button', top)
        await pg.screenshot(path=OUT + '/takeaway_bar_phone.png')
        await x.tap(); await frames(pg, 3)
        check('…and tapping it puts the bar away', not await tk.evaluate("e => e.classList.contains('show')"))
        await pg.locator('.pane[data-tid=b1] .ph [data-act=take]').tap(); await frames(pg, 3)
        lab = await pg.locator('.pane[data-tid=b1] .tk .tkl').bounding_box()
        cdp = await pg.context.new_cdp_session(pg) if __import__('common').BROWSER == 'chromium' else None
        if cdp:   # a real swipe, through touch events
            sx, sy = lab['x'] + 10, lab['y'] + lab['height'] / 2
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': sx, 'y': sy}]})
            for i in range(1, 6): await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': sx + 25 * i, 'y': sy}]})
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); await frames(pg, 3)
            check('a swipe across the bar puts it away too', not await tk.evaluate("e => e.classList.contains('show')"))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
