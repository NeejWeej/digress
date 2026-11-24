"""Starting a side question keeps the parent pane where it was.
  Side question (the reply's button, or the selection popup) bumps the reply's version and redraws it, so the pane is
  briefly shorter and the browser pulls its scroll up; the new branch pane then narrows the parent. The reader's place
  (the text at the reading line) must be the same afterwards: in Columns and Rows, desktop and iPad sizes, with and
  without Chrome's scroll anchoring (Safari has none).
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, settle, soon

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
const now = Date.now(), long = (w) => Array.from({length: 40}, (_, i) => `${w} ${i}. ` + 'The quick brown fox jumps over the lazy dog. '.repeat(4)).join('\n\n');
localStorage.setItem('fakesrv:convs/cp', JSON.stringify({id: 'cp', title: 'Long', created: now, updated: now, rev: 1,
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Q1', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: long('A'), ts: now},
    u2: {id: 'u2', role: 'user', thread: 'main', content: 'Q2', ts: now}, a2: {id: 'a2', role: 'assistant', thread: 'main', content: long('B'), ts: now}},
  order: {main: ['u1', 'a1', 'u2', 'a2']}, nextColor: 0}));
localStorage.setItem('fakesrv:layout/cp', JSON.stringify({devices: {other: {at: now, ui: {open: ['main'], collapsed: [], layout: LAYOUT, view: 'panes', sizes: {}}}}}));
"""
FAKE = "window.fakeLLM = {use: async () => async (m, o) => ({text: 'ok'})};"
AT_LINE = """() => { const pb = document.querySelector('.pane[data-tid=main] .pb'), y = pb.getBoundingClientRect().top + pb.clientHeight * 0.15;
  const ps = [...pb.querySelectorAll('.msg.assistant .body p')]; const p = ps.find(p => { const b = p.getBoundingClientRect(); return b.top <= y && b.bottom >= y }) || ps.find(p => p.getBoundingClientRect().top > y);
  return p ? p.textContent.slice(0, 9) : null }"""
# the character at the reading line: noted once (by message, paragraph number and offset, since the message is rebuilt),
# then how far (px) it has moved on screen since (0 = it didn't move)
NOTE_CHAR = """() => { const pb = document.querySelector('.pane[data-tid=main] .pb'), r0 = pb.getBoundingClientRect(), y = r0.top + pb.clientHeight * 0.15;
  const r = document.caretRangeFromPoint(r0.left + pb.clientWidth / 2, y), p = (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer).closest('.body p');
  const m = p.closest('.msg'), idx = [...m.querySelectorAll('.body p')].indexOf(p), w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n, k = 0;
  while ((n = w.nextNode()) && n !== r.startContainer) k += n.nodeValue.length;
  k += r.startOffset; const c = document.createRange(); c.setStart(r.startContainer, r.startOffset); c.setEnd(r.startContainer, r.startOffset + 1);
  window.__ch = {mid: m.dataset.mid, idx, k, top: c.getClientRects()[0].top}; return true }"""
CHAR_OFF = """() => { const h = window.__ch, pb = document.querySelector('.pane[data-tid=main] .pb'), p = pb.querySelector(`.msg[data-mid=${h.mid}]`).querySelectorAll('.body p')[h.idx];
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n, k = h.k; while ((n = w.nextNode())) { if (k < n.nodeValue.length) break; k -= n.nodeValue.length }
  const c = document.createRange(); c.setStart(n, k); c.setEnd(n, k + 1); return Math.round(c.getClientRects()[0].top - h.top) }"""
# select a word in the last paragraph of the first reply that is in view and let the popup open
SELECT = """() => { const pb = document.querySelector('.pane[data-tid=main] .pb'), t = pb.getBoundingClientRect().top;
  const p = [...pb.querySelectorAll('.msg[data-mid=a1] .body p')].filter(p => p.getBoundingClientRect().bottom > t + 40).pop();
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT), n = w.nextNode(), i = n.nodeValue.indexOf('quick'), r = document.createRange();
  r.setStart(n, i); r.setEnd(n, i + 5); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); }"""

async def run(p, layout, w, h, how, noanchor):
    tag = f'{layout} {w}x{h} {how}{" no-anchoring" if noanchor else ""}: '
    b = await p.chromium.launch(**launch_args())
    pg = await b.new_page(viewport={'width': w, 'height': h})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED.replace('LAYOUT', repr(layout)) + "}" + FAKE)
    await goto_app(pg); await booted(pg)
    if noanchor: await pg.add_style_tag(content='.pane .pb{overflow-anchor:none !important}')
    btn = '.msg[data-mid=a1] [data-act=wbranch]'
    await pg.wait_for_selector(btn)
    await pg.evaluate(f"document.querySelector('{btn}').scrollIntoView({{block: 'center'}})")
    await settle(pg, 300)
    here = await pg.evaluate(AT_LINE); await pg.evaluate(NOTE_CHAR)
    check(tag + 'set up: scrolled well into the reply', here is not None and here.startswith('A '), here)
    if how == 'button':
        await pg.locator(btn).click()
    else:
        await pg.evaluate(SELECT)
        await pg.locator('#popIn').fill('Why quick?'); await pg.locator('#popIn').press('Enter')
    await soon(pg, "document.querySelectorAll('.pane').length >= 2")
    await settle(pg, 500)
    after = await pg.evaluate(AT_LINE)
    # in Rows the pane gets shorter, and so does the reading line's distance from its top: only the character is compared
    if layout == 'cols': check(tag + 'the paragraph at the reading line is the same', after == here, [here, after])
    # exact: the redraw replaces the text node the pane noted, so renderPane notes the spot again
    off = await pg.evaluate(CHAR_OFF); print('  off', tag, off)
    check(tag + 'the text at the reading line moved at most 3px on screen', abs(off) <= 3, off)
    check(tag + 'no page errors', not errs, errs[:3])
    await b.close()

async def main():
    async with async_playwright() as p:
        for noanchor in (False, True):
            await run(p, 'cols', 1400, 900, 'button', noanchor)
            await run(p, 'cols', 1180, 820, 'button', noanchor)
            await run(p, 'cols', 820, 1180, 'button', noanchor)
            await run(p, 'rows', 1400, 900, 'button', noanchor)
            await run(p, 'cols', 1400, 900, 'popup', noanchor)
            await run(p, 'rows', 1180, 820, 'popup', noanchor)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
