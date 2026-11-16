import asyncio, json
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app, booted, answered, saved, frames, calm, steady, changed, new_conv
from common import CORS

RES = "document.getElementById('palRes').innerHTML"
INDEXED = "(()=>{const id=__digress.conv.id;return !!localStorage.getItem('fakesrv:index/'+id)})()"   # the open conversation's search entries are written


async def search(pg, q):   # type into the palette and wait for its results to settle
    await changed(pg, RES, pg.locator('#palIn').fill(q)); await steady(pg, RES)
MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
FAKE = r"""
window.__calls=[];
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{window.__calls.push(input);
    const REPLY=(input[input.length-1].content.includes('Second')?'A reply about distributed consensus and leader election.':'## Overview\n\nThe paper frames attention as a soft dictionary lookup [p. 1]. The key trick is scaling scores [p. 2], which helps training [p. 3].');
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
        old = json.loads(open(FIX + '/conv.json').read()); old['id']='cOLD'; old['title']='Fourier notes'; old['updated']=5
        old['msgs']['a1']['content'] += '\n\nThis is the Fourier transform view of signals.'
        await pg.add_init_script("localStorage.setItem('fakesrv:convs/cOLD',"+json.dumps(json.dumps(old))+")")
        await goto_app(pg); await booted(pg)
        await new_conv(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain attention'); await answered(pg, ta.press('Enter'))
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body'); const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf('soft dictionary lookup'); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+22); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#popIn').fill('Why a lookup?'); await answered(pg, pg.locator('#popIn').press('Enter')); await saved(pg); await pg.wait_for_function(INDEXED)
        await new_conv(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Second topic: Raft'); await answered(pg, ta.press('Enter')); await saved(pg); await pg.wait_for_function(INDEXED)
        print('index entries written:', await pg.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:index/')).length"))
        await pg.keyboard.press('Control+k'); await pg.locator('#pal.show #palRes .pr').first.wait_for()
        print('palette open:', await pg.locator('#pal.show').count(), '| recent:', await pg.evaluate("[...document.querySelectorAll('#palRes .pr .ps')].map(e=>e.textContent)"))
        await pg.wait_for_function("!!localStorage.getItem('fakesrv:index/cOLD')&&!document.getElementById('palFoot').textContent")   # the older conversation got indexed
        print('index after backfill:', await pg.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:index/')).length"))
        await search(pg, 'dictonary')
        res = await pg.evaluate("[...document.querySelectorAll('#palRes .pgrp, #palRes .pr')].map(e=>e.classList.contains('pgrp')?'## '+e.textContent:(e.querySelector('.pk').textContent+': '+e.querySelector('.ps').innerHTML.slice(0,80)))")
        print('results for typo "dictonary":'); [print('   ',r) for r in res]
        await pg.screenshot(path=OUT + '/s1.png')
        idx = await pg.evaluate("[...document.querySelectorAll('#palRes .pr')].findIndex(e=>e.querySelector('.pk').textContent==='Highlight')")
        for _ in range(max(0,idx)): await pg.keyboard.press('ArrowDown')
        await pg.keyboard.press('Enter'); await pg.wait_for_function("!document.querySelector('#pal.show')&&__digress.conv.title==='Explain attention'&&document.querySelectorAll('.pane').length===2"); await calm(pg)
        print('after Enter: palette closed', await pg.locator('#pal.show').count()==0, '| conversation', await pg.locator('#cTitle').text_content(), '| flashing highlight', await pg.locator('.anchor.flash').count(), '| panes', await pg.evaluate("[...document.querySelectorAll('.pane .ph-title')].map(t=>t.textContent)"))
        await pg.locator('#sboxIn').click(); await pg.locator('#pal.show').wait_for()
        print('sidebar search bar opens palette:', await pg.locator('#pal.show').count())
        await search(pg, 'fourier')
        print('"fourier" groups:', await pg.evaluate("[...document.querySelectorAll('#palRes .pgrp')].map(e=>e.textContent)"))
        await pg.keyboard.press('Control+Enter'); await pg.wait_for_function("__digress.conv.id==='cOLD'"); await calm(pg)
        print('ctrl+enter: palette still open', await pg.locator('#pal.show').count(), '| conversation now', await pg.locator('#cTitle').text_content())
        await pg.keyboard.press('Escape'); await pg.locator('#pal').wait_for(state='hidden')
        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', FIX + '/paper.pdf'); await pg.locator('#docGo').click()
        # the document's text is read (its header says "Page 1 of 3"), and it's saved
        await pg.wait_for_function(r"(()=>{const o=document.querySelector('.pane[data-tid=doc] .ph-origin');return __digress.conv.doc&&o&&/Page \d+ of \d+/.test(o.textContent)})()"); await saved(pg)
        await new_conv(pg)
        await pg.keyboard.press('Control+k'); await pg.locator('#pal.show').wait_for(); await pg.wait_for_function("!document.getElementById('palFoot').textContent")
        await search(pg, 'saturating')
        print('"saturating":', await pg.evaluate("[...document.querySelectorAll('#palRes .pr')].map(e=>e.querySelector('.pk').textContent+' | '+e.querySelector('.ps').textContent.slice(0,50))"))
        await pg.keyboard.press('Enter'); await pg.locator('.dpage.flash').wait_for(); await calm(pg)
        print('opened doc at page:', await pg.locator('.docpane .ph-origin').text_content(), '| page flash', await pg.locator('.dpage.flash').get_attribute('data-page'))
        await pg.screenshot(path=OUT + '/s2.png')
        print('\n'.join(errs[:15]) or 'no errors')
        await b.close()
asyncio.run(main())
