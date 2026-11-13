import asyncio, json
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app
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
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg); await pg.wait_for_timeout(1500)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain attention'); await ta.press('Enter'); await pg.wait_for_timeout(1800)
        SEL = """([sel, word]) => { const b=document.querySelector(sel); const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf(word); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+word.length); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }"""
        await pg.evaluate(SEL, ['.pane[data-tid=main] .msg.assistant .body','soft dictionary']); await pg.wait_for_timeout(150)
        await pg.locator('#popIn').fill('Branch one'); await pg.locator('#popIn').press('Enter'); await pg.wait_for_timeout(1800)
        await pg.evaluate(SEL, ['.pane:nth-of-type(2) .msg.assistant .body','scaling']); await pg.wait_for_timeout(150)
        await pg.locator('#popIn').fill('Nested branch'); await pg.locator('#popIn').press('Enter'); await pg.wait_for_timeout(1800)
        await pg.evaluate(SEL, ['.pane[data-tid=main] .msg.assistant .body','training']); await pg.wait_for_timeout(150)
        await pg.locator('#popIn').fill('Branch two'); await pg.locator('#popIn').press('Enter'); await pg.wait_for_timeout(1800)
        tree = "[...document.querySelectorAll('#tree .mnode')].map(n=>n.querySelector('.mt').textContent+(n.querySelector('.hid')?' '+n.querySelector('.hid').textContent:''))"
        print('full tree:', await pg.evaluate(tree))
        await pg.locator('#tree .mnode', has_text='Branch one').locator('[data-tfold]').click(); await pg.wait_for_timeout(200)
        print('fold Branch one:', await pg.evaluate(tree))
        await pg.locator('#treeAll').click(); await pg.wait_for_timeout(200)
        print('button now:', await pg.locator('#treeAll').text_content(), '| after Expand all:', await pg.evaluate(tree))
        await pg.locator('#treeAll').click(); await pg.wait_for_timeout(200)
        print('after Collapse all:', await pg.evaluate(tree))
        await pg.locator('#tree .mnode', has_text='Main thread').locator('[data-tfold]').click(); await pg.wait_for_timeout(200)
        await pg.screenshot(path=OUT + '/t0.png')
        print('fold main too:', await pg.evaluate(tree))
        await pg.wait_for_timeout(900)
        await pg.locator('#newConv').click(); await pg.wait_for_timeout(300)
        await pg.locator('#clist .citem', has_text='Explain attention').click(); await pg.wait_for_timeout(1000)
        print('remembered after switching back:', await pg.evaluate(tree))
        await pg.screenshot(path=OUT + '/t1.png')
        print('\n'.join(errs[:15]) or 'no errors')
        await b.close()
asyncio.run(main())
