"""Saving on a shaky connection.
  - A save that fails (no connection) isn't dropped: the change stays pending, the top bar says it's retrying (and one
    small popup, not one per try), and it's saved once the connection is back (a popup says it's caught up) (on its own, and at once when the browser says it's online).
  - Leaving the conversation while the change still can't be saved asks first: Stay keeps you there (and the change),
    Leave anyway goes.
  - When the tab is hidden, a pending change is saved right away instead of 0.7 s later.
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
for (const [id, t, dt] of [['cs', 'Saved one', 0], ['co', 'Older one', 60000]])
  localStorage.setItem('fakesrv:convs/' + id, JSON.stringify({id, title: t, created: now - dt, updated: now - dt, rev: 1,
    threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}}, msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Hi', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'Hello.', ts: now}},
    order: {main: ['u1', 'a1']}, nextColor: 0}));
"""
FAKE = "window.fakeLLM = {use: async () => async () => ({text: 'ok'})};"
SERVER_TITLE = "JSON.parse(localStorage['fakesrv:convs/cs']).title"

async def rename(pg, to):
    t = pg.locator('#cTitle'); await t.click(); await pg.keyboard.press('ControlOrMeta+a'); await pg.keyboard.type(to); await pg.keyboard.press('Enter')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        pg = await b.new_page(viewport={'width': 1280, 'height': 820}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg); await pg.wait_for_function("__digress.conv && __digress.conv.id === 'cs'")

        # the connection drops; a change can't be saved
        await pg.evaluate("window.fakeOffline = true; window.__shown = []; new MutationObserver(() => { const t = document.getElementById('toast'); if (t.classList.contains('show')) __shown.push(t.textContent) }).observe(document.getElementById('toast'), {attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true})")
        await rename(pg, 'Renamed offline')
        check('a failed save says it’s retrying', await soon(pg, "()=>/retrying/.test(document.getElementById('status').textContent)"), await pg.locator('#status').text_content())
        check('…and the server doesn’t have it yet', await pg.evaluate(SERVER_TITLE) == 'Saved one')
        check('…with one small popup saying it keeps trying', await soon(pg, "()=>[...document.querySelectorAll('.toast.show')].some(t=>/keeps trying in the background/.test(t.textContent))"))
        await pg.wait_for_timeout(2600)   # (deliberate: past the first retry, which fails too)
        n = await pg.evaluate("new Set(__shown.filter(t => /keeps trying/.test(t))).size && __shown.filter((t, i, a) => /keeps trying/.test(t) && !/keeps trying/.test(a[i - 1] || '')).length")
        check('…not one per retry (shown once, through a failed retry)', n == 1, await pg.evaluate("__shown"))

        # leaving asks; Stay keeps you there
        await pg.evaluate("document.querySelector('#clist .citem[data-conv=co], #plist .citem[data-conv=co]').click()")
        check('leaving while it can’t be saved asks first', await soon(pg, "()=>document.getElementById('modal').classList.contains('show')") and 'isn’t saved yet' in await pg.locator('#mTitle').text_content())
        await pg.locator('#mCancel').click(); await frames(pg, 3)
        check('Stay keeps you in the conversation, with the change', await pg.evaluate("__digress.conv.id") == 'cs' and await pg.evaluate("__digress.conv.title") == 'Renamed offline')

        # the connection comes back: saved without another edit
        await pg.evaluate("window.fakeOffline = false; dispatchEvent(new Event('online'))")
        check('when the connection is back it’s saved, with no other change', await soon(pg, f"()=>{SERVER_TITLE} === 'Renamed offline'"), await pg.evaluate(SERVER_TITLE))
        check('…and the top bar says so', await soon(pg, "()=>!/retrying/.test(document.getElementById('status').textContent)"))
        check('…with a popup that it’s caught up', await soon(pg, "()=>[...document.querySelectorAll('.toast.show')].some(t=>/All caught up/.test(t.textContent))"))

        # it also retries on its own (no online event)
        await pg.evaluate("window.fakeOffline = true"); await rename(pg, 'Second try')
        await soon(pg, "()=>/retrying/.test(document.getElementById('status').textContent)")
        await pg.evaluate("window.fakeOffline = false")
        check('…and retries on its own a moment later', await soon(pg, f"()=>{SERVER_TITLE} === 'Second try'", timeout=8000), await pg.evaluate(SERVER_TITLE))

        # Leave anyway goes
        await pg.evaluate("window.fakeOffline = true"); await rename(pg, 'Lost on purpose')
        await soon(pg, "()=>/retrying/.test(document.getElementById('status').textContent)")
        await pg.evaluate("document.querySelector('#clist .citem[data-conv=co], #plist .citem[data-conv=co]').click()")
        await soon(pg, "()=>document.getElementById('modal').classList.contains('show')")
        await pg.locator('#mOk').click()
        check('Leave anyway opens the other conversation', await soon(pg, "()=>__digress.conv.id === 'co'"))
        await pg.evaluate("window.fakeOffline = false")

        # hidden tab: saved at once, not 0.7 s later
        await pg.evaluate("document.querySelector('#clist .citem[data-conv=cs], #plist .citem[data-conv=cs]').click()")
        await pg.wait_for_function("__digress.conv.id === 'cs'"); await pg.wait_for_timeout(300)
        n0 = await pg.evaluate("window.__saves || 0")
        await rename(pg, 'Hidden right away')
        await pg.evaluate("Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))")
        check('hiding the tab saves a pending change at once', await soon(pg, f"()=>{SERVER_TITLE} === 'Hidden right away'", timeout=400), [await pg.evaluate(SERVER_TITLE), n0])
        await pg.evaluate("delete document.visibilityState")
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
