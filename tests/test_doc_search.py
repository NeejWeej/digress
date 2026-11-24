"""The document tool `search`, as the model gets it (runDocTool in the page, on a made-up document):
  - several queries in one call, each answered in its own section and kept in the reply's trail; the old `query` still works;
  - matched word for word but forgiving: case, accents (Väinämöinen finds Väinamöinen), ligatures (ﬁ), quotes,
    and hyphens or line breaks between letters (water-hero finds "water- hero" split across a line);
  - a match starts at the start of a word ("art" doesn't find "start"), and "Section 4.2" doesn't find "Section 42";
  - a query not found word for word gets the closest passages, by its words or words that start the same
    ("child divinity" finds "the divine child"), marked as such; with nothing close, it says so.
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:600])
    if not ok: fails.append(name)

PAGES = [
    'Copper the gauntlets on his hands. Väinamöinen asked the hero from the sea who he was. "I am a man as you see—small, but a mighty water-\nhero. I have come to fell the oak."',
    'The ﬁnal answer comes from Bayes’ theorem, as Section 42 explains. We start again from the prior.',
    'In many myths the divine child is abandoned and survives alone: an orphan in a hostile world. Such a child grows into a god.',
    'Nothing about that here. Gardens, weather and the price of bread in the infor-\nmation age.',
]
RUN = """async ([pages, input]) => {
  __digress.docState = {key: 'x', kind: 'pdf', name: 'myths.pdf', pages, n: pages.length, loaded: true};
  const trail = [], r = await __digress.runDocTool('search', input, trail);
  return {text: r.error || r.parts.map(p => p.text).join(''), trail};
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        pg = await b.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("window.fakeLLM = {use: async () => async () => ({text: 'ok'})};")
        await goto_app(pg); await booted(pg)
        run = lambda inp: pg.evaluate(RUN, [PAGES, inp])

        r = await run({'queries': ['Väinämöinen', 'water-hero']})
        check('two queries in one call: two sections, two trail entries', r['text'].count('———') == 1 and [x['q'] for x in r['trail']] == ['Väinämöinen', 'water-hero'], r)
        check('accents don’t matter (Väinämöinen finds Väinamöinen)', '1 match for "Väinämöinen", on pages 1' in r['text'], r['text'])
        check('a word hyphenated across a line still matches (water-hero)', '1 match for "water-hero", on pages 1' in r['text'] and 'mighty water- hero' in r['text'], r['text'])

        r = await run({'query': 'final answer'})
        check('the old `query` still works, and ligatures fold (ﬁnal)', '1 match for "final answer", on pages 2' in r['text'], r['text'])
        r = await run({'queries': ["Bayes' theorem", 'BAYES THEOREM', 'information']})
        check('quotes and case don’t matter', r['text'].count('1 match for') == 3, r['text'])

        r = await run({'queries': ['art']})
        check('a match starts at a word ("art" doesn’t find "start")', 'No exact match' in r['text'] or 'No matches' in r['text'], r['text'])
        r = await run({'queries': ['Section 4.2']})
        check('"Section 4.2" doesn’t find "Section 42"', 'match for' not in r['text'], r['text'])

        r = await run({'queries': ['child divinity']})
        check('not found word for word: the closest passages instead, marked', r['text'].startswith('No exact match for "child divinity"') and '[p. 3]' in r['text'] and 'divine' in r['text'], r['text'])
        check('…its trail entry says where they were', r['trail'] == [{'t': 'search', 'q': 'child divinity', 'n': 0, 'pages': [], 'near': [3]}], r['trail'])
        r = await run({'queries': ['orphaned gods']})
        check('words that start the same count (orphaned ~ orphan, gods ~ god)', '[p. 3]' in r['text'] and 'orphan' in r['text'], r['text'])

        r = await run({'queries': ['quantum chromodynamics']})
        check('nothing close: says so', r['text'].startswith('No matches for "quantum chromodynamics"'), r['text'])
        r = await run({'queries': ['  ', '']})
        check('empty queries: an error the model can read', 'needs "queries"' in r['text'], r)
        r = await run({'queries': [f'q{i}' for i in range(8)]})
        check('more than 6: the first 6, and it says so', r['text'].count('———') == 5 and 'Only the first 6' in r['text'], r['text'][-200:])

        check('no page errors', not errs, errs)
        await b.close()
    if fails: print('FAILED:', fails); sys.exit(1)
    print('all passed')

asyncio.run(main())
