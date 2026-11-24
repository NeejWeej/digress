"""A copy button on code blocks in replies.
  - Each code block (any language, or none) has a copy button; a diagram doesn't.
  - Clicking it copies just the code, with no selection and no branch popup.
  - The button adds no text: the reply's text (what anchors count) is the same as without it.
  - It works in a canvas card too.
  - While a reply streams (redrawn many times a second): a finished block has a visible button, the block still being
    written (open fence) has none until it closes, a click copies exactly its code, "Copied" survives redraws.
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
HEAD = 'Here it is.\n\n```python\n' + CODE1 + '\n```\n\nAnd as text:\n\n'
# streams slowly, redrawing every 10 ms (the fake page server only takes text that extends what it sent), and holds at
# each phase until the test moves window.__phase on: 1 prose after block one, 2 block two open, 3 it closed, 4 done
STREAM = r"""window.__phase=1;window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const H=%s; let k=0, out=H, last=0, code2='plain text block\nsecond line';
  const put=(t)=>{out+=t;opts.onText&&opts.onText({text:out})}, tick=()=>new Promise(r=>setTimeout(r,10));
  while(window.__phase<4){
    const ph=window.__phase; k++;
    if(ph===1) put('more '); 
    else if(ph===2){ if(last<2){put('\n\n```\n'+code2); last=2} else {put('\nmore '+k); code2+='\nmore '+k} }
    else { if(last<3){put('\n```\n\nAfter it '); last=3; window.__code2=code2} else put('and ') }
    await tick();
  }
  put('Done.'); return {text:out,truncated:false}}};""" % json.dumps(HEAD)
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
        await pg.add_init_script(STREAM)
        await goto_app(pg); await booted(pg)
        body = '.pane[data-tid=main] .msg.assistant .body'
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Show me code'); await ta.press('Enter')
        # --- while it streams
        blocks = f"{body} .cbx"
        await pg.wait_for_function(f"document.querySelectorAll('{blocks} .cpy').length===1 && document.querySelector('{blocks}[data-live]')", timeout=15000)
        await pg.evaluate("""(sel) => { window.__redraws = 0; new MutationObserver(m => { window.__redraws += m.length }).observe(document.querySelector(sel), {childList:true}) }""", body)
        async def redraws(n):
            start = await pg.evaluate('window.__redraws')
            await pg.wait_for_function(f'window.__redraws >= {start + n}', timeout=10000)
        await redraws(3)
        vis = await pg.evaluate(f"""() => {{ const b=document.querySelector('{blocks} .cpy'); const r=b.getBoundingClientRect(), o=+getComputedStyle(b).opacity;
          return {{w:r.width, h:r.height, o, n:document.querySelectorAll('{blocks}').length}} }}""")
        check('streaming: the finished block has a visible button', vis['w'] > 0 and vis['h'] > 0 and vis['o'] > 0, vis)
        # phase 2: the second block's fence is open
        await pg.evaluate('window.__phase=2')
        await pg.wait_for_function(f"document.querySelectorAll('{blocks}').length===2", timeout=10000)
        await redraws(3)
        st = await pg.evaluate(f"() => [...document.querySelectorAll('{blocks}')].map(b => !!b.querySelector('.cpy'))")
        check('streaming: the block still being written has no button, the first has one', st == [True, False], st)
        # click the first block's button while redraws go on
        async def center():
            return await pg.evaluate(f"""() => {{ const b=document.querySelector('{blocks} .cpy'); b.scrollIntoView({{block:'center'}}); const r=b.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2] }}""")
        x, y = await center()
        await pg.mouse.move(x, y); await redraws(2)
        x, y = await center()
        await pg.mouse.move(x, y); await pg.mouse.down(); await redraws(2); await pg.mouse.up()   # the button pressed has been replaced by the time of the release
        try:
            await pg.wait_for_function('window.__copied.length>=1', timeout=2000)
        except Exception:
            pass
        got = await pg.evaluate('window.__copied')
        check('streaming: a press held across redraws still copies exactly that block\'s code', got == [CODE1], got)
        if not got:   # carry on with a quick click, to check the rest
            x, y = await center(); await pg.mouse.click(x, y)
            await pg.wait_for_function('window.__copied.length>=1', timeout=5000)
            got = await pg.evaluate('window.__copied')
            check('streaming: a quick click copies exactly that block\'s code', got == [CODE1], got)
        await redraws(3)
        d = await pg.evaluate(f"() => document.querySelectorAll('{blocks} .cpy.done').length")
        check('streaming: "Copied" shows across redraws', d == 1, d)
        st = await pg.evaluate("() => ({sel:String(getSelection()), pop:getComputedStyle(document.getElementById('pop')).display})")
        check('streaming: no selection, no branch popup', st['sel'] == '' and st['pop'] == 'none', st)
        # phase 3: the fence closes
        await pg.evaluate('window.__phase=3')
        await pg.wait_for_function(f"document.querySelectorAll('{blocks} .cpy').length===2", timeout=10000)
        code2 = await pg.evaluate('window.__code2')
        check('streaming: once its fence closes the second block gets a button', True)
        await redraws(2)
        await pg.evaluate('window.__phase=4')
        await pg.wait_for_function(f"!document.querySelector('{blocks}[data-live]') && document.querySelectorAll('{blocks} .cpy').length===2", timeout=15000)
        await pg.evaluate('window.__copied.length=0')
        await pg.wait_for_function("!document.querySelector('.cpy.done')", timeout=5000)
        await pg.wait_for_function(f"document.querySelectorAll('{body} .cbx .cpy').length===2", timeout=15000)
        txt = await pg.evaluate(f"""() => {{ const b=document.querySelector('{body}');
          return [...b.querySelectorAll('.cpy')].map(x=>x.textContent).join('') }}""")
        check('the buttons hold no text', txt == '', txt)
        btns = pg.locator(f'{body} .cbx .cpy')
        await pg.locator(f'{body} .cbx').first.hover(); await btns.first.click(); await frames(pg)
        await btns.nth(1).hover(); await btns.nth(1).click(); await frames(pg)
        got = await pg.evaluate('window.__copied')
        check('copies exactly the code', got == [CODE1, code2], got)
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
