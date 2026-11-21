"""Flashcards: where a card came from, and drafting from a branch.
  - A drafted card keeps the model's quote only if it's really in the conversation (word for word, give or take
    punctuation and markup); one the model made up is dropped.
  - In review the quote shows only with the answer; Open in conversation lands on it, highlighted.
  - A branch's Cards button shows it's drafting (and can't be pressed twice); a toast says when cards are in.
  - Pressed again with nothing new in the branch, it drafts nothing: it opens that branch's cards. After a new
    reply it drafts again, only from what's new; "Draft more" there drafts again on purpose.
  - The picker lists each conversation with cards, with what's due.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, answered, soon, frames, OUT, CORS
from test_pane_zoom import MAP

FAKE = r"""
window.__calls = []; window.__gate = null;
window.fakeLLM = {use: async (n) => n !== 'sample' ? null : async (input, opts) => {
  const last = input[input.length - 1].content;
  window.__calls.push(last);
  let out;
  if (last.includes('[Flashcards]')) {
    if (window.__gate) await window.__gate;
    const k = window.__calls.filter(c => c.includes('[Flashcards]')).length;
    out = JSON.stringify([
      {front: 'Why scale the scores? #' + k, back: 'So the softmax does not saturate.', quote: 'The scores are **scaled** by the square root of the dimension'},
      {front: 'Made-up quote #' + k, back: 'Something.', quote: 'This sentence appears nowhere in the conversation at all'}]);
  } else out = 'Attention is a soft dictionary lookup over the keys. The scores are scaled by the square root of the dimension. ' + 'More text. '.repeat(120);
  opts.onText && opts.onText({text: out});
  return {text: out, truncated: false};
}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

CARDS = "Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k)))"
DRAFTS = "window.__calls.filter(c=>c.includes('[Flashcards]')).length"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await answered(pg, ta.press('Enter'))
        await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').first.click()
        await pg.wait_for_function('Object.keys(__digress.conv.threads).length > 1'); await frames(pg, 3)
        bt = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        bta = pg.locator(f'.pane[data-tid="{bt}"] textarea'); await bta.fill('Why scale?'); await answered(pg, bta.press('Enter'))
        # flashcards on for this conversation
        await pg.locator('.pane[data-tid=main] [data-act=cards]').click(); await pg.locator('#cardsModal [data-kact=on]').click()
        await pg.keyboard.press('Escape'); await frames(pg)

        # the branch's Cards button, while drafting
        btn = pg.locator(f'.pane[data-tid="{bt}"] [data-act=mkcards]')
        await pg.evaluate("window.__gate = new Promise(r => window.__open = r); 0")
        await btn.click(); await soon(pg, f"() => document.querySelector('.pane[data-tid=\"{bt}\"] [data-act=mkcards]').classList.contains('busy')")
        st = await btn.evaluate("b=>[b.disabled,b.textContent,b.offsetWidth,b.closest('.pane').offsetWidth]")
        check('drafting: the branch’s Cards button says so and can’t be pressed again', st[0] and 'Drafting' in st[1], st)
        check('…and so does Review in the sidebar', 'drafting' in await pg.locator('#reviewBtn').inner_text())
        await pg.evaluate("window.__open()")
        await soon(pg, f"() => {CARDS}.length === 2")
        check('done: a toast says the cards are in, with Open', 'drafted into your inbox' in await pg.locator('#toast').inner_text() and await pg.locator('#toast .tact').count() == 1)
        cards = await pg.evaluate(CARDS)
        real = next(c for c in cards if c['front'].startswith('Why scale'))
        fake = next(c for c in cards if c['front'].startswith('Made-up'))
        check('a quote that’s in the reply is kept, with the reply it’s in', real.get('quote', {}).get('msg') and 'square root' in real['quote']['text'], real.get('quote'))
        check('…one that isn’t anywhere is dropped', 'quote' not in fake, fake.get('quote'))
        await soon(pg, f"() => !document.querySelector('.pane[data-tid=\"{bt}\"] [data-act=mkcards]').disabled")
        check('…and the button now counts the branch’s cards', 'Cards · 2' in await btn.text_content(), await btn.text_content())

        # again, nothing new: no draft, its cards open instead
        n0 = await pg.evaluate(DRAFTS)
        await btn.click(); await pg.locator('#cardsModal.show').wait_for(); await frames(pg)
        check('pressed again with nothing new: no new draft', await pg.evaluate(DRAFTS) == n0)
        check('…it opens this branch’s cards (a chip names the branch)', await pg.locator('#cardsModal .kbranch').count() == 1 and await pg.locator('#cardsModal .kitem').count() == 2)
        await pg.locator('#cardsModal [data-kact=draftmore]').click(); await soon(pg, f"() => {CARDS}.length === 4")
        check('“Draft more” drafts again on purpose', await pg.evaluate(DRAFTS) == n0 + 1)
        await pg.keyboard.press('Escape')

        # a new reply in the branch: drafts again, only what's new
        await bta.fill('And the variance?'); await answered(pg, bta.press('Enter'))
        await btn.click(); await soon(pg, f"() => {DRAFTS} === {n0 + 2}")
        ask = await pg.evaluate("window.__calls.filter(c=>c.includes('[Flashcards]')).at(-1)")
        check('after a new reply it drafts from what’s new only', 'only from what comes from the learner' in ask and 'And the variance?' in ask, ask[-400:])
        await soon(pg, f"() => {CARDS}.length === 6")

        # keep them all; review: the quote only with the answer, and Open lands on it
        await pg.evaluate("document.getElementById('reviewBtn').click()"); await pg.locator('#cardsModal.show').wait_for()
        await pg.locator('#cardsModal [data-ktab=inbox]').click(); await pg.locator('#cardsModal [data-kact=keepall]').click()
        await soon(pg, f"() => {CARDS}.every(c=>c.status==='active')")
        await pg.locator('#cardsModal [data-ktab=review]').click(); await frames(pg)
        picker = await pg.locator('#cardsModal [data-kscope]').evaluate("s=>[...s.options].map(o=>o.textContent)")
        check('the picker lists the conversation with what’s due', any('6 due' in o for o in picker[1:]) and picker[0].startswith('All conversations'), picker)
        while 'Why scale' not in await pg.locator('#cardsModal .kfront').inner_text():
            await pg.locator('#cardsModal [data-kact=skip]').click(); await frames(pg)
        check('before the answer: no quote, no way to the source', await pg.locator('#cardsModal .kquote, #cardsModal .kopen').count() == 0)
        await pg.keyboard.press('Space'); await frames(pg)
        q = await pg.locator('#cardsModal .kquote').inner_text()
        check('with the answer: the quote, and Open in conversation', 'square root of the dimension' in q and await pg.locator('#cardsModal .kopen').count() == 1, q)
        await pg.screenshot(path=OUT + '/cards_quote_review.png')
        await pg.locator('#cardsModal .kopen').click()
        await soon(pg, "() => CSS.highlights.has('digress-hit')")
        hit = await pg.evaluate("[...CSS.highlights.get('digress-hit')][0].toString()")
        check('Open lands on the quote, highlighted', 'scaled by the square root of the dimension' in hit, hit)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
