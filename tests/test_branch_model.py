"""A model per branch.
  - A branch asks with its own model (t.llm), else the model of the thread it branched from, up to main (conv.llm).
  - The model picker follows the pane you're in: it shows that thread's model, and changing it changes only that thread.
  - A branch's first question stamps its model, so it keeps it if its parent switches later.
  - A model that isn't offered here falls back to the newest of the same kind (another Opus), without forgetting it.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, answered, soon, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SONNET, HAIKU, OPUS = 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'
SEED = r"""
const now = Date.now();
localStorage.setItem('fakesrv:convs/cm', JSON.stringify({id: 'cm', title: 'Models', created: now, updated: now, rev: 1, llm: ['claude-sonnet-5-5', 'auto'],
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1},
    b1: {id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'first', anchorRange: {s: 0, e: 5}, title: 'Branch one', colorIdx: 0, created: now},
    b2: {id: 'b2', parent: 'b1', anchorMsg: 'a2', anchorText: 'second', anchorRange: {s: 0, e: 6}, title: 'Branch two', colorIdx: 1, created: now},
    b3: {id: 'b3', parent: 'main', anchorMsg: 'a1', anchorText: 'reply', anchorRange: {s: 10, e: 15}, title: 'Branch three', colorIdx: 2, created: now, llm: ['claude-opus-4-1', 'auto']}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Hello', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'first reply here', model: 'claude-sonnet-5-5', ts: now},
    u2: {id: 'u2', role: 'user', thread: 'b1', content: 'More', ts: now}, a2: {id: 'a2', role: 'assistant', thread: 'b1', content: 'second answer', model: 'claude-sonnet-5-5', ts: now}},
  order: {main: ['u1', 'a1'], b1: ['u2', 'a2'], b2: [], b3: []}, nextColor: 3}));
localStorage.setItem('fakesrv:layout/cm', JSON.stringify({devices: {other: {at: now, ui: {open: ['main', 'b1', 'b2', 'b3'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
"""
FAKE = "window.__asked = []; window.fakeLLM = {use: async () => async (m, o) => { window.__asked.push(o.model); o.onText({text: 'An answer.'}); return {text: 'An answer.'} }};"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1600, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg)
        await pg.wait_for_function("__digress.conv && __digress.conv.id === 'cm' && document.querySelectorAll('#panes .pane[data-tid]').length >= 4")
        await pg.wait_for_function("document.querySelector('#mSel option[value=\"claude-haiku-5-5\"]')")
        picker = lambda: pg.evaluate("document.getElementById('mSel').value")
        async def into(tid):
            await pg.locator(f'.pane[data-tid={tid}] .pb').dispatch_event('pointerdown'); await frames(pg)
        async def ask(tid, q):
            ta = pg.locator(f'.pane[data-tid={tid}] textarea'); await ta.fill(q)
            await answered(pg, ta.press('Enter'))
            return await pg.evaluate("window.__asked.at(-1)")
        llm = lambda tid: pg.evaluate("t => t === 'main' ? __digress.conv.llm : (__digress.conv.threads[t].llm || null)", tid)

        await into('main'); check('in main, the picker shows main’s model', await picker() == SONNET, await picker())
        await into('b1'); check('a branch without its own model shows its parent’s', await picker() == SONNET, await picker())
        await pg.select_option('#mSel', HAIKU); await frames(pg)
        check('changing the picker in a branch changes only that branch', await llm('b1') == [HAIKU, 'auto'] and await llm('main') == [SONNET, 'auto'], [await llm('b1'), await llm('main')])
        await into('main'); check('back in main, the picker shows Sonnet again', await picker() == SONNET, await picker())
        await into('b2'); check('a branch of that branch starts with its model', await picker() == HAIKU, await picker())
        check('…and asks with it', await ask('b2', 'Why?') == HAIKU)
        check('…which its first question keeps', await llm('b2') == [HAIKU, 'auto'], await llm('b2'))
        check('main still asks with its own', await ask('main', 'And?') == SONNET)
        await into('b1'); await pg.select_option('#mSel', OPUS); await frames(pg)
        await into('b2'); check('a branch keeps its model when its parent switches later', await picker() == HAIKU and await ask('b2', 'Again?') == HAIKU)

        await into('b3')
        check('a model not offered here: the newest of the same kind (another Opus)', await picker() == OPUS, await picker())
        check('…saying so', await soon(pg, "()=>[...document.querySelectorAll('.toast')].some(t=>/isn’t available here/.test(t.textContent))"))
        check('…and asks with it, without forgetting the one it had', await ask('b3', 'Hm?') == OPUS and await llm('b3') == ['claude-opus-4-1', 'auto'], await llm('b3'))
        tip = await pg.evaluate("document.getElementById('mSel').closest('.sel').title")
        check('the picker’s tooltip says it’s this branch’s model', 'this branch' in tip, tip)

        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await frames(pg, 4)
        await pg.locator("#cv .cnode[data-ctid=b1] .ch .ct").click(); await frames(pg)
        check('on the canvas, the picker follows the selected card', await picker() == OPUS, await picker())
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
