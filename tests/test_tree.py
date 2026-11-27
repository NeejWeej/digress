import asyncio, json
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app, booted, answered, saved, frames, new_conv
from common import CORS
MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
    'pdfjs-dist@4.10.38/build/pdf.min.mjs': ROOT + 'pdfjs-dist/build/pdf.min.mjs',
    'pdfjs-dist@4.10.38/build/pdf.worker.min.mjs': ROOT + 'pdfjs-dist/build/pdf.worker.min.mjs',
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
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain attention'); await answered(pg, ta.press('Enter'))
        SEL = """([sel, word]) => { const b=document.querySelector(sel); const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf(word); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+word.length); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }"""
        await pg.evaluate(SEL, ['.pane[data-tid=main] .msg.assistant .body','soft dictionary'])
        await pg.locator('#popIn').fill('Branch one'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await pg.evaluate(SEL, ['.pane:nth-of-type(2) .msg.assistant .body','scaling'])
        await pg.locator('#popIn').fill('Nested branch'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await pg.evaluate(SEL, ['.pane[data-tid=main] .msg.assistant .body','training'])
        await pg.locator('#popIn').fill('Branch two'); await answered(pg, pg.locator('#popIn').press('Enter'))
        tree = "[...document.querySelectorAll('#tree .mnode')].map(n=>n.querySelector('.mt').textContent+(n.querySelector('.hid')?' '+n.querySelector('.hid').textContent:''))"
        t_full = await pg.evaluate(tree)
        assert len(t_full) == 4, t_full
        await pg.locator('#tree .mnode', has_text='Branch one').locator('[data-tfold]').click(); await frames(pg)
        t_fold1 = await pg.evaluate(tree)
        assert len(t_fold1) == 3 and any('+1' in x for x in t_fold1), t_fold1
        await pg.locator('#treeAll').click(); await frames(pg)
        t_exp = await pg.evaluate(tree)
        assert len(t_exp) == 4, t_exp
        await pg.locator('#treeAll').click(); await frames(pg)
        t_col = await pg.evaluate(tree)
        assert len(t_col) < 4, t_col
        await pg.locator('#tree .mnode', has_text='Main thread').locator('[data-tfold]').click(); await frames(pg)
        await pg.screenshot(path=OUT + '/t0.png')
        t_main = await pg.evaluate(tree)
        assert len(t_main) == 1 and '+3' in t_main[0], t_main
        await saved(pg, layout=True)
        await new_conv(pg)
        await pg.locator('#clist .citem', has_text='Explain attention').click(); await pg.wait_for_function("__digress.conv.title==='Explain attention'")
        t_back = await pg.evaluate(tree)
        assert t_back == t_main, (t_back, t_main)
        await pg.screenshot(path=OUT + '/t1.png')
        assert not [e for e in errs if e.startswith('PAGEERR')], errs[:10]
        print('all passed')
        await b.close()
asyncio.run(main())
