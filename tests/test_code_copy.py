"""A copy button on code blocks in replies.
  - Each code block (any language, or none) has a copy button; a diagram doesn't.
  - Clicking it copies just the code, with no selection and no branch popup.
  - The button adds no text: the reply's text (what anchors count) is the same as without it.
  - It works in a canvas card too.
Asserts and exits non-zero."""
import asyncio, json, os, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames, settle, calm
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
}
CODE1 = 'def f(x):\n    return x * 2  # a long line ' + 'x' * 200
CODE2 = 'plain text block\nsecond line'
REPLY = 'Here it is.\n\n```python\n' + CODE1 + '\n```\n\nAnd as text:\n\n```\n' + CODE2 + '\n```\n\nDone.'
FAKE = ("window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const out=%s;opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"
        "window.__copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:t=>{window.__copied.push(t);return Promise.resolve()}},configurable:true});") % json.dumps(REPLY)
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Show me code'); await answered(pg, ta.press('Enter'))
        body = '.pane[data-tid=main] .msg.assistant .body'
        await pg.wait_for_function(f"document.querySelectorAll('{body} .cbx .cpy').length===2", timeout=15000)
        txt = await pg.evaluate(f"""() => {{ const b=document.querySelector('{body}');
          return [...b.querySelectorAll('.cpy')].map(x=>x.textContent).join('') }}""")
        check('the buttons hold no text', txt == '', txt)
        btns = pg.locator(f'{body} .cbx .cpy')
        await pg.locator(f'{body} .cbx').first.hover(); await btns.first.click(); await frames(pg)
        await btns.nth(1).hover(); await btns.nth(1).click(); await frames(pg)
        got = await pg.evaluate('window.__copied')
        check('copies exactly the code', got == [CODE1, CODE2], got)
        st = await pg.evaluate("""() => ({sel:String(getSelection()), pop:getComputedStyle(document.getElementById('pop')).display, done:document.querySelectorAll('.cpy.done').length})""")
        check('no selection, no branch popup', st['sel'] == '' and st['pop'] == 'none', st)
        check('the button shows it copied', st['done'] >= 1, st)
        r = await pg.evaluate("""() => { const p=document.querySelector('.pane[data-tid=main] .cbx pre'), b=p.parentElement.querySelector('.cpy');
          p.scrollLeft=9999; const pr=p.getBoundingClientRect(), br=b.getBoundingClientRect(); return {inside: br.right<=pr.right+1 && br.left>=pr.left && br.top>=pr.top} }""")
        check('the button stays in the corner when the code scrolls sideways', r['inside'], r)
        await pg.screenshot(path=os.path.join(OUT, 'code_copy.png'))

        # the canvas
        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()")
        card = '#cv .cnode.main'
        await pg.locator(card).wait_for(); await calm(pg)
        if not await pg.locator(card + ' .cfull').count():
            await pg.evaluate(f"document.querySelector('{card} [data-cact=exp]').click()"); await pg.locator(card + ' .cfull').wait_for()
        await frames(pg)
        before = len(await pg.evaluate('window.__copied'))
        cb = pg.locator(card + ' .cfull .cbx .cpy')
        await cb.first.wait_for(timeout=10000)
        await cb.first.scroll_into_view_if_needed(); await cb.first.hover(); await cb.first.click(); await frames(pg)
        got = await pg.evaluate('window.__copied')
        check('copies from a canvas card', len(got) == before + 1 and got[-1] == CODE1, got)
        st = await pg.evaluate("() => ({sel:String(getSelection()), pop:getComputedStyle(document.getElementById('pop')).display})")
        check('…with nothing selected and no branch popup', st['sel'] == '' and st['pop'] == 'none', st)
        check('no page errors', not errs, errs)
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
