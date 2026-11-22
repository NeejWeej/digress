"""Connections, Describe it instead's own model, and Collapse others' icon.
  - The model menu ends with Connections…: each provider and whether it's on. A key pasted for Gemini is checked (a
    bad one says why, in its row), then shows only as "key ending …"; Remove takes it out. Its models join the picker at
    once, under Google, with a note about free-tier keys.
  - Describe it instead says which model it asks ("Asks: …"), never a Gemini one by default, and opens the same grouped
    menu (no Default there) to pick another, which it then uses.
  - Collapse others keeps one icon: on, the button is pressed (aria-pressed, the accent colour).
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
const now = Date.now();
localStorage.setItem('fakesrv:convs/cc', JSON.stringify({id: 'cc', title: 'Gradients', created: now, updated: now, rev: 1,
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}, b1: {id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'Fine', anchorRange: {s: 0, e: 4}, title: 'One', colorIdx: 0, created: now}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Why does the gradient vanish?', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'Fine question: saturation.', ts: now}},
  order: {main: ['u1', 'a1'], b1: []}, nextColor: 1}));
localStorage.setItem('fakesrv:layout/cc', JSON.stringify({devices: {other: {at: now, ui: {open: ['main', 'b1'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
"""
FAKE = "window.__asked = []; window.fakeLLM = {use: async () => async (m, o) => { window.__asked.push(o.model); return {text: 'vanishing gradient\\nsaturated softmax'} }};"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        pg = await b.new_page(viewport={'width': 1440, 'height': 900}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg); await pg.wait_for_function("__digress.conv && __digress.conv.id === 'cc'")
        await pg.wait_for_function("document.querySelectorAll('#mSel option').length > 2")

        # Connections, from the model menu
        await pg.locator('#mPick').click(); await frames(pg)
        await pg.locator('.mmenu .mconn').click()
        await pg.wait_for_selector('#connModal.show .cnrow[data-cid=gemini]')
        row = pg.locator('#connModal .cnrow[data-cid=gemini]')
        check('Connections lists the providers, Gemini not connected', 'Not connected' in await row.inner_text() and await pg.locator('#connModal .cnrow').count() == 4)
        check('…with a link to get a key, and what a free-tier key means', await row.locator('a.cnget').get_attribute('href') == 'https://aistudio.google.com/apikey' and 'may use what you send' in await row.inner_text())
        await row.locator('.cnkey').fill('wrong-key-wrong-key-wrong-key'); await row.locator('[data-cx=add]').click()
        check('a bad key says why, in its row', await soon(pg, "()=>/rejected/.test((document.querySelector('#connModal .cnrow[data-cid=gemini] .cnerr')||{}).textContent||'')"))
        await pg.locator('#connModal .cnrow[data-cid=gemini] .cnkey').fill('gemini-test-key-0000000000'); await pg.locator('#connModal .cnrow[data-cid=gemini] [data-cx=add]').click()
        ok = await soon(pg, "()=>/key ending …0000/.test(document.querySelector('#connModal .cnrow[data-cid=gemini]').textContent)")
        check('a good key connects, and shows only its last 4', ok and await pg.locator('#connModal .cnrow[data-cid=gemini] [data-cx=remove]').count() == 1)
        check('…the key itself isn’t anywhere on the page', 'gemini-test-key-0000000000' not in await pg.content())
        await pg.locator('#connModal').screenshot(path=OUT + '/connections.png')
        await pg.locator('#connModal [data-cx=close]').click(); await frames(pg)
        check('its models join the picker at once', await pg.evaluate("[...document.querySelectorAll('#mSel option')].some(o=>o.value==='gemini-3.8-flash')"))
        await pg.locator('#mPick').click(); await frames(pg)
        check('…under Google, with the free-tier note', await pg.locator('.mmenu .thgrp[data-g=google]').count() == 1 and 'may use what you send' in await pg.locator('.mmenu .thgrp[data-g=google] + .thlist .mnote').inner_text())
        await pg.keyboard.press('Escape'); await frames(pg)

        # Describe it instead: its own model, not Gemini by default
        await pg.keyboard.press('ControlOrMeta+k'); await pg.locator('#palIn').fill('that thing about gradients disappearing')
        await pg.wait_for_selector('#palRes .pr.pai .paimodel')
        btn = pg.locator('#palRes .pr.pai .paimodel').first
        check('Describe it instead says which model it asks: the quick one, not Gemini', 'Haiku' in await btn.inner_text(), await btn.inner_text())
        await btn.click(); await frames(pg)
        check('…and opens the same grouped menu (no Default; what it sends)', await pg.locator('.mmenu.open.mfind').count() == 1 and await pg.locator('.mmenu button[data-model=auto]').count() == 0 and 'titles' in await pg.locator('.mmenu .mnote').first.inner_text())
        check('…above the search box', await pg.evaluate("(()=>{const r=document.querySelector('.mmenu').getBoundingClientRect(),e=document.elementFromPoint(r.left+r.width/2,r.top+30);return !!e&&!!e.closest('.mmenu')})()"))
        if not await pg.locator('.mmenu .thgrp[data-g=google] + .thlist button[data-model="gemini-3.5-flash-lite"]').is_visible():
            await pg.locator('.mmenu .thgrp[data-g=google]').click(); await frames(pg)
        await pg.locator('.mmenu button[data-model="gemini-3.5-flash-lite"]').click(); await frames(pg)
        check('picking one changes it there', 'Gemini 3.5 Flash-Lite' in await btn.inner_text() and await pg.locator('#pal.show').count() == 1, await btn.inner_text())
        n0 = await pg.evaluate("window.__asked.length")
        await pg.locator('#palRes .pr.pai').first.click()
        check('…and it asks that model', await soon(pg, "n=>window.__asked.length>n", n0) and await pg.evaluate("window.__asked.at(-1)") == 'gemini-3.5-flash-lite', await pg.evaluate("window.__asked"))
        check('the conversation’s own model didn’t change', await pg.evaluate("document.getElementById('mSel').value") != 'gemini-3.5-flash-lite')
        await pg.keyboard.press('Escape'); await frames(pg)

        # Collapse others: one icon, pressed while on
        f = pg.locator('.pane[data-tid=main] [data-act=focus]')
        icon0 = await f.inner_html()
        await f.click(); await frames(pg, 3)
        check('Collapse others keeps its icon when on', await f.inner_html() == icon0)
        check('…and shows it’s on (pressed)', await f.get_attribute('aria-pressed') == 'true' and await f.evaluate("e=>e.classList.contains('on')"))
        await f.click(); await frames(pg, 3)
        check('…and off again', await f.get_attribute('aria-pressed') == 'false')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
