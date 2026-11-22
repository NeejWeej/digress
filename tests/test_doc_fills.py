"""Closing every other pane leaves the document filling the panes area, and it keeps its place while it grows
(a text document re-wraps; see test_doc_text_reflow.py). Run in WebKit too (Safari: an iPad).
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
const now = Date.now(), text = Array.from({length: 80}, (_, i) => `Paragraph ${i}. ` + 'The quick brown fox jumps over the lazy dog. '.repeat(5)).join('\n\n');
localStorage.setItem('fakesrv:convs/ct', JSON.stringify({id: 'ct', title: 'Notes', created: now, updated: now, rev: 1, doc: {kind: 'text', name: 'notes.md', text},
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}, b1: {id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'Fine', anchorRange: {s: 0, e: 4}, title: 'A branch', colorIdx: 0, created: now}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Hi', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'Fine, thanks.', ts: now}},
  order: {main: ['u1', 'a1'], b1: []}, nextColor: 1}));
localStorage.setItem('fakesrv:layout/ct', JSON.stringify({devices: {other: {at: now, ui: {open: ['doc', 'main', 'b1'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
"""
FAKE = "window.fakeLLM = {use: async () => async () => ({text: 'ok'})};"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        errs = []
        for w, h in ((1366, 860), (1180, 820)):   # a laptop; an iPad in landscape
            pg = await b.new_page(viewport={'width': w, 'height': h}); pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
            await goto_app(pg); await booted(pg); await pg.wait_for_selector('.pane[data-tid=b1]'); await pg.wait_for_selector('.pane[data-tid=doc] .docbody p')
            await pg.locator('.pane[data-tid=b1] [data-act=close]').click(); await frames(pg, 4)
            await pg.locator('.pane[data-tid=main] [data-act=close]').click(); await frames(pg, 4)
            dw, pw = await pg.evaluate("[document.querySelector('.pane[data-tid=doc]').getBoundingClientRect().width, document.getElementById('panes').clientWidth]")
            check(f'{w}px: with everything else closed, the document fills the panes area', dw >= pw - 30, [dw, pw])
            await pg.screenshot(path=f'{OUT}/doc_fills_{w}.png')
            await pg.close()
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
