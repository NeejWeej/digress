""""Describe it instead": search for something you half remember.
  - the row appears under the results (and when nothing matched)
  - step 1 sends only what you typed and the titles in scope: no message text
  - the model's phrases are searched as usual; a passage the typed words miss is found, labelled with the
    phrase that found it, and opening it lands on those words
  - step 2 (only when chosen) sends short snippets of the candidates and shows the model's picks with why
  - nothing is added to any conversation
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
}
RAFT = ('Raft keeps a replicated log on every server. ' * 3 + '\n\n') + 'The Log Matching Property: if two logs contain an entry with the same index and term, the logs are identical in all entries up to it. SECRETWORD appears only here.\n\n' + ('Elections use randomized timeouts. ' * 3)
FAKE = r"""window.__asks=[];window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const q=input[input.length-1].content;
  if(q.includes('search phrases')){window.__asks.push({step:1,text:q,model:opts.model});return {text:'- log matching property\n- consistency check\n- identical logs',truncated:false}}
  if(q.includes('Candidate passages')){window.__asks.push({step:2,text:q});return {text:'[{"n": 1, "why": "states that matching entries imply identical logs"}]',truncated:false}}
  const out=q.includes('Raft')?%s:'Bananas are berries; strawberries are not.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};""" % json.dumps(RAFT)
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:400])
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
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain Raft consensus'); await answered(pg, ta.press('Enter'))
        raft = await pg.evaluate('__digress.conv.id')
        await pg.locator('#newConv').click(); await pg.wait_for_function("id=>__digress.conv.id!==id", arg=raft)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Fruit trivia'); await answered(pg, ta.press('Enter'))
        before = await pg.evaluate("JSON.stringify(Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:convs/')).map(k=>JSON.parse(localStorage.getItem(k))).map(c=>[c.id,Object.keys(c.msgs).length]))")

        await pg.keyboard.press('Control+k'); await pg.locator('#pal.show').wait_for()
        desc = 'guarantee copies agree'
        await pg.locator('#palIn').fill(desc)
        await pg.locator('#palRes .pr.pai').wait_for(timeout=10000)
        await pg.wait_for_timeout(250)   # (deliberate: past the 90 ms debounce, so the rows are for the description)
        rows = await pg.evaluate("[...document.querySelectorAll('#palRes .pr')].map(e=>e.textContent)")
        check('plain search doesn’t find the passage, and a row offers to find it with AI', not any('Log Matching' in r for r in rows) and 'Describe it instead' in rows[-1], rows)
        await pg.locator('#palRes .pr.pai').click()
        await pg.wait_for_function("document.querySelector('#palRes .pgrp')?.textContent.includes('Found with AI')", timeout=10000)
        asks = await pg.evaluate('window.__asks')
        a1 = asks[0]['text'] if asks else ''
        check('step 1 sends the description and the conversation titles', desc in a1 and 'Explain Raft consensus' in a1 and 'Fruit trivia' in a1, a1[:400])
        check('…but no message text', 'replicated log' not in a1 and 'SECRETWORD' not in a1 and 'Bananas' not in a1, a1[:400])
        check('…to a fast model', asks and 'haiku' in str(asks[0].get('model', '')).lower(), asks[:1])
        rows = await pg.evaluate("[...document.querySelectorAll('#palRes .pr:not(.pai)')].map(e=>e.textContent)")
        check('the passage is found, with the phrase that found it', rows and 'Log Matching Property' in rows[0] and 'found with “log matching property”' in rows[0], rows[:2])
        await pg.screenshot(path=OUT + '/search_describe.png')

        await pg.locator('#palRes .pr.pai').click()
        await pg.wait_for_function("document.querySelector('#palRes .pgrp')?.textContent.includes('Picked by AI')", timeout=10000)
        asks = await pg.evaluate('window.__asks')
        a2 = asks[-1]['text'] if len(asks) > 1 else ''
        check('step 2 runs only when chosen, and sends short snippets', len(asks) == 2 and asks[-1]['step'] == 2 and 'Log Matching Property' in a2 and len(a2) < 3000, len(a2))
        rows = await pg.evaluate("[...document.querySelectorAll('#palRes .pr')].map(e=>e.textContent)")
        check('the model’s pick shows with its reason', rows and 'matching entries imply identical logs' in rows[0], rows[:2])
        await pg.locator('#palRes .pr').first.click()
        await pg.wait_for_function("id=>__digress.conv.id===id&&!!CSS.highlights.get('digress-hit')", arg=raft, timeout=10000)
        hl = await pg.evaluate("[...CSS.highlights.get('digress-hit')].map(r=>r.toString().toLowerCase())")
        check('opening it lands on the words that found it', 'matching' in hl and 'property' in hl, hl)
        after = await pg.evaluate("JSON.stringify(Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:convs/')).map(k=>JSON.parse(localStorage.getItem(k))).map(c=>[c.id,Object.keys(c.msgs).length]))")
        check('nothing was added to any conversation', before == after, [before, after])
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
