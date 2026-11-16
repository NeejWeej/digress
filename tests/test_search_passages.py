"""Search indexes passages, not whole messages:
  - a phrase deep in a long reply (past the 6,000 characters the old index kept) is found, previewed and
    landed on
  - a reply that matches in many passages still shows as one row (its best passage)
  - a conversation indexed in the old format is re-indexed when search opens
  - typing and pressing Enter at once opens the result for what was typed (it waits for the results)
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
}
PARA = 'The leader keeps a log of commands and sends new entries to each follower in turn. '
LONG = '\n\n'.join([PARA * 4] * 26) + '\n\nThe Log Matching Property says that if two logs hold an entry with the same index and term, they are identical up to it.\n\n' + '\n\n'.join([PARA * 4] * 6)
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const q=input[input.length-1].content;const out=q.includes('Long')?%s:'A short reply about zebras and their stripes.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};""" % json.dumps(LONG)
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

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
        await ta.fill('Long answer about Raft'); await answered(pg, ta.press('Enter'))
        long_id = await pg.evaluate('__digress.conv.id')
        check('(the reply is longer than the old 6,000-character index cut, with the phrase past it)', len(LONG) > 9000 and LONG.index('Log Matching') > 6000)
        await pg.locator('#newConv').click(); await pg.wait_for_function("__digress.conv.id!==%s" % json.dumps(long_id))
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Tell me about zebras'); await answered(pg, ta.press('Enter'))

        async def search(q):
            if not await pg.locator('#pal.show').count():
                await pg.keyboard.press('Control+k'); await pg.locator('#pal.show').wait_for()
            await pg.locator('#palIn').fill(q)
            await pg.wait_for_function("q=>document.querySelector('#palRes .pr .ps')&&document.querySelector('#palIn').value===q", arg=q, timeout=10000)
            await pg.wait_for_timeout(250)   # (deliberate: past the 90 ms debounce, so the rows are for q)
            return await pg.evaluate("[...document.querySelectorAll('#palRes .pr')].map(e=>[e.querySelector('.pk').textContent,e.querySelector('.ps').textContent])")
        rows = await search('log matching property')
        check('a phrase past the old cutoff is found, first', rows and 'Log Matching Property' in rows[0][1], rows[:2])
        rows = await search('leader log')
        answers = [r for r in rows if r[0] == 'Answer']
        check('a reply that matches in many passages is one row', len(answers) == 1, rows)
        rows = await search('log matching property')
        await pg.locator('#palRes .pr').first.click()
        await pg.wait_for_function("id=>__digress.conv.id===id&&!!CSS.highlights.get('digress-hit')", arg=long_id, timeout=10000)
        await pg.wait_for_timeout(700)   # (deliberate: the smooth scroll to the words)
        hl = await pg.evaluate("""(()=>{const rs=[...CSS.highlights.get('digress-hit')],pb=document.querySelector('.pane[data-tid=main] .pb').getBoundingClientRect(),r=rs[0].getBoundingClientRect();
            return [rs.map(x=>x.toString().toLowerCase()),r.top>pb.top&&r.bottom<pb.bottom]})()""")
        check('opening it lands on the phrase deep in the reply', set(hl[0]) >= {'log', 'matching', 'property'} and hl[1], hl)
        await pg.screenshot(path=OUT + '/search_passages.png')

        # an index in the old format (whole messages, cut at 6,000) is rebuilt
        await pg.evaluate("""id=>{const k='fakesrv:index/'+id,d=JSON.parse(localStorage.getItem(k));delete d.v;d.e=d.e.filter(e=>!/matching/i.test(e.x));localStorage.setItem(k,JSON.stringify(d))}""", long_id)
        await pg.locator(f'#side .citem[data-conv]').filter(has_text='zebras').first.click(); await pg.wait_for_timeout(300)
        await pg.reload(); await booted(pg)
        await pg.keyboard.press('Control+k'); await pg.locator('#pal.show').wait_for()
        await pg.wait_for_function("id=>(JSON.parse(localStorage.getItem('fakesrv:index/'+id))||{}).v===2", arg=long_id, timeout=15000)
        rows = await search('log matching property')
        check('an index in the old format is rebuilt when search opens', rows and 'Log Matching Property' in rows[0][1], rows[:2])

        # Enter straight after typing opens the result for what was typed
        await pg.locator('#palIn').fill('')
        await pg.locator('#palIn').type('zebras stripes', delay=5); await pg.keyboard.press('Enter')
        await pg.wait_for_function("!document.querySelector('#pal.show')", timeout=10000)
        check('typing then Enter at once opens the result for what was typed', 'zebras' in (await pg.evaluate('__digress.conv.title')).lower())
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
