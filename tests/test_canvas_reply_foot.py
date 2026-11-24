"""An expanded canvas card's replies have the same line under them as a pane's (buildFoot), and the buttons work.
  - each reply: one .mfoot with Side question, Copy and Redo, the model label and the context label; a summary card has none
  - Side question in a card opens a new expanded card whose .cask textarea has the focus
  - Redo in a card makes a version card (alt thread); Retry on a failed reply, Continue on a cut one
  - the failed reply's error text shows in the card
  - Copy copies the reply's Markdown (clipboard stubbed); with no clipboard API it uses execCommand('copy') and still says Copied,
    for a reply's Copy and a code block's copy button
  - Columns: Copy and Side question in a pane still work (the pane's click switch goes through replyAct)
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import OUT, launch_args, goto_app, booted, settle, soon

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

A0 = 'First answer.\n\n```python\nprint("hi")\n```\n\nDone with **it**.'
def seed(a1, view):
    return r"""
const now=Date.now(), A1=%s;
const msgs={u0:{id:'u0',role:'user',thread:'main',content:'First question',ts:now},
  a0:{id:'a0',role:'assistant',thread:'main',content:%s,ts:now,model:'sample',usage:{ctx:52000,cached:0,out:100,rounds:1,window:1000000}},
  u1:{id:'u1',role:'user',thread:'main',content:'Second question',ts:now},
  a1:Object.assign({id:'a1',role:'assistant',thread:'main',ts:now},A1)};
localStorage.setItem('fakesrv:convs/cf',JSON.stringify({id:'cf',title:'Foot',created:now,updated:now,rev:1,
  threads:{main:{id:'main',parent:null,title:'Main thread',colorIdx:-1}},msgs,order:{main:['u0','a0','u1','a1']},nextColor:0}));
