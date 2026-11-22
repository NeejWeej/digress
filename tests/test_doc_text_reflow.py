"""A text document keeps its place when its pane changes width.
  Closing another pane (or the sidebar) makes the document's pane wider, and Markdown re-wraps at once: the same
  scroll offset would point somewhere else. The pane puts the reading spot back (as a PDF does after it's redrawn).
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, OUT, settle

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
const now = Date.now(), text = Array.from({length: 120}, (_, i) => `Paragraph ${i}. ` + 'The quick brown fox jumps over the lazy dog while the reader keeps going. '.repeat(4)).join('\n\n');
localStorage.setItem('fakesrv:convs/ct', JSON.stringify({id: 'ct', title: 'Notes', created: now, updated: now, rev: 1, doc: {kind: 'text', name: 'notes.md', text},
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}, b1: {id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'Fine', anchorRange: {s: 0, e: 4}, title: 'A branch', colorIdx: 0, created: now}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Hi', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'Fine, thanks.', ts: now}},
  order: {main: ['u1', 'a1'], b1: []}, nextColor: 1}));
localStorage.setItem('fakesrv:layout/ct', JSON.stringify({devices: {other: {at: now, ui: {open: ['doc', 'b1'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
"""
FAKE = "window.fakeLLM = {use: async () => async (m, o) => ({text: 'ok'})};"
# the paragraph at the reading line (15% down the pane)
AT_LINE = """(() => { const pb = document.querySelector('.pane[data-tid=doc] .pb'), r = pb.getBoundingClientRect(), y = r.top + pb.clientHeight * 0.15;
  const ps = [...pb.querySelectorAll('.docbody p')]; const p = ps.find(p => { const b = p.getBoundingClientRect(); return b.top <= y && b.bottom >= y }) || ps.find(p => p.getBoundingClientRect().top > y);
  return p ? p.textContent.slice(0, 14) : null })()"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg)
        await pg.wait_for_selector('.pane[data-tid=doc] .docbody p'); await pg.wait_for_selector('.pane[data-tid=b1]')
        await pg.evaluate("(() => { const pb = document.querySelector('.pane[data-tid=doc] .pb'); pb.scrollTop = pb.scrollHeight * 0.6 })()")
        await settle(pg, 400)   # the spot is noted 150 ms after scrolling stops
        before = await pg.evaluate(AT_LINE); w0 = await pg.evaluate("document.querySelector('.pane[data-tid=doc] .pb').clientWidth")
        await pg.locator('.pane[data-tid=b1] [data-act=close]').click(); await frames(pg, 6)
        w1 = await pg.evaluate("document.querySelector('.pane[data-tid=doc] .pb').clientWidth")
        check('closing a branch makes the document wider', w1 > w0 + 100, [w0, w1])
        check('…and the same paragraph is still at the reading line', await pg.evaluate(AT_LINE) == before, [before, await pg.evaluate(AT_LINE)])
        await pg.locator('#tSide').click(); await frames(pg, 6)
        check('hiding the sidebar keeps it too', await pg.evaluate(AT_LINE) == before, [before, await pg.evaluate(AT_LINE)])
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
