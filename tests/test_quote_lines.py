"""Quoted PDF citations ([p. N "exact phrase"]) across the text layer's line breaks.
A pdf.js text layer is a span per line with <br role="presentation"> between and no trailing space, so a quote that
crosses a line ("the failure⏎message") used to read as "failuremessage" and never highlighted.
  - a phrase across a line break (real fixture text) highlights, and the highlight reads as the phrase
  - a word hyphenated at a line end ("scal-⏎ing", a synthetic layer: no fixture has one) matches quoted whole
    ("scaling") and with the hyphen ("scal-ing")
  - a quote that doesn't match, clicked after one that did, clears the earlier highlight
  - a quoted a.pref carries its quote in its title and is shaded unlike a plain one
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import FIX, launch_args, goto_app, booted, soon, settle, pdf_drawn

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

FAKE_LLM = """window.fakeLLM = {
  use: async (name) => name === 'sample' ? async (messages, opts) => {
    const reply = 'Plain [p. 2], across lines [p. 1 "a Soft Lookup Abstract. We describe"], '
      + 'whole word [p. 3 "the scaling term matters"], hyphenated [p. 3 "the scal-ing term matters"], '
      + 'missing [p. 1 "nonexistent phantom phrase"].';
    if (opts && opts.onToken) opts.onToken(reply);
    return { text: reply };
  } : null
};"""

# the page-3 layer as pdf.js builds it, but with a word hyphenated at the end of a line
LAYER3 = ('<span role="presentation" dir="ltr">3 Results</span><br role="presentation">'
          '<span role="presentation" dir="ltr">Ablations show the scal-</span><br role="presentation">'
          '<span role="presentation" dir="ltr">ing term matters most for wide heads.</span>')

HIT = """() => { const h = CSS.highlights.get('digress-hit'); return h ? [...h].map(r => r.toString()).join('') : null }"""
norm = lambda s: ''.join(c for c in (s or '') if not c.isspace() and c not in '­-')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1280, 'height': 850})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE_LLM)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pdf_drawn(pg); await settle(pg)
        await soon(pg, "() => document.querySelectorAll('.dpage .textLayer br').length > 0")
        check('fixture text layer has <br> between lines', await pg.evaluate(
            "() => !!document.querySelector('.dpage[data-page=\"1\"] .textLayer br[role=presentation]')"))
        await pg.evaluate("(h) => { document.querySelector('.dpage[data-page=\"3\"] .textLayer').innerHTML = h }", LAYER3)

        await pg.locator('.pane[data-tid="main"] textarea').fill('cite please')
        await pg.locator('.pane[data-tid="main"] textarea').press('Enter')
        links = pg.locator('.pane[data-tid="main"] .msg.assistant a.pref')
        await soon(pg, "() => document.querySelectorAll('.pane[data-tid=\"main\"] .msg.assistant a.pref').length === 5")

        # styling and title: quoted vs plain
        info = await pg.evaluate("""() => [...document.querySelectorAll('.pane[data-tid="main"] .msg.assistant a.pref')]
          .map(a => ({title: a.title, cite: a.dataset.cite || '', bg: getComputedStyle(a).backgroundColor, bb: getComputedStyle(a).borderBottomStyle}))""")
        plain, q0 = info[0], info[1]
        check('quoted citation title has the quote and page', '“a Soft Lookup Abstract. We describe”' in q0['title'] and 'page 1' in q0['title'], q0['title'])
        check('quoted citation is shaded unlike a plain one', q0['bg'] != plain['bg'] and plain['bg'] in ('rgba(0, 0, 0, 0)', 'transparent'), (q0['bg'], plain['bg']))
        check('plain citation keeps no quote in its title', '“' not in plain['title'], plain['title'])

        async def click_hit(i, phrase):
            await pg.keyboard.press('Escape')
            await soon(pg, "() => !CSS.highlights.has('digress-hit')")
            await links.nth(i).click()
            await soon(pg, "() => CSS.highlights.has('digress-hit')")
            t = await pg.evaluate(HIT)
            check(f'highlight reads as the phrase: {phrase}', norm(t) == norm(phrase), t)

        # (1) across a line of the real fixture
        await click_hit(1, 'a Soft Lookup Abstract. We describe')
        # (2) hyphenated at a line end: whole word and with the hyphen
        await click_hit(2, 'the scaling term matters')
        await click_hit(3, 'the scal-ing term matters')

        # (3) a quote that doesn't match, after one that did, leaves nothing lit
        await click_hit(1, 'a Soft Lookup Abstract. We describe')
        await links.nth(4).click(); await settle(pg)
        check('non-matching quote after a matching one clears the highlight',
              not await pg.evaluate("CSS.highlights.has('digress-hit')"), await pg.evaluate(HIT))

        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
