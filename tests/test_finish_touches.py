"""Finishing touches.
  - The end of a review session: how many, how many recalled, how many come back soon, when the next card is due,
    and a way to Activity.
  - The very first screen (nothing saved yet) explains the idea in three steps and offers to start from something to
    read; later new conversations don't repeat the steps.
  - A reply that finishes while the tab is in the background puts a dot in front of the tab's name until you come back.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, answered, soon, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

FAKE = "window.fakeLLM = {use: async () => async (m, o) => { await new Promise(r => setTimeout(r, 300)); o.onText({text: 'Done.'}); return {text: 'Done.'} }};"
CARDS = r"""
const now = Date.now();
for (const [id, f] of [['k1', 'What is one?'], ['k2', 'What is two?']])
  localStorage.setItem('fakesrv:cards/' + id, JSON.stringify({id, conv: 'cz', convTitle: 'Cards', thread: 'main', front: f, back: 'A number.', status: 'active', created: now - 5e5, due: now - 1000, fsrs: null, reviews: []}));
localStorage.setItem('fakesrv:cards/k3', JSON.stringify({id: 'k3', conv: 'cz', convTitle: 'Cards', thread: 'main', front: 'Later?', back: 'Yes.', status: 'active', created: now, due: now + 3 * 864e5, fsrs: null, reviews: []}));
localStorage.setItem('fakesrv:convs/cz', JSON.stringify({id: 'cz', title: 'Cards', created: now, updated: now, rev: 1, cards: {on: true},
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}}, msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Hi', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'Hello.', ts: now}},
  order: {main: ['u1', 'a1']}, nextColor: 0}));
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        errs = []

        # the very first screen
        pg = await b.new_page(viewport={'width': 1280, 'height': 820}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE); await goto_app(pg); await booted(pg)
        await pg.wait_for_selector('.pane[data-tid=main] .empty')
        check('the first screen explains the idea in three steps', await pg.locator('.esteps li').count() == 3)
        check('…and mentions the shortcuts', '?' in await pg.locator('.ekeys').inner_text())
        await pg.screenshot(path=OUT + '/first_screen.png')
        await pg.locator('[data-newdoc]').click(); await frames(pg)
        check('“start from something to read” opens the document dialog', await pg.locator('#docModal.show').count() == 1)
        await pg.keyboard.press('Escape')
        await pg.locator('#docCancel').click() if await pg.locator('#docModal.show').count() else None

        # a reply finishing in the background
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Hello?')
        await pg.evaluate("Object.defineProperty(document, 'hidden', {configurable: true, get: () => true})")
        await answered(pg, ta.press('Enter'))
        check('a reply that finished out of sight puts a dot on the tab', await soon(pg, "()=>document.title.startsWith('● ')"), await pg.title())
        await pg.evaluate("Object.defineProperty(document, 'hidden', {configurable: true, get: () => false}); document.dispatchEvent(new Event('visibilitychange'))")
        check('…gone once you come back', await soon(pg, "()=>!document.title.startsWith('●')"), await pg.title())
        await pg.locator('#newConv').click(); await frames(pg)
        check('a later new conversation doesn’t repeat the steps', await pg.locator('.esteps').count() == 0 and await pg.locator('[data-newdoc]').count() == 1)
        await pg.close()

        # the end of a review session
        pg = await b.new_page(viewport={'width': 1280, 'height': 820}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + CARDS + "}" + FAKE)
        await goto_app(pg); await booted(pg)
        await pg.locator('#reviewBtn').click(); await pg.wait_for_selector('#cardsModal .kcard')
        for g in ('3', '1'):
            await pg.keyboard.press('Space'); await pg.wait_for_selector('#cardsModal .krate'); await pg.keyboard.press(g); await frames(pg, 3)
        # Again brings it back in a minute; that's after the session, so the session is done
        ok = await soon(pg, "()=>!!document.querySelector('#cardsModal .kdone')")
        check('after the last card: a summary, not just “nothing due”', ok)
        if ok:
            t = await pg.locator('#cardsModal .kdone').inner_text()
            check('…how many, and how many recalled', '2' in t and 'cards reviewed' in t and '50%' in t, t)
            check('…how many come back soon', 'to see again soon' in t, t)
            check('…when the next card is due', 'Next card due in' in t, t)
            check('…a bar of the ratings', await pg.locator('#cardsModal .kdbar i').count() == 2)
            await pg.wait_for_timeout(400); await pg.locator('#cardsModal .kbox').screenshot(path=OUT + '/review_done.png')
            await pg.locator('#cardsModal [data-kact=activity]').click(); await frames(pg)
            check('“See your activity” goes there', await soon(pg, "()=>document.getElementById('activity').classList.contains('show')") and not await pg.locator('#cardsModal.show').count())
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
