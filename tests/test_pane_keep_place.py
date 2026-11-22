"""Thread panes keep their place when their width changes.
  Collapsing, expanding or closing another pane (or hiding the sidebar) makes the others wider or narrower, and their
  text re-wraps: the same scroll offset would point somewhere else. Each pane puts back what was at its reading line
  (the message, the paragraph, how far into it), and a pane at the bottom stays at the bottom.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, OUT, settle

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
const now = Date.now(), long = (w) => Array.from({length: 60}, (_, i) => `${w} ${i}. ` + 'The quick brown fox jumps over the lazy dog while the reader keeps going. '.repeat(3)).join('\n\n');
localStorage.setItem('fakesrv:convs/cp', JSON.stringify({id: 'cp', title: 'Long', created: now, updated: now, rev: 1,
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1},
    b1: {id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'Para', anchorRange: {s: 0, e: 4}, title: 'One', colorIdx: 0, created: now},
    b2: {id: 'b2', parent: 'main', anchorMsg: 'a1', anchorText: 'quick', anchorRange: {s: 10, e: 15}, title: 'Two', colorIdx: 1, created: now}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Tell me a lot', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: long('Para'), ts: now},
    u2: {id: 'u2', role: 'user', thread: 'b1', content: 'More', ts: now}, a2: {id: 'a2', role: 'assistant', thread: 'b1', content: long('Side'), ts: now},
    u3: {id: 'u3', role: 'user', thread: 'b2', content: 'Again', ts: now}, a3: {id: 'a3', role: 'assistant', thread: 'b2', content: long('Bit'), ts: now}},
  order: {main: ['u1', 'a1'], b1: ['u2', 'a2'], b2: ['u3', 'a3']}, nextColor: 2}));
localStorage.setItem('fakesrv:layout/cp', JSON.stringify({devices: {other: {at: now, ui: {open: ['main', 'b1', 'b2'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
"""
FAKE = "window.fakeLLM = {use: async () => async (m, o) => ({text: 'ok'})};"
AT_LINE = """tid => { const pb = document.querySelector(`.pane[data-tid=${tid}] .pb`), y = pb.getBoundingClientRect().top + pb.clientHeight * 0.15;
  const ps = [...pb.querySelectorAll('.msg.assistant .body p')]; const p = ps.find(p => { const b = p.getBoundingClientRect(); return b.top <= y && b.bottom >= y }) || ps.find(p => p.getBoundingClientRect().top > y);
  return p ? p.textContent.slice(0, 9) : null }"""
# the character at the reading line: noted once, then how far (px) it has moved on screen since (0 = it didn't move)
NOTE_CHAR = """tid => { const pb = document.querySelector(`.pane[data-tid=${tid}] .pb`), y = pb.getBoundingClientRect().top + pb.clientHeight * 0.15;
  const r = document.caretRangeFromPoint(pb.getBoundingClientRect().left + pb.clientWidth / 2, y), c = document.createRange(); c.setStart(r.startContainer, r.startOffset); c.setEnd(r.startContainer, r.startOffset + 1);
  window.__ch = {node: r.startContainer, off: r.startOffset, top: c.getClientRects()[0].top}; return true }"""
CHAR_OFF = """tid => { const pb = document.querySelector(`.pane[data-tid=${tid}] .pb`), y = pb.getBoundingClientRect().top + pb.clientHeight * 0.15, h = window.__ch;
  const c = document.createRange(); c.setStart(h.node, h.off); c.setEnd(h.node, h.off + 1); return Math.round(c.getClientRects()[0].top - h.top) }"""
AT_BOTTOM = "tid => { const pb = document.querySelector(`.pane[data-tid=${tid}] .pb`); return pb.scrollHeight - pb.scrollTop - pb.clientHeight < 4 }"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1180, 'height': 820})   # an iPad in landscape: narrow panes, their headers wrap
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg)
        # Safari has no scroll anchoring: turn Chrome's off, so only Digress keeps the place (as on an iPad)
        await pg.add_style_tag(content='.pane .pb{overflow-anchor:none !important}')
        await pg.wait_for_selector('.pane[data-tid=b2] .msg.assistant .body p')
        await pg.evaluate("(() => { const m = document.querySelector('.pane[data-tid=main] .pb'); m.scrollTop = m.scrollHeight * 0.55; const b = document.querySelector('.pane[data-tid=b2] .pb'); b.scrollTop = b.scrollHeight })()")
        await settle(pg, 400)
        here = await pg.evaluate(AT_LINE, 'main'); await pg.evaluate(NOTE_CHAR, 'main')
        width = lambda: pg.evaluate("document.querySelector('.pane[data-tid=main] .pb').clientWidth")
        w0 = await width()
        head = lambda: pg.evaluate("document.querySelector('.pane[data-tid=main] .ph').offsetHeight"); h0 = await head()

        await pg.locator('.pane[data-tid=b1] [data-act=collapse]').click(); await frames(pg, 6)
        check('collapsing a branch makes the others wider', await width() > w0 + 30, [w0, await width()])
        check('…and main keeps its place', await pg.evaluate(AT_LINE, 'main') == here, [here, await pg.evaluate(AT_LINE, 'main')])
        check('…exactly: the text at the reading line didn’t move on screen', abs(await pg.evaluate(CHAR_OFF, 'main')) <= 2, await pg.evaluate(CHAR_OFF, 'main'))
        check('…and a branch at the bottom stays at the bottom', await pg.evaluate(AT_BOTTOM, 'b2'))
        await pg.locator('.pane[data-tid=b1]').click(); await frames(pg, 6)
        check('expanding it again: main still in place', await pg.evaluate(AT_LINE, 'main') == here, [here, await pg.evaluate(AT_LINE, 'main')])
        await pg.locator('#tSide').click(); await frames(pg, 6)
        check('hiding the sidebar: still in place', await pg.evaluate(AT_LINE, 'main') == here, [here, await pg.evaluate(AT_LINE, 'main')])
        await pg.locator('.pane[data-tid=b2] [data-act=close]').click(); await frames(pg, 6)
        check('…by now main’s header is shorter (its buttons no longer wrap), which moved the text before', await head() < h0 - 10, [h0, await head()])
        check('closing a branch: still in place', await pg.evaluate(AT_LINE, 'main') == here, [here, await pg.evaluate(AT_LINE, 'main')])
        check('…exactly, after expanding, hiding the sidebar and closing', abs(await pg.evaluate(CHAR_OFF, 'main')) <= 2, await pg.evaluate(CHAR_OFF, 'main'))
        # scrolling yourself afterwards moves the remembered place
        await pg.evaluate("(() => { const m = document.querySelector('.pane[data-tid=main] .pb'); m.scrollTop = m.scrollHeight * 0.2 })()"); await settle(pg, 400)
        there = await pg.evaluate(AT_LINE, 'main')
        await pg.locator('#tSide').click(); await frames(pg, 6)
        check('a place you scrolled to since is the one kept', there != here and await pg.evaluate(AT_LINE, 'main') == there, [here, there, await pg.evaluate(AT_LINE, 'main')])
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
