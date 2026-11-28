"""Flashcards on but drafting manual (conv.cards.auto === false, from the "Draft automatically" checkbox in the
cards panel's footer; missing = true). Off: no drafting after a highlight's first reply or a takeaway, and
suggest_card isn't offered; the Cards button on a branch, Make cards and Draft more still work. Saved with the
conversation, and no checkbox when cards are off. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import OUT, launch_args, goto_app, booted, answered, soon, frames, quiet

FAKE = r"""
window.fakeTools = true; window.__calls = [];
window.fakeLLM = {use: async (n) => n !== 'sample' ? null : async (input, opts) => {
  const last = input[input.length - 1].content;
  window.__calls.push({last, tools: opts.tools || []});
  let out;
  if (last.includes('[Flashcards]')) {
    const about = (last.match(/about “([^”]*)”/) || [, 'the main thread'])[1];
    out = '```json\n' + JSON.stringify([{front: 'Card Q about ' + about, back: 'Answer.'}]) + '\n```';
  } else if (last.includes('Write a short takeaway')) out = '- Scaling keeps softmax from saturating.';
  else out = 'Attention is a soft dictionary lookup over the keys. The scores are scaled by the square root of the dimension.';
  opts.onText && opts.onText({text: out});
  return {text: out, truncated: false};
}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:400])
    if not ok: fails.append(name)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 950})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        cards = lambda: pg.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k)))")
        calls = lambda: pg.evaluate('window.__calls')
        drafts = lambda: pg.evaluate("window.__calls.filter(c => c.last.includes('[Flashcards]')).length")
        saved_auto = lambda: pg.evaluate("""(() => { const k = Object.keys(localStorage).find(k => k.startsWith('fakesrv:convs/') && !k.includes('layout'));
            return k ? JSON.parse(localStorage.getItem(k)).cards : null })()""")
        main_ta = pg.locator('.pane[data-tid=main] textarea:not(.pptext)')

        async def select(tid, word):
            await pg.evaluate('''([tid, word]) => { const body = document.querySelector(`.pane[data-tid="${tid}"] .msg.assistant .body`);
              const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.nodeValue.indexOf(word);
              if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
              document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); }''', [tid, word])
            await pg.locator('#pop.show').wait_for()
        async def highlight(word, q):
            await select('main', word); await pg.locator('#popIn').fill(q); await answered(pg, pg.locator('#popIn').press('Enter')); await frames(pg)
        async def ask(q):
            await main_ta.fill(q); await answered(pg, main_ta.press('Enter')); await frames(pg)
        async def open_panel():
            await pg.locator('.pane[data-tid=main] [data-act=cards]').click(); await soon(pg, "() => !!document.querySelector('#cardsModal.show .kfoot')")
        async def close_panel():
            await pg.keyboard.press('Escape'); await soon(pg, "() => !document.querySelector('#cardsModal.show')")
        box = pg.locator('#cardsModal [data-kauto]')

        await ask('What is attention?')
        # 6. cards off: no checkbox
        await open_panel()
        check('cards off: no "Draft automatically" checkbox', await box.count() == 0)
        await pg.locator('[data-kact=on]').click(); await soon(pg, "() => !!document.querySelector('#cardsModal [data-kauto]')")

        # 1. on, auto unset: checked, and everything automatic
        check('cards on, auto unset: the checkbox is ticked', await box.is_checked())
        check('…and nothing is stored as auto', 'auto' not in (await saved_auto() or {}), await saved_auto())
        await close_panel()
        await highlight('soft dictionary lookup', 'Why soft?')
        await soon(pg, "() => window.__calls.some(c => c.last.includes('[Flashcards]'))")
        check('auto: a highlight branch’s first reply drafts cards', await drafts() == 1)
        await soon(pg, "() => Object.keys(localStorage).some(k => k.startsWith('fakesrv:cards/'))")
        await ask('And then?')
        check('auto: a normal reply is offered suggest_card', 'suggest_card' in (await calls())[-1]['tools'], (await calls())[-1]['tools'])

        # 2. untick: saved, stays unticked
        n_cards = len(await cards())
        await open_panel(); await box.uncheck()
        await soon(pg, "() => __digress.conv.cards.auto === false")
        check('unticking sets conv.cards.auto = false and keeps cards on', await pg.evaluate('__digress.conv.cards.auto === false && __digress.conv.cards.on === true'))
        await soon(pg, "() => Object.keys(localStorage).some(k => k.startsWith('fakesrv:convs/') && JSON.parse(localStorage.getItem(k)).cards && JSON.parse(localStorage.getItem(k)).cards.auto === false)")
        check('…and it is saved with the conversation', (await saved_auto())['auto'] is False, await saved_auto())
        check('the checkbox stays unticked after the panel redraws', not await box.is_checked())
        await pg.screenshot(path=OUT + '/cards_manual_panel.png')
        await close_panel(); await open_panel()
        check('…and after reopening the panel', not await box.is_checked())
        await close_panel()

        # 3. auto off: nothing in the background
        d0, n0 = await drafts(), len(await cards())
        await highlight('square root', 'Why the square root?')
        await ask('One more thing.')   # by now a drafting call queued by that reply would have run
        await quiet(pg)
        check('auto off: a highlight branch’s first reply makes no drafting call', await drafts() == d0, await drafts())
        check('…and adds no card', len(await cards()) == n0)
        br = pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])').last
        await br.locator('.ph [data-act=take]').click(); await answered(pg, br.locator('.tk .go').click()); await frames(pg)
        await ask('And a last one.'); await quiet(pg)
        check('auto off: a takeaway carried back drafts nothing', await drafts() == d0 and len(await cards()) == n0)
        check('auto off: a normal reply is not offered suggest_card', 'suggest_card' not in (await calls())[-1]['tools'], (await calls())[-1]['tools'])
        check('auto off: no call at all is offered it', not any('suggest_card' in c['tools'] for c in (await calls())[-4:]))

        # reload: still off
        await quiet(pg); await pg.reload(); await booted(pg)
        await open_panel()
        check('after a reload the checkbox is still unticked', not await box.is_checked() and await pg.evaluate('__digress.conv.cards.auto === false'))
        await close_panel()
        n0 = len(await cards()); d0 = await drafts()   # the page's call log starts over with the reload

        # 4. manual still works: the branch's Cards button, Make cards, Draft more
        target = pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])').last
        await target.locator('[data-act=mkcards]').click()
        await soon(pg, "n => Object.keys(localStorage).filter(k => k.startsWith('fakesrv:cards/')).length > n", n0)
        mk = await cards()
        check('auto off: a branch’s Cards button drafts into the inbox', any(c['status'] == 'inbox' and 'square root' in c['front'] for c in mk), [c['front'] for c in mk])
        check('…with one drafting call', await drafts() == d0 + 1, await drafts())
        await pg.keyboard.press('Escape')
        await open_panel()
        mkb = pg.locator('[data-kact=make]')
        check('Make cards offers the threads not yet drafted', 'new' in await mkb.text_content(), await mkb.text_content())
        d1 = await drafts(); await mkb.click()
        await soon(pg, "() => document.querySelector('[data-kact=make]').textContent.includes('Up to date')")
        check('auto off: Make cards drafts', await drafts() > d1, await drafts())
        check('…and the box is still unticked', not await box.is_checked())
        await close_panel()

        # 5. tick again: the tool comes back
        await open_panel(); await box.check()
        await soon(pg, "() => __digress.conv.cards.auto === true")
        await close_panel()
        await ask('Back to automatic.')
        check('re-ticked: suggest_card is offered again', 'suggest_card' in (await calls())[-1]['tools'], (await calls())[-1]['tools'])
        d2 = await drafts()
        await highlight('scaled', 'Why scaled?')
        await soon(pg, "n => window.__calls.filter(c => c.last.includes('[Flashcards]')).length > n", d2)
        check('re-ticked: a highlight branch drafts again', await drafts() > d2)
        await open_panel(); check('re-ticked: the checkbox shows ticked', await box.is_checked()); await close_panel()

        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
