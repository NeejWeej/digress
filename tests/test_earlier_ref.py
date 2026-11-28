"""[earlier "…"] links in Columns view.
  - The passage is earlier in the same thread: the pane scrolls up to it and floats a "Back to where you were" pill
    (class backpill, with hasprev); the pill goes back, its x hides it but leaves the small return button; scrolling
    back by hand near the old spot hides it.
  - The passage is in a parent thread: the pane you're reading stays where it is (no pill), the parent opens (also
    from a strip) and scrolls to it, and the top bar's Back chip shows.
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, soon, frames

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

QUOTE = 'the lighthouse keeper counted seven grey gulls'
FILL = lambda tag, n: '\n\n'.join(f'{tag} filler paragraph {i} with some ordinary words to take up room.' for i in range(n))
msgs, order = {}, {'main': [], 'bb': [], 'same': []}
def add(mid, tid, role, content, ts):
    msgs[mid] = {'id': mid, 'thread': tid, 'role': role, 'content': content, 'ts': ts}; order[tid].append(mid)
# main: an early answer holding the quote, then long filler, then a reply citing it
add('m1', 'main', 'user', 'Tell me a story', 100)
add('m2', 'main', 'assistant', f'Once, {QUOTE} at dawn.\n\n' + FILL('Early', 3), 101)
add('m3', 'main', 'user', 'More', 102)
add('m4', 'main', 'assistant', FILL('Middle', 60), 103)
add('m5', 'main', 'user', 'Recall?', 104)
add('m6', 'main', 'assistant', f'Recall that [earlier "{QUOTE}"].\n\n' + FILL('Late', 40), 105)
# a branch from m2 that cites main's passage
add('b1', 'bb', 'user', 'Branch question', 200)
add('b2', 'bb', 'assistant', FILL('Branch', 60) + f'\n\nBack in main, [earlier "{QUOTE}"].', 201)
CONV = {
    'id': 'c_earl', 'title': 'Earlier', 'titleKept': True, 'created': 100, 'updated': 100, 'rev': 1,
    'threads': {
        'main': {'id': 'main', 'parent': None, 'title': 'Main', 'created': 100},
        'bb': {'id': 'bb', 'parent': 'main', 'anchorMsg': 'm2', 'anchorText': 'Once', 'anchorRange': {'s': 0, 'e': 4}, 'title': 'Branch B', 'colorIdx': 0, 'created': 200},
    },
    'order': {'main': order['main'], 'bb': order['bb']}, 'msgs': msgs,
}
def seed(ui):
    return "if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" \
        "localStorage.setItem('fakesrv:convs/c_earl',%s);localStorage.setItem('fakesrv:layout/c_earl',%s);}" % (
        json.dumps(json.dumps(CONV)), json.dumps(json.dumps({'devices': {'other': {'at': 100, 'ui': ui}}})))
BASE = {'layout': 'cols', 'view': 'panes', 'sizes': {}}

async def page(b, ui):
    pg = await (await b.new_context(viewport={'width': 1400, 'height': 850})).new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script(seed(ui))
    await goto_app(pg); await booted(pg)
    await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_earl'")
    return pg, errs

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, **launch_args())

        # (a) same thread
        pg, errs = await page(b, dict(BASE, open=['main'], collapsed=[]))
        sel = '.pane[data-tid="main"]'
        await pg.wait_for_function("(()=>{const l=document.querySelector('%s .msg[data-mid=\"m6\"] a.pref[data-earlier]');return !!l})()" % sel)
        pb = pg.locator(sel + ' .pb')
        await pb.evaluate("p=>{p.scrollTop=p.scrollHeight}"); await frames(pg)
        await pb.evaluate("p=>{const m=p.querySelector('.msg[data-mid=\"m6\"]');p.scrollTop=m.offsetTop-20}"); await frames(pg)
        spot = await pb.evaluate("p=>p.scrollTop")
        await pg.locator(sel + ' .msg[data-mid="m6"] a.pref[data-earlier]').click()
        await soon(pg, "() => document.querySelector('%s').classList.contains('hasprev')" % sel)
        await soon(pg, "() => document.querySelector('%s .pb').scrollTop < %d - 300" % (sel, spot))
        cls = await pg.locator(sel).get_attribute('class')
        check('same thread: pane scrolled up and has hasprev + backpill', 'hasprev' in cls and 'backpill' in cls, cls)
        check('same thread: the pill is visible', await pg.locator(sel + ' .jb-go').is_visible())
        await pg.locator(sel + ' .jb-go').click()
        await soon(pg, "() => Math.abs(document.querySelector('%s .pb').scrollTop - %d) < 60" % (sel, spot))
        await soon(pg, "() => !document.querySelector('%s').classList.contains('backpill')" % sel)
        check('Back returns to the old spot and the pill hides', not await pg.locator(sel + ' .jb-go').is_visible())

        # x dismisses the pill, keeps the small button
        await pg.locator(sel + ' .msg[data-mid="m6"] a.pref[data-earlier]').click()
        await soon(pg, "() => document.querySelector('%s').classList.contains('backpill')" % sel)
        await pg.locator(sel + ' .jb-x').click()
        await soon(pg, "() => !document.querySelector('%s').classList.contains('backpill')" % sel)
        check('x hides the pill but leaves the small return button', 'hasprev' in await pg.locator(sel).get_attribute('class')
              and await pg.locator(sel + ' .jump .jp').is_visible())
        # scrolling back by hand hides the small button too (after the jump settles)
        await pg.wait_for_function("(()=>{const e=document.querySelector('%s');return !e.__jumping})()" % sel)
        await pb.evaluate("(p,y)=>{p.scrollTop=y}", spot); await frames(pg)
        await soon(pg, "() => !document.querySelector('%s').classList.contains('hasprev')" % sel)
        check('scrolling back by hand near the old spot clears it', True)
        # and the pill itself clears that way
        await pb.evaluate("(p,y)=>{p.scrollTop=y}", spot); await frames(pg)
        await pg.locator(sel + ' .msg[data-mid="m6"] a.pref[data-earlier]').click()
        await soon(pg, "() => document.querySelector('%s').classList.contains('backpill')" % sel)
        await pg.wait_for_function("(()=>{const e=document.querySelector('%s');return !e.__jumping})()" % sel)
        await pb.evaluate("(p,y)=>{p.scrollTop=y+10}", spot); await frames(pg)
        await soon(pg, "() => !document.querySelector('%s').classList.contains('backpill')" % sel)
        check('scrolling back by hand hides the pill', True)
        check('(a) no page errors', not errs, errs[:3])
        await pg.context.close()

        # (b) a parent's passage: main open, or collapsed into a strip
        for collapsed in ([], ['main']):
            pg, errs = await page(b, dict(BASE, open=['main', 'bb'], collapsed=collapsed))
            bs = '.pane[data-tid="bb"]'
            await pg.wait_for_function("!!document.querySelector('%s .msg[data-mid=\"b2\"] a.pref[data-earlier]')" % bs)
            await pg.locator(bs + ' .pb').evaluate("p=>{p.scrollTop=p.scrollHeight}"); await frames(pg)   # the link is at the end: clicking must not scroll it into view
            before = await pg.locator(bs + ' .pb').evaluate("p=>p.scrollTop")
            await pg.locator(bs + ' .msg[data-mid="b2"] a.pref[data-earlier]').click()
            tag = 'parent (main %s)' % ('collapsed' if collapsed else 'open')
            await soon(pg, "() => document.querySelector('.pane[data-tid=\"main\"]:not(.rail)') && document.getElementById('backChip').classList.contains('show')")
            await frames(pg, 3)
            after, maxs, w = await pg.locator(bs + ' .pb').evaluate("p=>[p.scrollTop,p.scrollHeight-p.clientHeight,p.clientWidth]")
            # (expanding the strip narrows this pane and reflows it, so it keeps its place at the bottom rather than the same pixel)
            check(tag + ': the clicking pane stays where it was', abs(after - (maxs if collapsed else before)) < 2, (before, after, maxs))
            check(tag + ': no pill in it', 'backpill' not in await pg.locator(bs).get_attribute('class'))
            check(tag + ': the parent is open (expanded)', await pg.locator('.pane[data-tid="main"]:not(.rail)').count() == 1)
            await soon(pg, "() => { const pb=document.querySelector('.pane[data-tid=main] .pb').getBoundingClientRect(),m=document.querySelector('.pane[data-tid=main] .msg[data-mid=m2]').getBoundingClientRect(); return m.bottom>pb.top&&m.top<pb.bottom }")
            vis = await pg.evaluate("(()=>{const pb=document.querySelector('.pane[data-tid=\"main\"] .pb').getBoundingClientRect(),m=document.querySelector('.pane[data-tid=\"main\"] .msg[data-mid=\"m2\"]').getBoundingClientRect();return m.bottom>pb.top&&m.top<pb.bottom})()")
            check(tag + ': it scrolled to the passage', vis)
            check(tag + ': the Back chip shows', await pg.locator('#backChip').is_visible())
            check(tag + ': no page errors', not errs, errs[:3])
            await pg.context.close()
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