localStorage.setItem('fakesrv:layout/cf',JSON.stringify({devices:{other:{at:now,ui:{open:['main'],collapsed:[],layout:'cols',view:'%s',sizes:{}}}}}));
""" % (a1, json.dumps(A0), view)

LLM = "window.fakeLLM={use:async()=>async(input,opts)=>{const t='regenerated text';opts&&opts.onText&&opts.onText({text:t});return {text:t,truncated:false}}};"
STUB = ("window.__copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:t=>{window.__copied.push(t);return Promise.resolve()}},configurable:true});")
NOCLIP = ("Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});window.__exec=[];"
          "const _e=document.execCommand.bind(document);document.execCommand=function(c){let r;try{r=_e.apply(document,arguments)}catch(e){r='threw '+e}window.__exec.push([c,r]);return r};")
OK1 = "{role:'assistant',content:'Second answer.',model:'sample'}"
CARD = '#cv .cnode[data-ctid=main]'

async def opened(b, a1=OK1, view='canvas', init='', w=1300):
    pg = await b.new_page(viewport={'width': w, 'height': 900})
    pg.on('pageerror', lambda e: fails.append('pageerror ' + str(e)[:200]))
    await pg.add_init_script("if(!sessionStorage.getItem('s')){sessionStorage.setItem('s','1');" + seed(a1, view) + "}" + LLM + init)
    await goto_app(pg); await booted(pg)
    if view == 'canvas':
        await pg.wait_for_selector(CARD + ' .crs'); await settle(pg, 200)
    else:
        await pg.wait_for_selector('.pane[data-tid=main] .msg.assistant'); await settle(pg, 200)
    return pg

async def expand(pg):
    await pg.evaluate(f"document.querySelector('{CARD} [data-cact=exp]').click()")
    await pg.wait_for_selector(CARD + ' .cfull .msg.assistant'); await settle(pg, 300)

async def click(pg, sel):   # the camera moves when a card opens, so click through the page
    await pg.evaluate("s => { const e = document.querySelector(s); if (!e) throw new Error('no ' + s); e.click() }", sel)

def foot(mid, extra=''): return f"{CARD} .msg[data-mid={mid}] .mfoot{extra}"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())

        # --- the footer
        pg = await opened(b)
        check('a summary card has no .mfoot', await pg.locator(CARD + ' .mfoot').count() == 0)
        await expand(pg)
        for mid in ('a0', 'a1'):
            n = await pg.locator(f"{CARD} .msg[data-mid={mid}] .mfoot").count()
            btns = await pg.evaluate(f"""() => {{ const f = document.querySelector('{foot(mid)}'); return f ? ['wbranch','copy','redo'].map(a => !!f.querySelector('[data-act='+a+']')) : null }}""")
            check(f'{mid}: one .mfoot with Side question, Copy and Redo', n == 1 and btns == [True, True, True], (n, btns))
        txt = await pg.evaluate(f"document.querySelector('{foot('a0')}').textContent")
        check('a0: model label and context label show', 'sample' in txt.lower() and '52k' in txt and '1M' in txt, txt)
        await pg.screenshot(path=OUT + '/canvas_reply_foot.png')

        # --- Side question
        n0 = await pg.evaluate("document.querySelectorAll('#cv .cnode').length")
        await click(pg, foot('a1') + ' [data-act=wbranch]')
        ok = await soon(pg, f"n => document.querySelectorAll('#cv .cnode').length === n + 1", n0)
        check('Side question: a new card opens', ok)
        await settle(pg, 300)
        st = await pg.evaluate("""() => { const t = Object.values(__digress.conv.threads).find(t => t.id !== 'main'); if (!t) return null;
          const c = document.querySelector('#cv .cnode[data-ctid="' + t.id + '"]'); const ta = c && c.querySelector('.cask textarea');
          return {full: !!(c && c.querySelector('.cfull')), focus: !!ta && document.activeElement === ta} }""")
        check('the new card is expanded and its composer has the focus', bool(st) and st['full'] and st['focus'], st)
        await pg.close()

        # --- Redo makes a version card
        pg = await opened(b); await expand(pg)
        await click(pg, foot('a0') + ' [data-act=redo]')
        ok = await soon(pg, "Object.values(__digress.conv.threads).some(t => t.alt)")
        await settle(pg, 500)
        alt = await pg.evaluate("Object.values(__digress.conv.threads).filter(t => t.alt).map(t => t.id)")
        has = bool(alt) and await pg.evaluate("id => !!document.querySelector('#cv .cnode[data-ctid=\"' + id + '\"]')", alt[0])
        check('Redo: an alt thread (version) with its own card', ok and has, (alt, has))
        await pg.close()

        # --- Retry on a failed reply
        pg = await opened(b, "{role:'assistant',content:'',error:'Boom: the model fell over'}"); await expand(pg)
        e = await pg.evaluate(f"(document.querySelector('{CARD} .msg[data-mid=a1] .err')||{{}}).textContent")
        check('a failed reply shows its error text in the card', e and 'Boom' in e, e)
        check('...and a Retry button', await pg.locator(foot('a1') + ' [data-act=retry]').count() == 1)
        await click(pg, foot('a1') + ' [data-act=retry]')
        ok = await soon(pg, "Object.values(__digress.conv.msgs).filter(m => m.role === 'assistant' && m.content === 'regenerated text').length >= 1 && !Object.values(__digress.conv.msgs).some(m => m.pending)")
        check('Retry produces a reply', ok, await pg.evaluate("Object.values(__digress.conv.msgs).map(m => m.id + ':' + (m.content||'').slice(0,20) + (m.error ? ':ERR' : ''))"))
        await pg.close()

        # --- Continue on a cut reply
        pg = await opened(b, "{role:'assistant',content:'Partial answer so far',cut:true,error:'The connection dropped',model:'sample'}"); await expand(pg)
        check('a cut reply shows Continue', await pg.locator(foot('a1') + ' [data-act=continue]').count() == 1)
        await click(pg, foot('a1') + ' [data-act=continue]')
        ok = await soon(pg, "(() => { const ms = Object.values(__digress.conv.msgs); return !ms.some(m => m.pending) && ms.some(m => m.role === 'assistant' && /regenerated text/.test(m.content)) })()")
        c = await pg.evaluate("__digress.conv.msgs.a1 && {c: __digress.conv.msgs.a1.content, cut: __digress.conv.msgs.a1.cut}")
        check('Continue continues the reply', ok and 'Partial answer so far' in c['c'] and not c['cut'], c)
        await pg.close()

        # --- Copy with a stubbed clipboard
        pg = await opened(b, init=STUB); await expand(pg)
        await click(pg, foot('a0') + ' [data-act=copy]')
        ok = await soon(pg, "window.__copied.length === 1")
        got = await pg.evaluate("window.__copied")
        check('Copy in a card copies that reply\'s Markdown', ok and got == [A0], got)
        await pg.close()

        # --- Copy with no clipboard API (plain http)
        pg = await opened(b, init=NOCLIP); await expand(pg)
        check('navigator.clipboard is gone', await pg.evaluate("navigator.clipboard === undefined"))
        await click(pg, foot('a0') + ' [data-act=copy]')
        ok = await soon(pg, "window.__exec.length >= 1")
        ex = await pg.evaluate("window.__exec")
        check('Copy falls back to execCommand(\'copy\')', ok and ex[0][0] == 'copy', ex)
        print('execCommand results:', ex)
        check('execCommand returned true (headless Chromium allows it)', ok and ex[0][1] is True, ex)
        check('the Copied toast shows', await soon(pg, "document.querySelector('#toast').classList.contains('show') && document.querySelector('#toast').textContent.includes('Copied')"),
              await pg.evaluate("document.querySelector('#toast').textContent"))
        check('...and not the failure one', 'allowed' not in await pg.evaluate("document.querySelector('#toast').textContent"))
        # the code block's button
        await pg.evaluate("window.__exec.length = 0")
        await click(pg, f"{CARD} .msg[data-mid=a0] .cbx .cpy")
        ok = await soon(pg, "window.__exec.length >= 1")
        ex = await pg.evaluate("window.__exec")
        check('code block copy button uses execCommand(\'copy\')', ok and ex[0][0] == 'copy', ex)
        check('the code button turns to Copied', await soon(pg, f"document.querySelector('{CARD} .msg[data-mid=a0] .cbx .cpy').classList.contains('done')"))
        await pg.close()

        # --- Columns still work
        pg = await opened(b, view='panes', init=STUB)
        P = '.pane[data-tid=main] .msg[data-mid=a0]'
        await pg.locator(P + ' .mfoot [data-act=copy]').click()
        ok = await soon(pg, "window.__copied.length === 1")
        got = await pg.evaluate("window.__copied")
        check('Columns: Copy in a pane copies the reply', ok and got == [A0], got)
        n0 = await pg.evaluate("Object.keys(__digress.conv.threads).length")
        await pg.locator(P + ' .mfoot [data-act=wbranch]').click()
        ok = await soon(pg, "n => Object.keys(__digress.conv.threads).length === n + 1", n0)
        check('Columns: Side question in a pane opens a branch', ok)
        await pg.close()

        await b.close()
    check('no page errors', not [f for f in fails if f.startswith('pageerror')])
    if fails:
        print('FAILED:', fails); sys.exit(1)
    print('all ok')

asyncio.run(main())
