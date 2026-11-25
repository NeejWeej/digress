"""The token breakdown under a reply: the "20k / 200k context" label is a button (`.ctxu[data-act=ctxinfo]`) that opens
`#usagePop` with Input, from the cache, new and Output, plus Requests when there was more than one round and the
Context window when the model's is known. Escape closes it, a click elsewhere closes it, and the label again
closes it. The same in an expanded canvas card's reply line. A reply with no window and one request shows neither row.
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, settle, soon

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def seed(view):
    return r"""
const now=Date.now();
const msgs={u0:{id:'u0',role:'user',thread:'main',content:'First question',ts:now},
  a0:{id:'a0',role:'assistant',thread:'main',content:'First answer.',ts:now,model:'sample',usage:{ctx:20000,cached:15000,out:900,rounds:2,window:200000}},
  u1:{id:'u1',role:'user',thread:'main',content:'Second question',ts:now},
  a1:{id:'a1',role:'assistant',thread:'main',content:'Second answer.',ts:now,model:'sample',usage:{ctx:1500,cached:0,out:80,rounds:1}}};
localStorage.setItem('fakesrv:convs/cu',JSON.stringify({id:'cu',title:'Usage',created:now,updated:now,rev:1,
  threads:{main:{id:'main',parent:null,title:'Main thread',colorIdx:-1}},msgs,order:{main:['u0','a0','u1','a1']},nextColor:0}));
localStorage.setItem('fakesrv:layout/cu',JSON.stringify({devices:{other:{at:now,ui:{open:['main'],collapsed:[],layout:'cols',view:'%s',sizes:{}}}}}));
""" % view

ROWS = "[...document.querySelectorAll('#usagePop .ur')].map(r=>[r.firstElementChild.textContent,r.querySelector('b').textContent])"

async def open_page(b, view):
    pg = await b.new_page(viewport={'width': 1300, 'height': 900})
    pg.on('pageerror', lambda e: fails.append('pageerror ' + str(e)[:200]))
    await pg.add_init_script("if(!sessionStorage.getItem('s')){sessionStorage.setItem('s','1');" + seed(view) + "}")
    await goto_app(pg); await booted(pg)
    return pg

async def exercise(pg, where, label0, label1, blank):
    L0 = pg.locator(f'{where} .msg[data-mid=a0] button.ctxu[data-act=ctxinfo]')
    check(f'{where}: the label is a button with the numbers', await L0.count() == 1 and (await L0.text_content()).strip() == '20k / 200k context', await L0.all_text_contents())
    await L0.click()
    await pg.locator('#usagePop.open').wait_for(timeout=5000)
    rows = dict(await pg.evaluate(ROWS))
    check(f'{where}: Input, from the cache, new and Output', rows.get('Input') == '20,000' and rows.get('from the cache') == '15,000 (75%)' and rows.get('new') == '5,000' and rows.get('Output') == '900', rows)
    check(f'{where}: Requests (2 rounds) and the Context window (10% of 200k)', rows.get('Requests') == '2' and rows.get('Context window') == '10% of 200k', rows)
    inside = await pg.evaluate("(()=>{const r=document.querySelector('#usagePop').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()")
    check(f'{where}: the popup is on screen', inside)
    await pg.keyboard.press('Escape'); await pg.wait_for_function("!document.querySelector('#usagePop.open')", timeout=5000)
    check(f'{where}: Escape closes it', True)
    await L0.click(); await pg.locator('#usagePop.open').wait_for(timeout=5000)
    await pg.mouse.click(*blank); await pg.wait_for_function("!document.querySelector('#usagePop.open')", timeout=5000)
    check(f'{where}: a click elsewhere closes it', True)
    await L0.click(); await pg.locator('#usagePop.open').wait_for(timeout=5000)
    await L0.click(); await pg.wait_for_function("!document.querySelector('#usagePop.open')", timeout=5000)
    check(f'{where}: the label again closes it', True)
    # the other reply: no Requests, no Context window, nothing from the cache
    await pg.locator(f'{where} .msg[data-mid=a1] button.ctxu').click(); await pg.locator('#usagePop.open').wait_for(timeout=5000)
    rows = dict(await pg.evaluate(ROWS))
    check(f'{where}: a one-request reply with no window shows neither row', rows.get('Input') == '1,500' and rows.get('from the cache') == 'none' and rows.get('new') == '1,500' and rows.get('Output') == '80' and 'Requests' not in rows and 'Context window' not in rows, rows)
    await pg.keyboard.press('Escape'); await pg.wait_for_function("!document.querySelector('#usagePop.open')", timeout=5000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await open_page(b, 'panes')
        await pg.wait_for_selector('.pane[data-tid=main] .msg[data-mid=a0] .ctxu')
        await exercise(pg, '.pane[data-tid=main]', None, None, (650, 880))
        await pg.close()
        pg = await open_page(b, 'canvas')
        CARD = '#cv .cnode[data-ctid=main]'
        await pg.wait_for_selector(CARD + ' .crs'); await settle(pg, 200)
        await pg.evaluate(f"document.querySelector('{CARD} [data-cact=exp]').click()")
        await pg.wait_for_selector(CARD + ' .cfull .msg.assistant'); await settle(pg, 300)
        await exercise(pg, CARD + ' .cfull', None, None, (5, 880))
        await pg.close(); await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
