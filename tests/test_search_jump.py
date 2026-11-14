"""Search lands on the words, Back returns, and the sidebar filters documents from chats.

  - Opening a ⌘K result for an answer scrolls to the place in it where the searched words are (painted with
    the CSS Highlight API), not just to the top of the answer.
  - A Back chip then returns to where you were before the search, even in another conversation, scrolled
    where it was.
  - All · Docs · Chats appears once there's a document conversation and filters the list (remembered).
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, saved, soon, frames, calm, new_conv

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
}
PARA = 'This paragraph is filler about ordinary matters, written to make the answer long enough to scroll. '
LONG = '\n\n'.join([PARA * 3] * 14 + ['Deep inside sits the quokka migration theory, which is what we search for.'] + [PARA * 3] * 10)
FAKE = r"""
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{const q=input[input.length-1].content;
    const out=q.includes('Long')?%s:'A short reply about something else entirely.';
    opts.onText&&opts.onText({text:out});return {text:out,truncated:false};};
  return null;}};
""" % json.dumps(LONG)
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 850})
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        async def ask(q):
            ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter')); await saved(pg)
        await new_conv(pg); await ask('Long answer please')
        long_id = await pg.evaluate('__digress.conv.id')
        await new_conv(pg)
        for i in range(4): await ask(f'Other question {i} ' + 'padding words ' * 30)
        other_id = await pg.evaluate('__digress.conv.id')
        await pg.evaluate("document.querySelector('.pane[data-tid=main] .pb').scrollTop=150"); await calm(pg)
        check('no Back chip before any search', not await pg.locator('#backChip.show').count())

        # search, open the answer
        await pg.keyboard.press('Control+k'); await pg.locator('#pal.show').wait_for()
        await pg.locator('#palIn').fill('quokka migration')
        await pg.locator('#palRes .pr').filter(has_text='quokka').first.click()
        await soon(pg, "id => __digress.conv.id === id && !!CSS.highlights.get('digress-hit')", long_id); await calm(pg)   # the words are marked a moment after it opens
        check('the result opens its conversation', await pg.evaluate('__digress.conv.id') == long_id)
        hl = await pg.evaluate("(()=>{const h=CSS.highlights.get('digress-hit');return h?[...h].map(r=>r.toString().toLowerCase()):null})()")
        check('the searched words are highlighted', hl and 'quokka' in hl and 'migration' in hl, hl)
        vis = await pg.evaluate("""(()=>{const r=[...CSS.highlights.get('digress-hit')][0].getBoundingClientRect(),pb=document.querySelector('.pane[data-tid=main] .pb').getBoundingClientRect();
            return [r.top>pb.top&&r.bottom<pb.bottom, document.querySelector('.pane[data-tid=main] .pb').scrollTop]})()""")
        top = await pg.evaluate("(()=>{const m=document.querySelector('.pane[data-tid=main] .msg.assistant');return m.getBoundingClientRect().top})()")
        check('it scrolls to the words, deep in the answer (not to the answer’s top)', vis[0] and top < 0, [vis, top])
        await pg.screenshot(path=OUT + '/search_hit.png')

        # Back
        chip = pg.locator('#backChip.show')
        check('a Back chip offers the way back', await chip.count() == 1 and 'Back to' in await chip.inner_text(), await pg.locator('#backChip').inner_text())
        await pg.locator('#backGo').click()
        await soon(pg, "id => __digress.conv.id === id && Math.abs(document.querySelector('.pane[data-tid=main] .pb').scrollTop - 150) < 5", other_id); await calm(pg)
        st = await pg.evaluate("document.querySelector('.pane[data-tid=main] .pb').scrollTop")
        check('Back returns to the other conversation, scrolled where it was', await pg.evaluate('__digress.conv.id') == other_id and abs(st - 150) < 5, st)
        check('…and the chip goes away', not await pg.locator('#backChip.show').count())
        # it lives in the top bar (never over a pane's buttons), and goes once you open a conversation yourself
        await pg.keyboard.press('Control+k'); await pg.locator('#pal.show').wait_for()
        await pg.locator('#palIn').fill('quokka migration')
        await pg.locator('#palRes .pr').filter(has_text='quokka').first.click()
        await soon(pg, "id => __digress.conv.id === id", long_id); await pg.locator('#backChip.show').wait_for()
        check('the Back chip sits in the top bar', await pg.evaluate("!!document.querySelector('#backChip').closest('.top')"))
        await pg.locator(f'#side .citem[data-conv="{other_id}"]').click()
        await soon(pg, "id => __digress.conv.id === id", other_id)
        check('opening a conversation from the sidebar clears it (Back would be stale)', not await pg.locator('#backChip.show').count())

        # filter: shows once there's a document conversation
        check('no filter without documents', not await pg.locator('#cFilt.show').count())
        await pg.evaluate("""(async()=>{const c=JSON.parse(JSON.stringify(__digress.conv));c.id='cDOCX';c.title='Doc talk';c.doc={kind:'md',name:'notes.md',text:'# Notes'};
            localStorage.setItem('fakesrv:convs/cDOCX',JSON.stringify(c));})()""")
        await pg.reload(); await booted(pg)
        check('All · Docs · Chats appears with a document conversation', await pg.locator('#cFilt.show').count() == 1)
        await pg.locator(f'[data-conv="{other_id}"]').first.click(); await pg.wait_for_function('id => __digress.conv.id === id', arg=other_id)
        rows = lambda: pg.locator('#clist .citem[data-conv]').evaluate_all("es=>es.map(e=>e.dataset.conv)")
        await pg.locator('#cFilt [data-cf=doc]').click(); await frames(pg)
        r = await rows(); check('Docs shows the document conversation (and the open one, always)', sorted(r) == sorted(['cDOCX', other_id]), r)
        await pg.locator('#cFilt [data-cf=chat]').click(); await frames(pg)
        r = await rows(); check('Chats leaves it out', 'cDOCX' not in r and long_id in r, r)
        await pg.locator('#cFilt [data-cf=doc]').click(); await frames(pg)
        await pg.locator('[data-conv="cDOCX"]').first.click(); await pg.wait_for_function("__digress.conv.id === 'cDOCX'")
        await pg.locator('#cFilt [data-cf=chat]').click(); await frames(pg)
        r = await rows(); check('the open conversation stays in the list even when the filter would hide it', 'cDOCX' in r and long_id in r, r)
        await pg.reload(); await booted(pg)
        await pg.locator(f'[data-conv="{other_id}"]').first.click(); await pg.wait_for_function('id => __digress.conv.id === id', arg=other_id)
        r = await rows(); check('the filter is remembered on this device', 'cDOCX' not in r and await pg.locator('#cFilt [data-cf=chat].on').count() == 1, r)
        await pg.locator('#side').screenshot(path=OUT + '/side_filter.png')
        await pg.locator('#cFilt [data-cf=all]').click()
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
