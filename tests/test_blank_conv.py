"""An empty new conversation (no question, no document) is never saved, so putting it away just drops it:
  - Delete on its sidebar row, or ✕ on its only pane, opens your latest other conversation and leaves no row behind
    (it used to say "Couldn't delete it" and keep the row until a reload).
  - With no other conversation, ✕ leaves a fresh empty one, without an error.
  - Deleting the open conversation for good opens the latest other one, not an empty new one.
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
ROWS = "[...document.querySelectorAll('#clist .citem, #plist .citem')].map(r => r.textContent.trim())"
TOAST = "[...document.querySelectorAll('.toast.show')].map(t => t.textContent).join(' ')"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        pg = await b.new_page(viewport={'width': 1280, 'height': 820}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg); await pg.wait_for_function("__digress.conv && __digress.conv.id === 'cs'")
        cur = lambda: pg.evaluate("__digress.conv.id")

        await pg.locator('#newConv').click(); await frames(pg, 3)
        blank = await cur()
        check('a new conversation shows a row while it’s open', any('New conversation' in r for r in await pg.evaluate(ROWS)))
        await pg.evaluate("id => document.querySelector(`[data-del='${id}']`).click()", blank); await frames(pg, 4)
        check('Delete on it opens the latest other conversation', await soon(pg, "() => __digress.conv.id === 'cs'"), await cur())
        check('…leaves no row behind', not any('New conversation' in r for r in await pg.evaluate(ROWS)), await pg.evaluate(ROWS))
        check('…and no error', 'Couldn' not in await pg.evaluate(TOAST), await pg.evaluate(TOAST))

        await pg.locator('#newConv').click(); await frames(pg, 3)
        await pg.locator('.pane[data-tid=main] [data-act=close]').click(); await frames(pg, 4)
        check('✕ on its only pane does the same', await soon(pg, "() => __digress.conv.id === 'cs'") and not any('New conversation' in r for r in await pg.evaluate(ROWS)), [await cur(), await pg.evaluate(ROWS)])
        check('…without “At least one pane stays open”', 'At least one pane' not in await pg.evaluate(TOAST))

        await pg.evaluate("__digress.deleteConv('cs')"); await frames(pg, 4)
        check('deleting the open conversation for good opens the latest other one', await soon(pg, "() => __digress.conv.id === 'co'"), await cur())
        await pg.close()

        pg = await b.new_page(viewport={'width': 1280, 'height': 820}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE); await goto_app(pg); await booted(pg)
        first = await cur()
        await pg.locator('.pane[data-tid=main] [data-act=close]').click(); await frames(pg, 4)
        check('with nothing else, ✕ leaves a fresh empty conversation, quietly', await pg.locator('.pane[data-tid=main] .empty').count() == 1 and 'Couldn' not in await pg.evaluate(TOAST))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
