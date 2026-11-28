"""A conversation the server refuses as too large (HTTP 413) isn't retried for ever.
  - The page says so once (a popup), the top bar says "Not saved: too large", and no save is tried on its own after that.
  - It stays unsaved: leaving the conversation asks first.
  - The next change tries again (and the popup isn't repeated while it still fails); once the server takes it, the
    top bar clears and the change is saved.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon

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
STATUS = "document.getElementById('status').textContent"

async def rename(pg, to):
    t = pg.locator('#cTitle'); await t.click(); await pg.keyboard.press('ControlOrMeta+a'); await pg.keyboard.type(to); await pg.keyboard.press('Enter')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        pg = await b.new_page(viewport={'width': 1280, 'height': 820}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg); await pg.wait_for_function("__digress.conv && __digress.conv.id === 'cs'")
        await pg.evaluate("window.__shown = []; new MutationObserver(() => { const t = document.getElementById('toast'); if (t.classList.contains('show')) __shown.push(t.textContent) }).observe(document.getElementById('toast'), {attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true})")

        # the server answers 413
        await pg.evaluate("window.fakeStoreStatus = 413")
        await rename(pg, 'Too big')
        check('the top bar says it’s too large', await soon(pg, f"()=>/Not saved: too large/.test({STATUS})"), await pg.evaluate(STATUS))
        check('…with a popup saying the conversation is too large', await soon(pg, "()=>[...document.querySelectorAll('.toast.show')].some(t=>/too large to save/.test(t.textContent))"), await pg.evaluate("__shown"))
        check('…the change is marked unsaved and no retry is scheduled', await pg.evaluate("(()=>{const j=__digress.sync;return !!j.failed&&!!j.dirty&&!j.retryT})()"), await pg.evaluate("JSON.stringify(Object.assign({}, __digress.sync, {conv: 0}))"))
        check('…and the server still has the old title', await pg.evaluate(SERVER_TITLE) == 'Saved one')

        # leaving asks first
        await pg.evaluate("document.querySelector('#clist .citem[data-conv=co], #plist .citem[data-conv=co]').click()")
        check('leaving asks first, since it isn’t saved', await soon(pg, "()=>document.getElementById('modal').classList.contains('show')") and 'isn’t saved yet' in await pg.locator('#mTitle').text_content())
        await pg.locator('#mCancel').click(); await frames(pg, 3)
        check('Stay keeps you in the conversation', await pg.evaluate("__digress.conv.id") == 'cs')

        # another change tries again; still too large: the popup isn't repeated
        n = await pg.evaluate("window.__saves")
        await rename(pg, 'Still too big')
        check('the next change tries to save again', await soon(pg, f"()=>window.__saves > {n}"))
        await soon(pg, f"()=>/Not saved: too large/.test({STATUS})")
        await frames(pg, 3)
        k = await pg.evaluate("__shown.filter((t, i, a) => /too large to save/.test(t) && !/too large to save/.test(a[i - 1] || '')).length")
        check('…and the popup isn’t shown again while it still fails', k == 1, await pg.evaluate("__shown"))
        check('…and again no retry is scheduled', await pg.evaluate("!__digress.sync.retryT"))

        # the server takes it: saved, and the state clears
        await pg.evaluate("window.fakeStoreStatus = 0")
        await rename(pg, 'Small enough')
        check('once the server takes it, it’s saved', await soon(pg, f"()=>{SERVER_TITLE} === 'Small enough'"), await pg.evaluate(SERVER_TITLE))
        check('…the top bar no longer says too large', await soon(pg, f"()=>!/too large/.test({STATUS})"), await pg.evaluate(STATUS))
        check('…and it’s no longer marked unsaved', await soon(pg, "()=>{const j=__digress.sync;return !j.failed&&!j.dirty&&!j.tooBig}"))
        await pg.evaluate("document.querySelector('#clist .citem[data-conv=co], #plist .citem[data-conv=co]').click()")
        check('leaving no longer asks', await soon(pg, "()=>__digress.conv.id === 'co'"))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
