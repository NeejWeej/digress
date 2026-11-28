"""Search folds accents: "cafe" finds "Café" and "café" finds "cafe"; the result's snippet marks the
accented word itself, and opening the result paints the digress-hit highlight over it. With accented
text before the match ("déjà vu at the Café Central", searched "cafe central") the mark and the
highlight cover exactly "Café Central" (offsets don't drift). Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, steady, calm
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
}
REPLIES = {
    'Alpha': 'Mornings are quiet. The Café opens early and the bakery next door smells of bread all day long.',
    'Bravo': 'Evenings are busy. The espresso at the cafe near the station is strong and the staff are friendly.',
    'Charlie': 'Résumé night: déjà vu at the Café Central, where the naïve tourists queue past the señor at the door.',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const q=input[input.length-1].content;const R=%s;const k=Object.keys(R).find(k=>q.includes(k));const out=k?R[k]:'Ok.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};""" % json.dumps(REPLIES)
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else detail)
    if not ok: fails.append(name)

async def search(pg, q, want):
    """Open search, type q, wait for the row whose snippet contains `want`; return (row index, its mark texts)."""
    await pg.keyboard.press('Control+k'); await pg.locator('#pal.show').wait_for()
    await pg.locator('#palIn').fill(q)
    await pg.wait_for_function("w=>[...document.querySelectorAll('#palRes .pr .ps')].some(e=>e.textContent.includes(w))", arg=want, timeout=10000)
    await steady(pg, "document.getElementById('palRes').innerHTML")
    return await pg.evaluate("w=>{const rows=[...document.querySelectorAll('#palRes .pr')];const i=rows.findIndex(r=>r.querySelector('.ps')?.textContent.includes(w));return [i,[...rows[i].querySelectorAll('.ps mark')].map(m=>m.textContent)]}", want)

async def land(pg, i):
    await pg.evaluate("CSS.highlights.delete('digress-hit')")
    await pg.locator('#palRes .pr').nth(i).click()
    await pg.wait_for_function("!!CSS.highlights.get('digress-hit')"); await calm(pg)
    return await pg.evaluate("[...CSS.highlights.get('digress-hit')].map(r=>r.toString())")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea')
        for q in REPLIES:
            await ta.fill(q); await ta.press('Enter'); await pg.wait_for_function("!Object.values(__digress.conv.msgs).some(m=>m.pending)", timeout=15000)

        # cafe -> Café
        i, marks = await search(pg, 'cafe', 'Café opens')
        check('“cafe” finds “Café”: the snippet mark is the accented word', 'Café' in marks, marks)
        hl = await land(pg, i)
        check('opening it highlights “Café”', 'Café' in hl, hl)

        # café -> cafe
        i, marks = await search(pg, 'café', 'espresso at the cafe')
        check('“café” finds “cafe”: the snippet mark is the plain word', 'cafe' in marks, marks)
        hl = await land(pg, i)
        check('opening it highlights “cafe”', 'cafe' in hl, hl)

        # accents before the match, a two-word phrase
        i, marks = await search(pg, 'cafe central', 'Café Central')
        check('“cafe central” marks exactly “Café Central” after other accented text', 'Café Central' in marks or marks == ['Café', 'Central'], marks)
        check('the marks have no stray characters', ''.join(marks).replace(' ', '') == 'CaféCentral', marks)
        hl = await land(pg, i)
        check('its highlight covers exactly “Café Central”', ''.join(hl).replace(' ', '') == 'CaféCentral' and ('Café Central' in hl or hl == ['Café', 'Central']), hl)
        await pg.screenshot(path=OUT + '/search_accents.png')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
