"""The sidebar with many conversations.
  - Pinned and Conversations fold from their headings (remembered on this device).
  - A long list scrolls inside itself, so Branches and How it works stay on screen without scrolling the sidebar.
  - Opening a conversation far down the list brings its row into view in the list.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
for (let i = 0; i < 60; i++) {
  const id = 'c' + String(i).padStart(3, '0'), t = Date.now() - i * 60000;
  localStorage.setItem('fakesrv:convs/' + id, JSON.stringify({id, title: 'Conversation number ' + i, created: t, updated: t, rev: 1,
    threads: {main: {id: 'main', parent: null, title: 'Main', colorIdx: 0}}, msgs: {}, order: {main: []}, nextColor: 1, pinned: i < 3}));
}
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}")
        await goto_app(pg); await booted(pg)
        await pg.wait_for_function("document.querySelectorAll('#clist .citem').length > 50"); await frames(pg)
        help_top = await pg.evaluate("document.getElementById('help').getBoundingClientRect().top")
        check('a long list scrolls inside itself: How it works is on screen', help_top < 800, help_top)
        check('…and the sidebar itself barely scrolls', await pg.evaluate("(()=>{const s=document.getElementById('side');return s.scrollHeight-s.clientHeight})()") < 400)
        check('the conversations list scrolls', await pg.evaluate("(()=>{const l=document.getElementById('clist');return l.scrollHeight>l.clientHeight+100})()"))
        await pg.screenshot(path=OUT + '/side_fold_open.png')

        await pg.locator('#convWrap .sfold').click(); await pg.locator('#pinWrap .sfold').click(); await frames(pg)
        check('Conversations and Pinned fold', await pg.evaluate("[...document.querySelectorAll('#clist,#plist,#archWrap')].every(e=>!e.getClientRects().length)"))
        check('…and How it works moves up', await pg.evaluate("document.getElementById('help').getBoundingClientRect().top") < help_top - 200)
        await pg.screenshot(path=OUT + '/side_fold_folded.png')
        await pg.reload(); await booted(pg); await frames(pg)
        check('folding is remembered', await pg.evaluate("document.getElementById('convWrap').classList.contains('folded')&&document.getElementById('pinWrap').classList.contains('folded')"))
        await pg.locator('#convWrap .sfold').click(); await frames(pg)
        check('unfolds again', await pg.locator('#clist .citem').first.is_visible())

        # open one far down: its row comes into view in the list
        await pg.evaluate("document.querySelector('#clist .citem[data-conv=c055]').click()")
        await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c055'"); await frames(pg, 4)
        vis = await pg.evaluate("(()=>{const l=document.getElementById('clist').getBoundingClientRect(),r=document.querySelector('#clist .citem.cur').getBoundingClientRect();return r.top>=l.top-1&&r.bottom<=l.bottom+1})()")
        check('the open conversation’s row is in view in the list', vis)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
