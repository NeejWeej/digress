"""The branch count in a pane's header opens a list of those branches: the sidebar's tree from that pane down.
  - The document's list has the document's branches, main's has main's (and theirs, nested).
  - A row opens its branch and closes the list; a click elsewhere or Escape closes it.
  - No count to click when there are no branches. The list has no row buttons (pin, hide, delete stay in the sidebar).
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, OUT, launch_args, goto_app, booted, answered, frames, PDF_DRAWN_JS
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out='The paper argues that attention alone is enough. The weights come from a softmax over scores.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SELECT = """(word) => { const b=[...document.querySelectorAll('.pane .msg.assistant .body')].pop();
  const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){const i=n.nodeValue.indexOf(word); if(i>=0){
  const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+word.length); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
  document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }"""
origin = lambda pg, tid: pg.locator(f'.pane[data-tid="{tid}"] .ph-origin').inner_text()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1700, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
        check('no branches: nothing to click', await pg.locator('.pane[data-tid=main] .ph-origin [data-brlist]').count() == 0)
        await pg.locator('.pane[data-tid=doc] .dpage').first.hover(); await pg.locator('.pane[data-tid=doc] [data-pask="1"]').click()
        await pg.locator('#popIn').fill('What is on this page?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What does it argue?'); await answered(pg, ta.press('Enter'))
        await pg.evaluate(SELECT.replace('.pane .msg', '.pane[data-tid=main] .msg'), 'softmax')
        await pg.locator('#popIn').fill('Why a softmax?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        mbr = await pg.evaluate("Object.values(__digress.conv.threads).find(t=>t.parent==='main'&&t.anchorMsg!=='DOC').id")
        await pg.evaluate(SELECT.replace('.pane .msg', f'.pane[data-tid="{mbr}"] .msg'), 'attention')
        await pg.locator('#popIn').fill('What is attention?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        sub = await pg.evaluate(f"Object.values(__digress.conv.threads).find(t=>t.parent==='{mbr}').id")
        await pg.evaluate(f"__digress.conv.ui.open=__digress.conv.ui.open.filter(x=>x!=='{sub}')"); await pg.evaluate('__digress.refresh()'); await frames(pg)

        await pg.locator('.pane[data-tid=main] .ph-origin [data-brlist]').click(); await frames(pg)
        pop = pg.locator('.brpop')
        rows = await pop.locator('[data-map]').evaluate_all('es=>es.map(e=>e.dataset.map)')
        check('main’s count opens its branches, nested', rows == [mbr, sub] and await pop.locator(f'[data-map="{mbr}"] + ul [data-map="{sub}"]').count() == 1, rows)
        check('…headed with how many and off what', 'branches off the main thread' in await pop.locator('.brhead').inner_text())
        check('…no row buttons in it', await pop.locator('.macts,[data-delb],[data-tfold]').count() == 0)
        await pg.screenshot(path=OUT + '/branch_list.png')
        await pg.mouse.click(900, 700); await frames(pg)
        check('a click elsewhere closes it', await pop.count() == 0)

        await pg.locator('.pane[data-tid=doc] .ph-origin [data-brlist]').click(); await frames(pg)
        rows = await pop.locator('[data-map]').evaluate_all('es=>es.map(e=>e.dataset.map)')
        dbr = await pg.evaluate("Object.values(__digress.conv.threads).find(t=>t.anchorMsg==='DOC').id")
        check('the document’s lists the main thread first (the other head), then only the document’s', rows == ['main', dbr], rows)
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Escape closes it', await pop.count() == 0)

        await pg.locator(f'.pane[data-tid="{mbr}"] .ph-origin [data-brlist]').click(); await frames(pg)
        await pop.locator(f'[data-map="{sub}"]').click(); await frames(pg)
        check('a row opens its branch and closes the list', await pop.count() == 0 and await pg.locator(f'.pane[data-tid="{sub}"]').count() == 1)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
