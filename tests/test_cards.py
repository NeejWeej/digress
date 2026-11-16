"""Flashcards: off until turned on per conversation; then highlights, snips and takeaways are drafted into
an inbox; "Make cards" drafts from what changed; kept cards are reviewed with FSRS and remembered across
reloads; any card can be edited, suspended or deleted. Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import OUT, FIX, launch_args, goto_app, booted, answered, soon, frames, calm, new_conv
from common import CORS
from test_pane_zoom import MAP

FAKE = r"""
window.__calls = [];
window.fakeLLM = {use: async (n) => n !== 'sample' ? null : async (input, opts) => {
  const last = input[input.length - 1].content;
  window.__calls.push({last, effort: opts.effort});
  let out;
  if (last.includes('[Flashcards]')) {
    const about = (last.match(/about “([^”]*)”/) || [, 'the main thread'])[1];
    const tk = last.includes('the takeaway below');
    out = '```json\n' + JSON.stringify(tk ? [{front: 'Takeaway Q: why divide by sqrt(d)?', back: 'To keep the **variance** at 1.'}]
      : [{front: 'Card Q1 about ' + about, back: 'Answer one with $x^2$.'}, {front: 'Card Q2 about ' + about, back: 'Answer two.'}]) + '\n```';
  } else if (last.includes('Write a short takeaway')) out = '- Scaling keeps softmax from saturating.\n- Variance stays near 1.';
  else out = 'Attention is a soft dictionary lookup over the keys. The scores are scaled by the square root of the dimension.';
  opts.onText && opts.onText({text: out});
  return {text: out, truncated: false};
}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 950})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        stored = lambda: pg.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k)))")

        async def select(tid, word):
            await pg.evaluate('''([tid, word]) => { const body = document.querySelector(`.pane[data-tid="${tid}"] .msg.assistant .body`);
              const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.nodeValue.indexOf(word);
              if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
              document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); }''', [tid, word])
            await pg.locator('#pop.show').wait_for()

        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await answered(pg, ta.press('Enter'))
        # off by default: nothing about cards anywhere, highlights make no cards
        await select('main', 'soft dictionary lookup'); await pg.locator('#popIn').fill('Why soft?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await pg.wait_for_timeout(300)   # deliberate: cards are off, so nothing should be drafted after the reply; give it the chance
        check('off by default: no Review button, no Cards button in branches, no cards drafted',
              not await pg.locator('#reviewBtn').is_visible() and not await pg.locator('.pane:not([data-tid=main]) [data-act=mkcards]').is_visible() and await stored() == []
              and not any('[Flashcards]' in c['last'] for c in await pg.evaluate('window.__calls')))

        # turn on for this conversation
        await pg.locator('.pane[data-tid=main] [data-act=cards]').click(); await soon(pg, "() => !!document.querySelector('#cardsModal.show')")
        check('the cards icon opens the panel, explaining it is off', await pg.locator('#cardsModal.show').count() == 1 and 'off for this conversation' in await pg.locator('#cardsModal .kbody').text_content())
        await pg.locator('[data-kact=on]').click(); await soon(pg, "() => document.querySelector('[data-kact=make]').textContent.includes('Make cards · 2 new')")
        check('turned on: "Make cards" offers the 2 threads already answered', 'Make cards · 2 new' in await pg.locator('[data-kact=make]').text_content())
        await pg.screenshot(path=OUT + '/cards_on.png')
        await pg.keyboard.press('Escape')
        check('branches now have a Cards button', await pg.locator('.pane:not([data-tid=main]) [data-act=mkcards]').first.is_visible())

        # a new highlight branch is drafted automatically, into the inbox
        await select('main', 'square root'); await pg.locator('#popIn').fill('Why the square root?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await soon(pg, "() => { const cards = Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k))); return cards.length >= 2 }"); await soon(pg, "() => document.getElementById('reviewBtn').textContent.includes('2 in inbox')")
        cards = await stored()
        check('answering a highlight branch drafts its cards into the inbox', len(cards) == 2 and all(c['status'] == 'inbox' and c['src'] == 'highlight' for c in cards) and 'square root' in cards[0]['front'], str([c['front'] for c in cards]))
        calls = [c for c in await pg.evaluate('window.__calls') if '[Flashcards]' in c['last']]
        check('drafting asks about the branch (naming its highlighted passage), at low effort', calls and 'about “square root”' in calls[-1]['last'] and calls[-1]['effort'] == 'low', calls and calls[-1]['last'][:160])
        check('the sidebar shows Review with the inbox count', await pg.locator('#reviewBtn').is_visible() and '2 in inbox' in await pg.locator('#reviewBtn').text_content())

        # a takeaway becomes cards too
        br = pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])').last
        await br.locator('.ph [data-act=take]').click(); await answered(pg, br.locator('.tk .go').click())
        await soon(pg, "() => { const cards = Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k))); return cards.some(c => c.src === 'takeaway') }")
        cards = await stored()
        check('a takeaway is drafted into cards', any(c['src'] == 'takeaway' for c in cards), str(len(cards)))

        # Make cards: the remaining 2 threads (main + the first branch); then nothing new
        await pg.locator('.pane[data-tid=main] [data-act=cards]').click(); await soon(pg, "() => !!document.querySelector('#cardsModal.show [data-kact=make]')")
        check('Make cards counts only what is new', 'Make cards · 2 new' in await pg.locator('[data-kact=make]').text_content(), await pg.locator('[data-kact=make]').text_content())
        await pg.locator('[data-kact=make]').click()
        await soon(pg, "() => document.querySelector('[data-kact=make]').textContent.includes('Up to date')"); await soon(pg, "() => { const cards = Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k))); return cards.filter(c => c.status === 'inbox').length >= 7 }")
        check('…and then is up to date', 'Up to date' in await pg.locator('[data-kact=make]').text_content())
        n_inbox = len([c for c in await stored() if c['status'] == 'inbox'])
        check('all drafts wait in the inbox', n_inbox == 7, str(n_inbox))

        # inbox: edit + keep one, delete one, keep the rest
        await pg.locator('.ktabs [data-ktab=inbox]').click(); await frames(pg)
        first = pg.locator('#cardsModal .kitem').first
        await first.locator('.kef').fill('Edited front: what does scaling by sqrt(d) prevent?')
        await first.locator('[data-kact=keep]').click(); await soon(pg, "() => { const cards = Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k))); return cards.some(c => c.front.startsWith('Edited front') && c.status === 'active') }")
        await pg.locator('#cardsModal .kitem').first.locator('[data-kact=del]').click(); await soon(pg, "() => { const cards = Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k))); return cards.length <= 6 }")
        cards = await stored()
        check('Keep saves the edit and makes the card due; Delete removes it', any(c['front'].startswith('Edited front') and c['status'] == 'active' for c in cards) and len(cards) == 6)
        await pg.screenshot(path=OUT + '/cards_inbox.png')
        await pg.locator('[data-kact=keepall]').click(); await soon(pg, "() => { const cards = Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k))); return cards.every(c => c.status === 'active') }")
        check('Keep all empties the inbox', all(c['status'] == 'active' for c in await stored()))

        # review with FSRS
        await pg.locator('.ktabs [data-ktab=review]').click(); await frames(pg)
        check('review shows a due card, answer hidden', await pg.locator('#cardsModal .kcard').count() == 1 and await pg.locator('#cardsModal .kback').count() == 0)
        await pg.keyboard.press('Space'); await frames(pg)
        labels = await pg.locator('#cardsModal .krate button').all_text_contents()
        check('Space shows the answer and the four ratings with their next intervals', len(labels) == 4 and labels[0].endswith('1 min') and labels[2].endswith('4 d') and labels[3].endswith('14 d'), str(labels))
        await pg.screenshot(path=OUT + '/cards_review.png')
        await pg.keyboard.press('3'); await soon(pg, "() => { const cards = Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k))); return cards.some(c => c.reviews && c.reviews.length) }")
        good = [c for c in await stored() if c.get('reviews')]
        check('rating Good schedules it about 4 days out and logs the review', len(good) == 1 and 3.5 < (good[0]['due'] - good[0]['reviews'][0]['at']) / 864e5 < 4.5 and good[0]['fsrs']['state'] == 'review')
        await pg.keyboard.press('Space'); await pg.keyboard.press('1'); await soon(pg, "() => { const cards = Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k))); return cards.some(c => c.reviews && c.reviews.length && c.reviews.at(-1).g === 1) }")
        again = [c for c in await stored() if c.get('reviews') and c['reviews'][-1]['g'] == 1]
        check('Again brings it back in a minute', len(again) == 1 and (again[0]['due'] - again[0]['reviews'][-1]['at']) <= 61000)
        before = len(await stored())
        await pg.locator('#cardsModal [data-kact=del]').first.click(); await soon(pg, "n => "+"Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k)))"+".length < n", before)
        check('a card can be deleted during review', len(await stored()) == before - 1)

        # all cards: suspend, edit
        await pg.locator('.ktabs [data-ktab=all]').click(); await frames(pg)
        await pg.locator('#cardsModal .kitem').first.locator('[data-kact=suspend]').click(); await soon(pg, "() => { const cards = Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k))); return cards.some(c => c.status === 'suspended') }")
        check('a card can be suspended', any(c['status'] == 'suspended' for c in await stored()))

        # the source link: to the exact reply, and back to the same card
        src = next(c for c in await stored() if c['src'] == 'highlight')
        check('cards remember the reply they came from and the branch name', src.get('at', {}).get('msg') and src['at']['thread'] == src['thread'] and 'square root' in src.get('where', '').lower(), str(src.get('at')) + ' ' + str(src.get('where')))
        link = pg.locator(f'#cardsModal .ksrc[data-kid="{src["id"]}"]')
        check('each card shows where it came from, as a link', await link.count() == 1 and 'square root' in (await link.text_content()).lower(), await link.text_content() if await link.count() else '')
        await link.click(); await calm(pg)
        check('the link goes to the branch the card came from', await pg.locator('#cardsModal.show').count() == 0 and await pg.locator(f'.pane[data-tid="{src["thread"]}"]').count() == 1)
        check('…flashing the reply it was drafted from', await pg.locator(f'.pane[data-tid="{src["thread"]}"] .msg.flash[data-mid="{src["at"]["msg"]}"]').count() == 1)
        check('…and the highlighted passage in the parent', await pg.locator(f'.pane[data-tid=main] .anchor.flash[data-tid="{src["thread"]}"]').count() >= 1)
        await pg.screenshot(path=OUT + '/cards_source.png')
        check('a "Back to review" button appears', await pg.locator('#backReview .br-go').is_visible())
        await pg.locator('#backReview .br-go').click(); await frames(pg)
        check('…which returns to the same tab', await pg.locator('#cardsModal.show').count() == 1 and await pg.locator('.ktabs [data-ktab=all].on').count() == 1 and not await pg.locator('#backReview').is_visible())
        await pg.keyboard.press('Escape')
        # takeaway cards go to the takeaway note
        tk = next(c for c in await stored() if c['src'] == 'takeaway')
        check('a takeaway card points at the takeaway note, in the thread it was carried to', tk['at']['thread'] == 'main' and await pg.locator(f'.pane[data-tid=main] .msg[data-mid="{tk["at"]["msg"]}"]').count() == 1, str(tk.get('at')))
        # review: O opens the card's source; Back returns with the answer still showing
        due = [c for c in await stored() if c['status'] == 'active' and c['due'] <= __import__('time').time() * 1000]
        if not due:
            await pg.evaluate("(async()=>{for(const c of CARDS.values())if(c.status==='active'){c.due=Date.now()-1;await putCard(c);break}})()")
        await pg.locator('.pane[data-tid=main] [data-act=cards]').click(); await pg.locator('#cardsModal.show').wait_for()
        await pg.locator('.ktabs [data-ktab=review]').click(); await frames(pg)
        await pg.keyboard.press('Space'); await frames(pg)
        front = await pg.locator('#cardsModal .kfront').text_content()
        await pg.keyboard.press('o'); await calm(pg)
        check('in review, O opens the card in its conversation', await pg.locator('#cardsModal.show').count() == 0 and await pg.locator('#backReview').is_visible())
        await pg.locator('#backReview .br-go').click(); await frames(pg)
        check('…and Back to review returns to the same card, answer still shown', await pg.locator('#cardsModal .kfront').text_content() == front and await pg.locator('#cardsModal .krate button').count() == 4)
        await pg.keyboard.press('Escape')

        # persists; a new conversation is unaffected
        await pg.reload(); await booted(pg); await soon(pg, "() => document.getElementById('reviewBtn').checkVisibility()")
        check('after a reload the Review button and cards are still there', await pg.locator('#reviewBtn').is_visible() and len(await stored()) == before - 1)
        await new_conv(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Something else'); await answered(pg, ta.press('Enter'))
        n_calls = len(await pg.evaluate('window.__calls'))
        await select('main', 'soft dictionary'); await pg.locator('#popIn').fill('Why?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await pg.wait_for_timeout(300)   # deliberate: cards are off here, so nothing should be drafted; give it the chance
        check('in another conversation (cards off), highlights draft nothing', not any('[Flashcards]' in c['last'] for c in (await pg.evaluate('window.__calls'))[n_calls:]))
        await pg.locator('#reviewBtn').click(); await pg.locator('#cardsModal.show').wait_for()
        check('the sidebar Review covers all conversations', await pg.locator('#cardsModal [data-kscope]').input_value() == 'all')
        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
