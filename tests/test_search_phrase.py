"""Search ranks and shows phrases: for "log matching property", an answer with that exact phrase comes
before one that only has the words scattered; its snippet is centred on the phrase (not on the first
"log"); a typo match ("machine" for "matching") isn't highlighted when the typed word is there; and
opening it lands on the phrase. Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, steady, calm

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
}
LOGS = ' '.join(f'The leader appends entry {i} to its log and the state machine applies it later.' for i in range(30))
A = LOGS + '\n\nThe Log Matching Property says that if two logs contain an entry with the same index and term, the logs are identical up to that entry.\n\n' + LOGS
B = 'Each server keeps a log. Matching votes across terms is tricky. Another property: the state machine is deterministic. ' * 3
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const q=input[input.length-1].content;const out=q.includes('Scattered')?%s:q.includes('Phrase')?%s:'Ok.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};""" % (json.dumps(B), json.dumps(A))
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea')
        for q in ('Scattered words please', 'Phrase answer please'):
            await ta.fill(q); await ta.press('Enter'); await pg.wait_for_function("!Object.values(__digress.conv.msgs).some(m=>m.pending)", timeout=15000)
        await pg.keyboard.press('Control+k'); await pg.locator('#pal.show').wait_for()
        await pg.locator('#palIn').fill('log matching property')
        await pg.wait_for_function("document.querySelectorAll('#palRes .pr').length>=2", timeout=10000); await steady(pg, "document.getElementById('palRes').innerHTML")
        rows = await pg.evaluate("[...document.querySelectorAll('#palRes .pr .ps')].map(e=>[e.textContent,[...e.querySelectorAll('mark')].map(m=>m.textContent.toLowerCase())])")
        check('the answer with the exact phrase comes first', 'Log Matching Property' in rows[0][0], [r[0][:80] for r in rows])
        check('its snippet is centred on the phrase, not the first “log”', rows[0][0].startswith('…') and 'Log Matching Property' in rows[0][0], rows[0][0][:160])
        check('“machine” isn’t highlighted as a match for “matching”', 'machine' not in rows[0][1] and 'matching' in rows[0][1] and 'property' in rows[0][1], rows[0][1])
        await pg.screenshot(path=OUT + '/search_phrase.png')
        await pg.locator('#palRes .pr').first.click(); await pg.wait_for_function("!!CSS.highlights.get('digress-hit')"); await calm(pg)
        hl = await pg.evaluate("(()=>{const h=CSS.highlights.get('digress-hit');return h?[...h].map(r=>r.toString().toLowerCase()):null})()")
        check('opening it highlights the phrase’s words, not a cluster of “log”s', hl and set(hl) >= {'log', 'matching', 'property'} and 'machine' not in hl, hl)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
