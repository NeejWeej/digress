"""Page citations in a reply become links to the document's pages (linkPages).
  - One page or one range is one link, brackets and all: [p. 4], [p. 20–22].
  - A list gives each page or range its own link: [p. 2, 7], [p. 5, 13–15], [pp. 4, 26–27], [p. 3; p. 9]; the text
    reads exactly as written (nothing added or lost, so anchors that count characters don't move).
  - Not inside code, and not a bracket that isn't a citation ([1, 2], [p. x]).
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

RUN = """(html) => { const d = document.createElement('div'); d.innerHTML = html; __digress.linkPages(d);
  return {text: d.textContent, links: [...d.querySelectorAll('a.pref')].map(a => [a.textContent, a.dataset.page])} }"""

CASES = [
    ('one page', 'See [p. 4].', [['[p. 4]', '4']]),
    ('one range', 'See [p. 20–22].', [['[p. 20–22]', '20']]),
    ('two pages', 'Output, not cost [p. 2, 7].', [['[p. 2', '2'], ['7]', '7']]),
    ('a page and a range', 'Everyone codes [p. 5, 13–15].', [['[p. 5', '5'], ['13–15]', '13']]),
    ('pp. with a hyphen range', 'It skews [pp. 4, 26-27].', [['[pp. 4', '4'], ['26-27]', '26']]),
    ('three, with semicolons and p. again', 'Both [p. 3; p. 9; 12].', [['[p. 3', '3'], ['p. 9', '9'], ['12]', '12']]),
    ('two citations in one line', 'A [p. 1] and B [p. 2, 3].', [['[p. 1]', '1'], ['[p. 2', '2'], ['3]', '3']]),
    ('not in code', 'Run <code>[p. 2, 7]</code> here.', []),
    ('not a citation', 'Refs [1, 2] and [p. x].', []),
]

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await goto_app(pg); await booted(pg)
        for name, html, want in CASES:
            r = await pg.evaluate(RUN, html)
            plain = await pg.evaluate("(h)=>{const d=document.createElement('div');d.innerHTML=h;return d.textContent}", html)
            check(f'{name}: {html}', r['links'] == want and r['text'] == plain, r)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
