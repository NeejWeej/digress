"""From the document, the main thread is one tap away: the document's branch list (its header's "N branches") starts
with the main thread, the conversation's other head, even with no branches off the document, and it opens main's pane
when it's closed. Just main's row, not its branches.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def seed(branch):
    b = (", d1: {id: 'd1', parent: 'main', anchorMsg: 'DOC', anchorText: 'quick brown', anchorRange: {s: 4, e: 15}, title: 'Doc branch', colorIdx: 0, created: now}, m1: {id: 'm1', parent: 'main', anchorMsg: 'a1', anchorText: 'Fine', anchorRange: {s: 0, e: 4}, title: 'Main branch', colorIdx: 1, created: now}" if branch else '')
    order = ", d1: [], m1: []" if branch else ''
    return r"""
const now = Date.now();
localStorage.setItem('fakesrv:convs/cd', JSON.stringify({id: 'cd', title: 'Notes', created: now, updated: now, rev: 1, doc: {kind: 'text', name: 'notes.md', text: 'The quick brown fox.\n\nAnother paragraph.'},
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}""" + b + r"""},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Hi', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'Fine, thanks.', ts: now}},
  order: {main: ['u1', 'a1']""" + order + r"""}, nextColor: 2}));
localStorage.setItem('fakesrv:layout/cd', JSON.stringify({devices: {other: {at: now, ui: {open: ['doc'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        for branch in (True, False):
            pg = await b.new_page(viewport={'width': 1280, 'height': 820}); pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + seed(branch) + "}window.fakeLLM={use:async()=>async()=>({text:'ok'})};")
            await goto_app(pg); await booted(pg); await pg.wait_for_selector('.pane[data-tid=doc]')
            what = 'with a branch off the document' if branch else 'with no branches off it'
            check(f'{what}: only the document is open', await pg.locator('#panes .pane[data-tid=main]').count() == 0)
            btn = pg.locator('.pane[data-tid=doc] [data-brlist=doc]')
            check(f'{what}: the document’s header has its branch list', await btn.count() == 1)
            await btn.click(); await frames(pg)
            rows = await pg.evaluate("[...document.querySelectorAll('.brpop .mnode')].map(n => n.dataset.map)")
            check(f'{what}: the list starts with the main thread', rows[:1] == ['main'], rows)
            check(f'{what}: …just its row, not its branches (the document’s own follow)', rows == (['main', 'd1'] if branch else ['main']), rows)
            if branch: await pg.locator('.brpop').screenshot(path=OUT + '/doc_opens_main.png')
            await pg.locator('.brpop .mnode[data-map=main]').click(); await frames(pg, 4)
            check(f'{what}: tapping it opens the main thread', await pg.locator('#panes .pane[data-tid=main]').count() == 1 and not await pg.locator('.brpop').count())
            await pg.close()
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
