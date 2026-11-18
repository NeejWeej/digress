"""Starting over in a document conversation, and Retry on a reply the conversation went on from.
  - Start over (main's header, document conversations only) empties main; what was in it becomes another version
    from the start of main (under Branches), taking its branches with it. The document stays. Undo puts it back.
    The next question starts from just the document and names the conversation again; the versions switcher on
    it offers the earlier one.
  - New conversation from this document: a fresh conversation on the same stored file; the old one is unchanged.
  - Retry (a reply that ended in an error) and Continue never replace a reply something came after: Retry asks
    again as another version, and Continue isn't offered.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, OUT, launch_args, goto_app, booted, answered, saved, frames, PDF_DRAWN_JS
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
  window.__ctx=input;
  const out='The paper argues that attention alone is enough. The weights come from a softmax over scores.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

C = "__digress.conv"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        restart = pg.locator('.pane[data-tid=main] .ph [data-act=restart]')
        await new_chat_check(pg, restart)
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
        check('no Start over while main is empty', not await restart.is_visible())
        ta = pg.locator('.pane[data-tid=main] textarea')
        await ta.fill('What does it argue?'); await answered(pg, ta.press('Enter'))
        await ta.fill('And the weights?'); await answered(pg, ta.press('Enter'))
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body');
          const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){const i=n.nodeValue.indexOf('softmax'); if(i>=0){
          const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+7); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#popIn').fill('Why a softmax?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        bt = await pg.evaluate(f"Object.keys({C}.threads).find(t=>t!=='main')")
        old = await pg.evaluate(f"[...{C}.order.main]")
        title = await pg.evaluate(f"{C}.title")

        # Retry on a reply the conversation went on from: another version, nothing replaced
        await pg.evaluate(f"(()=>{{const c={C},m=c.msgs[c.order.main[1]];m.error='Cut off before it finished: dropped';m.cut=true;m.ver++;__digress.refresh()}})()")
        r1 = pg.locator(f'.pane[data-tid=main] .msg[data-mid="{old[1]}"]')
        await pg.wait_for_function(f"!!document.querySelector('.pane[data-tid=main] .msg[data-mid=\"{old[1]}\"] [data-act=retry]')", timeout=5000)
        check('Continue isn’t offered on a cut reply the conversation went on from', await r1.locator('[data-act=continue]').count() == 0)
        tip = await r1.locator('[data-act=retry]').get_attribute('title') or await r1.locator('[data-act=retry]').get_attribute('data-tip')
        check('…and Retry says it asks as another version', 'another version' in (tip or ''), tip)
        n0 = await pg.evaluate(f"Object.keys({C}.threads).length")
        await answered(pg, r1.locator('[data-act=retry]').click())
        check('Retry made another version and left main as it was', await pg.evaluate(f"[...{C}.order.main]") == old and await pg.evaluate(f"Object.values({C}.threads).filter(t=>t.alt).length") == 1 and await pg.evaluate(f"Object.keys({C}.threads).length") == n0 + 1)
        check('…and the errored reply’s text is untouched', await pg.evaluate(f"{C}.msgs['{old[1]}'].error") is not None)
        await pg.evaluate(f"(()=>{{const c={C},m=c.msgs[c.order.main[1]];delete m.error;delete m.cut;m.ver++;__digress.refresh()}})()")
        alt1 = await pg.evaluate(f"Object.values({C}.threads).find(t=>t.alt).id")

        # Start over
        check('Start over shows in a document conversation with messages in main', await restart.is_visible())
        await restart.click(); await frames(pg)
        main_now = await pg.evaluate(f"[...{C}.order.main]")
        v = await pg.evaluate(f"Object.values({C}.threads).find(t=>t.alt&&t.parent==='main'&&t.anchorMsg==='START'&&t.id!=='{alt1}')")
        check('main is empty', main_now == [], main_now)
        check('…what was in it is another version from main’s start', v and await pg.evaluate(f"[...{C}.order['{v['id']}']]") == old if v else False, v)
        check('…the branch went with it (the Retry version, from main’s start too, stays a version of it)', await pg.evaluate(f"[{C}.threads['{bt}'].parent,{C}.threads['{alt1}'].parent]") == [v['id'], 'main'])
        check('…the shape is valid', await pg.evaluate(f"ThreadOps.check({C})") == [])
        check('…the document pane stays', 'doc' in await pg.evaluate(f"[...{C}.ui.open]"))
        await pg.screenshot(path=OUT + '/start_over.png')
        await pg.locator('#toast .tact').click(); await frames(pg)
        check('Undo puts main back', await pg.evaluate(f"[...{C}.order.main]") == old and await pg.evaluate(f"!{C}.threads['{v['id']}']") and await pg.evaluate(f"{C}.threads['{bt}'].parent") == 'main')
        check('…and the title', await pg.evaluate(f"{C}.title") == title)

        await restart.click(); await frames(pg)
        v = await pg.evaluate(f"Object.values({C}.threads).find(t=>t.alt&&t.parent==='main'&&t.anchorMsg==='START'&&{C}.order[t.id].length===4)")
        await ta.fill('Start fresh: what is the method?'); await answered(pg, ta.press('Enter'))
        ctx = await pg.evaluate("JSON.stringify(window.__ctx.messages||window.__ctx)")
        check('the next question starts from just the document', 'What does it argue?' not in ctx and 'Start fresh' in ctx)
        kept = await pg.evaluate(f"{C}.titleKept")
        check('…and names the conversation again (unless its title was kept)', kept or await pg.evaluate(f"{C}.title") == 'Start fresh: what is the method?', await pg.evaluate(f"{C}.title"))
        check('…and the earlier main thread is one of its versions', await pg.evaluate(f"ThreadOps.versionsAt({C},{C}.order.main[0]).includes('{v['id']}')"))
        await saved(pg)

        # New conversation from this document
        cid, asset = await pg.evaluate(f"[{C}.id,{C}.doc.assetId]")
        await pg.locator('.pane[data-tid=doc] .ph [data-act=newfromdoc]').click()
        await pg.wait_for_function(PDF_DRAWN_JS); await saved(pg)
        nid, nasset, nmain = await pg.evaluate(f"[{C}.id,{C}.doc.assetId,{C}.order.main.length]")
        check('New conversation from this document: a new conversation, the same file, nothing in it', nid != cid and nasset == asset and nmain == 0, [nid, cid, nasset, asset])
        check('…the old one is still there, unchanged', await pg.evaluate(f"(async()=>{{const d=JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith('convs/{cid}'))));return d.order.main.length}})()") == 2)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

async def new_chat_check(pg, restart):
    check('no Start over in a conversation without a document', await restart.count() == 0 or not await restart.is_visible())

asyncio.run(main())
