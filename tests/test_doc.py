import asyncio, json
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app, booted, answered, drawn, frames, calm, PDF_DRAWN_JS, pdf_fitted
from common import CORS
MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'pdfjs-dist@4.10.38/build/pdf.min.mjs': ROOT + 'pdfjs-dist/build/pdf.min.mjs',
    'pdfjs-dist@4.10.38/build/pdf.worker.min.mjs': ROOT + 'pdfjs-dist/build/pdf.worker.min.mjs',
}
FAKE = r"""
window.__calls=[];
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{window.__calls.push(input);
    const REPLY='## Overview\n\nThe paper frames attention as a lookup [p. 1]. The key trick is scaling scores [p. 2], which helps training [p. 3].';
    let out='';for(const ch of REPLY.match(/[\s\S]{1,30}/g)){out+=ch;opts.onText&&opts.onText({text:out});await new Promise(r=>setTimeout(r,5))}
    return {text:out,truncated:false};};
  return null;}};
"""
def clean(x): return x
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        pg.on('console', lambda m: m.type == 'error' and errs.append('console ' + m.text))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        # 1. start from a PDF
        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
        print('panes:', await pg.evaluate("[...document.querySelectorAll('.pane')].map(p=>p.dataset.tid)"))
        print('doc header:', await pg.locator('.docpane .ph-origin').text_content())
        print('pages:', await pg.locator('.dpage').count(), 'rendered canvases:', await pg.locator('.dpage canvas').count(), 'text spans:', await pg.locator('.textLayer span').count())
        print('toast:', await pg.locator('#toast').text_content())
        # 2. ask in main thread
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Give me an overview'); await answered(pg, ta.press('Enter'))
        first = await pg.evaluate("window.__calls[0][0].content")
        last = await pg.evaluate("window.__calls[0].slice(-1)[0].content")
        print('main ctx has <document>:', '<document>' in first, '| has [p. 2] text:', '[p. 2]' in first, '| page note:', 'currently looking at p. 1' in last)
        print('page links:', await pg.locator('.pane[data-tid=main] a.pref').count())
        await pg.locator('.pane[data-tid=main] a.pref').nth(1).click(); await pg.locator('.dpage.flash').wait_for()
        flashed = await pg.locator('.dpage.flash').get_attribute('data-page')
        await calm(pg)
        print('after link: page flash', flashed, 'header', await pg.locator('.docpane .ph-origin').text_content())
        # 3. highlight in page 2 and branch
        ok = await pg.evaluate("""() => { const tl=document.querySelector('.dpage[data-page="2"] .textLayer'); if(!tl) return 'no text layer';
            const w=document.createTreeWalker(tl,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){ const i=n.nodeValue.indexOf('square root'); if(i>=0){
              const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+'square root of the key dimension'.length); const s=getSelection(); s.removeAllRanges(); s.addRange(r);
              document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); return 'selected'; } } return 'text not found'; }""")
        print('select:', ok); await pg.locator('#pop.show').wait_for()
        print('popup:', await pg.locator('#pop.show').count())
        await pg.locator('#popIn').fill('Why the square root?'); await answered(pg, pg.locator('#popIn').press('Enter')); await pdf_fitted(pg); await calm(pg)
        print('panes:', await pg.evaluate("[...document.querySelectorAll('.pane')].map(p=>p.dataset.tid.slice(0,4))"))
        print('page-2 anchor:', await pg.evaluate("[...document.querySelectorAll('.dpage[data-page=\"2\"] .anchor')].map(a=>a.textContent).join('|')"), '| margin marker:', await pg.locator('.dpage[data-page="2"] > sup.fn').count())
        bctx = await pg.evaluate("window.__calls.slice(-1)[0]")
        print('branch ctx: msgs', len(bctx), '| prefix ok:', 'from the document (p. 2)' in bctx[-1]['content'], '| includes main chat:', any('Give me an overview' in m['content'] for m in bctx))
        print('origin card:', (await pg.locator('.pane').nth(2).locator('.origin .ol span').text_content()))
        print('wires:', await pg.locator('#wires path').count())
        await pg.screenshot(path=OUT + '/d1.png')
        # 4. show in source
        await pg.locator('.docpane .pb').evaluate('e=>e.scrollTop=0'); await calm(pg)
        await pg.locator('.pane').nth(2).locator('.origin button[data-back]').click(); await calm(pg)
        print('show in source -> anchor flashing:', await pg.locator('.dpage .anchor.flash').count(), '| return button:', await pg.locator('.docpane.hasprev').count())
        # 5. sidebar + canvas
        print('tree:', await pg.evaluate("[...document.querySelectorAll('#tree .mnode')].map(n=>n.textContent.trim().slice(0,30))"))
        await pg.locator('[data-v=canvas]').click(); await pg.locator('.cnode.docnode').wait_for(); await calm(pg)
        print('canvas cards:', await pg.evaluate("[...document.querySelectorAll('.cnode')].map(n=>n.dataset.ctid.slice(0,4))"), 'edges:', await pg.locator('#edges path').count())
        await pg.wait_for_selector('.cnode.docnode .cthumb img', timeout=5000)
        th = await pg.locator('.cnode.docnode .cthumb img').evaluate("i=>[i.complete, i.naturalWidth, i.src.slice(0,5), i.closest('.cthumb').offsetHeight]")
        print('pdf preview on the document card (loaded, width, src, box height):', th)
        assert th[0] and th[1] >= 600 and th[2] == 'blob:' and th[3] == 170, f'PDF card shows a first-page preview {th}'
        h0 = await pg.locator('.cnode.docnode').evaluate('e=>e.offsetHeight')
        await pg.locator('[data-v=cols]').click(); await calm(pg); await pg.locator('[data-v=canvas]').click(); await calm(pg)
        same = await pg.evaluate("(()=>{const i=document.querySelector('.cnode.docnode .cthumb img');return !!i})()")
        h1 = await pg.locator('.cnode.docnode').evaluate('e=>e.offsetHeight')
        assert same and h0 == h1, f'preview reused when the canvas is drawn again, card height stable {h0} {h1}'
        await pg.locator('.cnode.docnode .cthumb').click(); await calm(pg)
        print('clicking the preview opens the document pane:', await pg.locator('.pane[data-tid=doc]').count())
        await pg.locator('[data-v=canvas]').click(); await calm(pg)
        await pg.screenshot(path=OUT + '/d2.png')
        await pg.locator('[data-v=cols]').click(); await calm(pg)
        # 6. resolve + delete the doc branch
        await pg.locator('.pane').nth(2).locator('.ph .sdot').click(); await frames(pg)
        print('resolved marker in pdf:', await pg.locator('.dpage > sup.fn.res').count())
        await pg.locator('.pane').nth(2).locator('.ph [data-delb]').click(); await pg.locator('#mOk').click(); await pg.wait_for_function("document.querySelectorAll('.pane').length===2"); await pdf_fitted(pg); await calm(pg)
        print('after delete: markers', await pg.locator('.dpage > sup.fn').count(), 'anchors', await pg.locator('.dpage .anchor').count(), 'panes', await pg.locator('.pane').count())
        # 7. pasted text document
        await pg.locator('#newDoc').click()
        await pg.locator('#docPaste').fill('# Notes on Raft\n\nRaft elects a **leader** that replicates the log to followers.\n\nA term is a logical clock: $t+1$ follows $t$.')
        await pg.locator('#docGo').click(); await pg.wait_for_function("__digress.conv.doc&&__digress.conv.doc.kind==='text'&&(document.querySelector('.docbody')||{}).textContent?.includes('Raft')"); await drawn(pg)
        print('text doc body:', (await pg.locator('.docbody').inner_text())[:40].replace('\n',' / '))
        await pg.evaluate("""() => { const b=document.querySelector('.docbody'); const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf('replicates the log'); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+18); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await answered(pg, pg.locator('#popChips .chip').first.click()); await calm(pg)
        print('text doc: anchor', await pg.locator('.docbody .anchor').count(), 'inline marker', await pg.locator('.docbody sup.fn').count(), 'panes', await pg.evaluate("[...document.querySelectorAll('.pane')].map(p=>p.dataset.tid.slice(0,4))"))
        tctx = await pg.evaluate("window.__calls.slice(-1)[0][0].content")
        print('text doc ctx has document:', 'Notes on Raft' in tctx)
        # 8. switching back to the PDF conversation reloads it (from memory in this test)
        await pg.locator('.citem').nth(1).click(); await pg.wait_for_function("__digress.conv.doc&&__digress.conv.doc.kind==='pdf'"); await pg.wait_for_function(PDF_DRAWN_JS)
        assert await pg.locator('.dpage').count() == 3 and await pg.locator('.docerr').count() == 0
        await pg.screenshot(path=OUT + '/d3.png')
        assert not [e for e in errs if e.startswith('PAGEERR')], errs[:10]
        print('all passed')
        await b.close()
asyncio.run(main())
