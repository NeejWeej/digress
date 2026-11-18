"""A branch about a whole reply (Side question, no highlight) can be reached from its parent everywhere.
  - Columns and Rows: a chip under the reply.
  - Canvas: the same chip under the reply in the parent's open card; clicking it goes to the branch's card
    (flashes it). (The line to the branch starts at the chip: drawEdges looks for it after inline markers.)
  - (Branches from a highlight keep their inline marker as well; they get a chip too, as in a pane.)
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames, calm, CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out='Attention lets each token weigh every other token. The weights come from a softmax over scores.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

card = lambda tid: f'#cv .cnode[data-ctid="{tid}"]'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 860})
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
        await pg.wait_for_function('Object.keys(__digress.conv.threads).length > 1')
        br = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        await frames(pg)
        check('Columns: a chip under the reply goes to the branch', await pg.locator(f'.pane[data-tid=main] .bchip[data-tid="{br}"]').count() == 1)
        await pg.locator('#viewSeg [data-v=rows]').click(); await frames(pg)
        check('Rows: the same chip', await pg.locator(f'.pane[data-tid=main] .bchip[data-tid="{br}"]').count() == 1)

        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await pg.locator(card('main')).wait_for(); await calm(pg)
        if not await pg.locator(card('main') + ' .cfull').count():
            await pg.evaluate(f"document.querySelector('{card('main')} [data-cact=exp]').click()"); await pg.locator(card('main') + ' .cfull').wait_for()
        await frames(pg)
        chip = pg.locator(f'{card("main")} .cfull .bchip[data-tid="{br}"]')
        check('Canvas: the open card shows the chip under the reply', await chip.count() == 1 and await chip.is_visible())
        check('…numbered and named like the pane’s', (await chip.locator('.n').inner_text()) == '1')
        check('…outside the reply’s text (anchors count only the text)', await pg.evaluate(f"!document.querySelector('{card('main')} .cfull .body .bchip')"))
        await pg.evaluate(f"document.querySelector('{card(br)}').classList.remove('flash')")
        await chip.click(); await frames(pg, 3)
        check('clicking it goes to the branch’s card', await pg.evaluate(f"document.querySelector('{card(br)}').classList.contains('flash')"))
        check('…and opens nothing else (no branch popup)', not await pg.locator('#pop.show').count())
        await pg.screenshot(path=OUT + '/canvas_whole_branch.png')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
