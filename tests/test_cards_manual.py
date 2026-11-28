"""Flashcards' two switches for cards that come without asking, in the cards panel (missing = on):
  [data-kswitch=auto] "Draft in the background" (conv.cards.auto): a highlight's first reply and a takeaway draft
  cards; off, they don't. [data-kswitch=suggest] "Let the model suggest cards" (conv.cards.suggest): suggest_card is
  offered; off, it isn't, and a call that arrives after the switch went off (the request started with it on) is refused.
  Independent of each other; the Cards button on a branch, Make cards and Draft more work in every case.
  While cards are off both boxes show above "Turn on" and change nothing until it's pressed.
Saved with the conversation. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import OUT, launch_args, goto_app, booted, answered, soon, frames, quiet

FAKE = r"""
window.fakeTools = true; window.__calls = [];
window.__gate = new Promise(r => { window.__openGate = r; });
window.fakeLLM = {use: async (n) => n !== 'sample' ? null : async (input, opts) => {
  const last = input[input.length - 1].content;
  window.__calls.push({last, tools: opts.tools || []});
  let out;
  if (last.includes('LATE')) {   // the model calls suggest_card only after the test lets it (the switch may have gone off by then)
    window.__lateAt = true; await window.__gate;
    window.__late = await opts.callTool('suggest_card', {front: 'Late Q', back: 'Late A.'});
  }
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
        reply_tools = lambda: pg.evaluate("(window.__calls.filter(c => !c.last.includes('[Flashcards]')).pop() || {}).tools")
        saved_cards = lambda: pg.evaluate("""(() => { const k = Object.keys(localStorage).find(k => k.startsWith('fakesrv:convs/') && !k.includes('layout'));
            return k ? JSON.parse(localStorage.getItem(k)).cards || null : null })()""")
        main_ta = pg.locator('.pane[data-tid=main] textarea:not(.pptext)')
        sw = lambda k: pg.locator(f'#cardsModal [data-kswitch={k}]')

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
        async def open_panel(foot=True):
            await pg.locator('.pane[data-tid=main] [data-act=cards]').click()
            await soon(pg, "(f) => !!document.querySelector(f ? '#cardsModal.show .kfoot' : '#cardsModal.show .kpre')", foot)
        async def close_panel():
            await pg.keyboard.press('Escape'); await soon(pg, "() => !document.querySelector('#cardsModal.show')")
        async def set_switches(auto, suggest):
            await open_panel()
            for k, v in (('auto', auto), ('suggest', suggest)):
                await sw(k).set_checked(v)
                await soon(pg, "([k, v]) => (__digress.conv.cards[k] !== false) === v", [k, v])
            await close_panel()
        async def last_branch_take():
            br = pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])').last
            await br.locator('.ph [data-act=take]').click(); await answered(pg, br.locator('.tk .go').click()); await frames(pg)
        async def last_branch_cards(word):
            n0 = len(await cards()); d0 = await drafts()
            await pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])').last.locator('[data-act=mkcards]').click()
            await soon(pg, "n => Object.keys(localStorage).filter(k => k.startsWith('fakesrv:cards/')).length > n", n0)
            return any(c['status'] == 'inbox' and word in c['front'] for c in await cards()) and await drafts() == d0 + 1

        await ask('What is attention?')

        # 1. cards off: both switches above Turn on, ticked; changes held, not saved, and dropped when the panel closes
        await open_panel(foot=False)
        check('cards off: both switches are shown, ticked', await sw('auto').is_checked() and await sw('suggest').is_checked() and await pg.locator('#cardsModal [data-kswitch]').count() == 2)
        check('…labelled', 'Draft in the background' in await pg.locator('.kpre').text_content() and 'Let the model suggest cards' in await pg.locator('.kpre').text_content())
        ys = await pg.evaluate("[document.querySelector('#cardsModal .kpre').getBoundingClientRect().bottom, document.querySelector('#cardsModal [data-kact=on]').getBoundingClientRect().top]")
        check('…above "Turn on for this conversation"', ys[0] <= ys[1], ys)
        check('cards off: no switch in a footer', await pg.locator('#cardsModal .kfoot [data-kswitch]').count() == 0)
        await sw('auto').uncheck()
        await quiet(pg)
        check('unticking while off creates no conv.cards.on', await pg.evaluate('!(__digress.conv.cards && __digress.conv.cards.on)'))
        check('…and saves nothing', await saved_cards() is None, await saved_cards())
        await close_panel(); await open_panel(foot=False)
        check('reopening the panel: both ticked again (the held choice was dropped)', await sw('auto').is_checked() and await sw('suggest').is_checked())
        await sw('auto').uncheck()
        await pg.locator('[data-kact=on]').click(); await soon(pg, "() => !!document.querySelector('#cardsModal .kfoot [data-kswitch]')")
        check('Turn on applies the choice: auto false, suggest not false', await pg.evaluate('(() => { const c = __digress.conv.cards; return c.on === true && c.auto === false && c.suggest !== false })()'))
        await soon(pg, "() => Object.keys(localStorage).some(k => k.startsWith('fakesrv:convs/') && JSON.parse(localStorage.getItem(k)).cards && JSON.parse(localStorage.getItem(k)).cards.auto === false)")
        sc = await saved_cards()
        check('…and it is saved', sc['on'] is True and sc['auto'] is False and sc.get('suggest') is not False, sc)
        check('the footer has both, auto unticked, suggest ticked', not await sw('auto').is_checked() and await sw('suggest').is_checked() and await pg.locator('#cardsModal .kfoot [data-kswitch]').count() == 2)
        await pg.screenshot(path=OUT + '/cards_manual_panel.png')
        await close_panel()

        # 2a. auto off alone: no background drafting, suggest_card still offered, manual works
        d0, n0 = await drafts(), len(await cards())
        await highlight('soft dictionary lookup', 'Why soft?')
        await ask('One more thing.')   # by now a drafting call queued by that reply would have run
        await quiet(pg)
        check('auto off: a highlight branch’s first reply makes no drafting call', await drafts() == d0, await drafts())
        check('…and adds no card', len(await cards()) == n0)
        check('auto off, suggest on: a normal reply IS offered suggest_card', 'suggest_card' in await reply_tools(), await reply_tools())
        await last_branch_take(); await ask('And a last one.'); await quiet(pg)
        check('auto off: a takeaway carried back drafts nothing', await drafts() == d0 and len(await cards()) == n0)
        await quiet(pg); await pg.reload(); await booted(pg)
        await open_panel()
        check('after a reload: auto unticked, suggest ticked', not await sw('auto').is_checked() and await sw('suggest').is_checked())
        await close_panel()
        n0 = len(await cards()); d0 = await drafts()   # the page's call log starts over with the reload
        check('auto off: a branch’s Cards button drafts into the inbox, one call', await last_branch_cards('soft dictionary lookup'))
        await pg.keyboard.press('Escape')
        await open_panel()
        mkb = pg.locator('[data-kact=make]')
        check('Make cards offers the threads not yet drafted', 'new' in await mkb.text_content(), await mkb.text_content())
        d1 = await drafts(); await mkb.click()
        await soon(pg, "() => document.querySelector('[data-kact=make]').textContent.includes('Up to date')")
        check('auto off: Make cards drafts', await drafts() > d1, await drafts())
        await close_panel()

        # 2b. suggest off alone: not offered, background drafting still happens
        await set_switches(True, False)
        await ask('Suggest is off.')
        check('suggest off: a normal reply is not offered suggest_card', 'suggest_card' not in await reply_tools(), await reply_tools())
        d0 = await drafts()
        await highlight('scores', 'Why scores?')
        await soon(pg, "n => window.__calls.filter(c => c.last.includes('[Flashcards]')).length > n", d0)
        check('suggest off, auto on: a highlight branch still drafts in the background', await drafts() > d0)
        await open_panel(); check('suggest off, auto on: switches show so', await sw('auto').is_checked() and not await sw('suggest').is_checked()); await close_panel()

        # 2c. both off: neither; manual still works
        await set_switches(False, False)
        d0, n0 = await drafts(), len(await cards())
        await highlight('scaled', 'Why scaled?')
        await ask('Both off.'); await quiet(pg)
        check('both off: no drafting call, no card', await drafts() == d0 and len(await cards()) == n0)
        check('both off: not offered suggest_card', 'suggest_card' not in await reply_tools(), await reply_tools())
        await last_branch_take(); await ask('Take back.'); await quiet(pg)
        check('both off: a takeaway drafts nothing', await drafts() == d0 and len(await cards()) == n0)
        check('both off: a branch’s Cards button still drafts', await last_branch_cards('scaled'))
        await pg.keyboard.press('Escape')
        await quiet(pg); await pg.reload(); await booted(pg)
        await open_panel()
        check('after a reload both stay unticked', not await sw('auto').is_checked() and not await sw('suggest').is_checked()
              and await pg.evaluate('__digress.conv.cards.auto === false && __digress.conv.cards.suggest === false'))
        await close_panel()

        # 2d. both on again
        await set_switches(True, True)
        await ask('Back to automatic.')
        check('both on: suggest_card is offered again', 'suggest_card' in await reply_tools(), await reply_tools())
        d2 = await drafts()
        await highlight('square root', 'Why the square root?')
        await soon(pg, "n => window.__calls.filter(c => c.last.includes('[Flashcards]')).length > n", d2)
        check('both on: a highlight branch drafts again', await drafts() > d2)
        await quiet(pg)

        # 3. the call-time check: the request began with suggest on; the switch goes off before the model calls the tool
        await main_ta.fill('LATE call please'); await main_ta.press('Enter')
        await soon(pg, '() => window.__lateAt === true')
        check('the request began with suggest_card offered', 'suggest_card' in await reply_tools(), await reply_tools())
        n0 = len(await cards())
        await open_panel(); await sw('suggest').uncheck()
        await soon(pg, "() => __digress.conv.cards.suggest === false")
        await close_panel()
        await pg.evaluate('window.__openGate()')
        await soon(pg, '() => !!window.__late')
        late = await pg.evaluate('window.__late')
        check('the late call is refused with the "off" error', 'error' in late and 'Card suggestions are off' in late['error'], late)
        await quiet(pg)
        check('…and no card was added', len(await cards()) == n0 and not await pg.evaluate("[...__digress.cards.values()].some(c => c.front === 'Late Q')"))

        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
