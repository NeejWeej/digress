"""Flashcards: fixing a card from review.
  - With the answer showing, Edit changes the card in place (its schedule kept).
  - Fix… asks what's off (chips, an optional note); the card leaves review and the model's suggestion waits in
    the inbox: before, after (editable) and why. Accept applies it; a changed answer starts the card over,
    better wording keeps its schedule. Split makes two cards; Keep original puts it back as it was.
  - The model is told what the learner said, with the conversation as context.
Asserts and exits non-zero."""
import asyncio, sys, json
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, answered, soon, frames, OUT, CORS
from test_pane_zoom import MAP

FAKE = r"""
window.__calls = []; window.__fix = null;
window.fakeLLM = {use: async (n) => n !== 'sample' ? null : async (input, opts) => {
  const last = input[input.length - 1].content;
  window.__calls.push(last);
  let out;
  if (last.includes('[Flashcards: fix a card]')) out = JSON.stringify(window.__fix);
  else if (last.includes('[Flashcards]')) out = JSON.stringify([
      {front: 'Why scale the scores?', back: 'So the softmax saturates.', quote: 'The scores are scaled by the square root of the dimension'},
      {front: 'What is attention?', back: 'A soft lookup.'},
      {front: 'Third card?', back: 'Third.'}]);
  else out = 'Attention is a soft dictionary lookup over the keys. The scores are scaled by the square root of the dimension so the softmax does not saturate. ' + 'More text. '.repeat(60);
  opts.onText && opts.onText({text: out});
  return {text: out, truncated: false};
}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

CARDS = "Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:cards/')).map(k=>JSON.parse(localStorage.getItem(k)))"
FIXES = "window.__calls.filter(c=>c.includes('[Flashcards: fix a card]'))"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 900})
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
        await pg.locator('.pane[data-tid=main] [data-act=cards]').click(); await pg.locator('#cardsModal [data-kact=on]').click()
        await pg.locator('#cardsModal [data-kact=make]').click(); await soon(pg, f"() => {CARDS}.length === 3")
        await pg.locator('#cardsModal .ktabs [data-ktab=inbox]').click(); await pg.locator('#cardsModal [data-kact=keepall]').click()
        await soon(pg, f"() => {CARDS}.every(c=>c.status==='active')")
        await pg.locator('#cardsModal .ktabs [data-ktab=review]').click(); await frames(pg)

        async def to_card(front):
            for _ in range(6):
                if front in await pg.locator('#cardsModal .kfront').inner_text(): return
                await pg.locator('#cardsModal [data-kact=skip]').click(); await frames(pg)
        # Edit from the answer
        await to_card('What is attention'); await pg.keyboard.press('Space'); await frames(pg)
        check('with the answer: Edit and Fix…', await pg.locator('#cardsModal .kacts [data-kact=edit]').count() == 1 and await pg.locator('#cardsModal .kacts [data-kact=fix]').count() == 1)
        await pg.keyboard.press('e'); await frames(pg)
        await pg.locator('#cardsModal .keb').fill('A soft dictionary lookup over the keys.')
        await pg.locator('#cardsModal [data-kact=saveedit]').click(); await frames(pg)
        c = next(x for x in await pg.evaluate(CARDS) if x['front'].startswith('What is attention'))
        check('Edit saves the card', c['back'] == 'A soft dictionary lookup over the keys.', c['back'])
        check('…and you’re back on it, answer showing', 'soft dictionary' in await pg.locator('#cardsModal .kback').inner_text())

        # Fix…: a wrong answer
        await pg.evaluate("""window.__fix = {verdict:'rewrite', change:'answer', why:'The reply says scaling keeps the softmax from saturating.',
            cards:[{front:'Why scale the scores?', back:'So the softmax does not saturate.', quote:'scaled by the square root of the dimension so the softmax does not saturate'}]}""")
        await to_card('Why scale'); await pg.keyboard.press('Space'); await frames(pg)
        await pg.keyboard.press('f'); await pg.locator('#cardsModal .kfix').wait_for()
        await pg.locator('#cardsModal [data-kchip="Wrong"]').click()
        await pg.locator('#cardsModal .kfixn').fill('It says the opposite of the reply')
        await pg.screenshot(path=OUT + '/cards_fix_form.png')
        await pg.keyboard.press('Control+Enter')
        await soon(pg, f"() => {FIXES}.length === 1")
        ask = (await pg.evaluate(FIXES))[0]
        check('the model gets the card and what you said', 'So the softmax saturates.' in ask and 'Wrong' in ask and 'opposite of the reply' in ask, ask[-600:])
        await soon(pg, f"() => {CARDS}.some(c=>c.fix&&c.fix.state==='ready')")
        check('the card leaves review while its fix waits', 'Why scale' not in await pg.locator('#cardsModal .kbody').inner_text())
        check('a toast says the fix is in the inbox', 'inbox' in await pg.locator('#toast').inner_text())
        await pg.locator('#cardsModal .ktabs [data-ktab=inbox]').click(); await frames(pg)
        it = pg.locator('#cardsModal .kfixit')
        check('the inbox shows the fix: before, after and why', await it.count() == 1 and 'So the softmax saturates.' in await it.locator('.kwas').inner_text()
              and await it.locator('.keb').input_value() == 'So the softmax does not saturate.' and 'saturating' in await it.locator('.kwhy').inner_text())
        check('…and says it starts over', 'starts over' in await it.locator('.kchg').inner_text())
        await pg.screenshot(path=OUT + '/cards_fix_inbox.png')
        await it.locator('[data-kact=acceptfix]').click(); await frames(pg)
        c = next(x for x in await pg.evaluate(CARDS) if x['front'].startswith('Why scale'))
        check('Accept applies it, with the new quote', c['back'] == 'So the softmax does not saturate.' and 'fix' not in c and 'does not saturate' in c.get('quote', {}).get('text', ''), c)
        check('…and a changed answer starts the card over', c['fsrs'] is None)

        # Fix… → split, accepted: two cards; then one kept as it was
        await pg.evaluate("""window.__fix = {verdict:'split', change:'wording', why:'Two things in one.',
            cards:[{front:'Third A?', back:'A.'},{front:'Third B?', back:'B.'}]}""")
        await pg.locator('#cardsModal .ktabs [data-ktab=review]').click(); await frames(pg)
        await to_card('Third'); await pg.keyboard.press('Space'); await pg.keyboard.press('f')
        await pg.locator('#cardsModal [data-kact=sendfix]').click()
        await soon(pg, f"() => {CARDS}.some(c=>c.fix&&c.fix.state==='ready')")
        await pg.locator('#cardsModal .ktabs [data-ktab=inbox]').click(); await frames(pg)
        check('a split shows two cards to accept', await pg.locator('#cardsModal .kfixit .kpair').count() == 2)
        await pg.locator('#cardsModal [data-kact=acceptfix]').click(); await frames(pg)
        fr = sorted(x['front'] for x in await pg.evaluate(CARDS))
        check('Accept both: the card becomes two', 'Third A?' in fr and 'Third B?' in fr and 'Third card?' not in fr and len(fr) == 4, fr)

        await pg.evaluate("window.__fix = {verdict:'right', why:'The reply says exactly this.'}")
        await pg.locator('#cardsModal .ktabs [data-ktab=review]').click(); await frames(pg)
        await to_card('What is attention'); await pg.keyboard.press('Space'); await pg.keyboard.press('f')
        await pg.locator('#cardsModal [data-kact=sendfix]').click()
        await soon(pg, f"() => {CARDS}.some(c=>c.fix&&c.fix.state==='ready')")
        await pg.locator('#cardsModal .ktabs [data-ktab=inbox]').click(); await frames(pg)
        check('“it’s right” says so, with why', 'Looks right' in await pg.locator('#cardsModal .kfixit .kwhy').inner_text())
        await pg.locator('#cardsModal [data-kact=acceptfix]').click(); await frames(pg)
        c = next(x for x in await pg.evaluate(CARDS) if x['front'].startswith('What is attention'))
        check('Keep it: the card is as it was, back in review', 'fix' not in c and c['back'] == 'A soft dictionary lookup over the keys.')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
