"""Each pane's header counts the branches off it (and off those), as the sidebar's tree groups them.
  - In a document conversation, the document's header counts the document's branches and main's counts main's,
    so one branch isn't counted twice.
  - A branch with branches of its own says how many at the end of its header line; one without says nothing.
  - Hiding a branch takes it out of the count, as it does from the tree.
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
        # a branch off the document (a whole-page question), with one question in it
        await pg.locator('.pane[data-tid=doc] .dpage').first.hover(); await pg.locator('.pane[data-tid=doc] [data-pask="1"]').click()
        await pg.locator('#popIn').fill('What is on this page?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await pg.wait_for_timeout(300)
        check('(set up: one branch off the document)', 'branch' in await origin(pg, 'doc'), await origin(pg, 'doc'))
        check('the document’s header counts it', '1 branch' in await origin(pg, 'doc'), await origin(pg, 'doc'))
        check('…and main’s doesn’t (no branch off main)', await origin(pg, 'main') == '0 branches', await origin(pg, 'main'))

        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What does it argue?'); await answered(pg, ta.press('Enter'))
        await pg.evaluate(SELECT.replace('.pane .msg', '.pane[data-tid=main] .msg'), 'softmax')
        await pg.locator('#popIn').fill('Why a softmax?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        mbr = await pg.evaluate("Object.values(__digress.conv.threads).find(t=>t.parent==='main'&&t.anchorMsg!=='DOC').id")
        check('a branch off main: main says 1, the document still 1', await origin(pg, 'main') == '1 branch' and '1 branch' in await origin(pg, 'doc'), [await origin(pg, 'main'), await origin(pg, 'doc')])
        check('a branch with none of its own says nothing about branches', 'branch' not in (await origin(pg, mbr)).replace('Branched', ''), await origin(pg, mbr))

        await pg.evaluate(SELECT.replace('.pane .msg', f'.pane[data-tid="{mbr}"] .msg'), 'attention')
        await pg.locator('#popIn').fill('What is attention?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await pg.wait_for_timeout(300)
        check('a sub-branch: its branch says “· 1 branch”', (await origin(pg, mbr)).endswith('· 1 branch'), await origin(pg, mbr))
        check('…and main counts both levels', await origin(pg, 'main') == '2 branches', await origin(pg, 'main'))
        await pg.screenshot(path=OUT + '/branch_counts.png')

        await pg.evaluate(f"(()=>{{__digress.conv.threads['{mbr}'].hidden=true;__digress.refresh()}})()"); await frames(pg)
        check('hiding a branch takes it (and what’s under it) out of the count', await origin(pg, 'main') == '0 branches', await origin(pg, 'main'))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
