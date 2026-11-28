"""Reply badges in a stack of collapsed strips' popover. Two adjacent minimized panes fold into one stack strip, which
shows the aggregate; its popover lists them, and each row shows its own state:
  - three dots (.rbadge.writing) on the row whose reply is being written, nothing on the other;
  - Ready (.rbadge.ready) when it finished out of sight, still with the popover open;
  - a popover opened after the fact shows it too, and expanding the thread clears it.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
if (!sessionStorage.getItem('seeded')) {
  sessionStorage.setItem('seeded', '1');
  localStorage.setItem('fakesrv:convs/c_stack', JSON.stringify({
    id: 'c_stack', title: 'Stack', titleKept: true, created: 100, updated: 100, rev: 1,
    threads: {
      main: {id: 'main', parent: null, title: 'Main', created: 100},
      b1: {id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'Summary', title: 'First branch', colorIdx: 0, created: 200},
      b2: {id: 'b2', parent: 'main', anchorMsg: 'a1', anchorText: 'reply', title: 'Second branch', colorIdx: 1, created: 300},
    },
    order: {main: ['u1', 'a1'], b1: ['u2', 'a2'], b2: ['u3', 'a3']},
    msgs: {
      u1: {id: 'u1', thread: 'main', role: 'user', content: 'Overview', ts: 100},
      a1: {id: 'a1', thread: 'main', role: 'assistant', content: 'Summary reply', ts: 101},
      u2: {id: 'u2', thread: 'b1', role: 'user', content: 'Q1', ts: 200}, a2: {id: 'a2', thread: 'b1', role: 'assistant', content: 'A1', ts: 201},
      u3: {id: 'u3', thread: 'b2', role: 'user', content: 'Q2', ts: 300}, a3: {id: 'a3', thread: 'b2', role: 'assistant', content: 'A2', ts: 301},
    },
  }));
  localStorage.setItem('fakesrv:layout/c_stack', JSON.stringify({devices: {other: {at: 100, ui: {open: ['main', 'b1', 'b2'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
}
"""
# a question with "slow" waits for the test to say go (window.__go())
FAKE = r"""window.__gates=[];window.__go=()=>{const g=window.__gates.shift();g&&g()};
window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const q=JSON.stringify(input[input.length-1].content);
  if(q.includes('slow'))await new Promise(r=>window.__gates.push(r));
  const out='Here is the answer to that.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
BUSY = "(()=>{const c=__digress.conv;return c.msgs[c.order.b1.slice(-1)[0]].pending})()"
def row(t): return f'.rspop .rsitem[data-rstid="{t}"] .rsgo > .rbadge'
def state(t):
    return ("(()=>{const b=document.querySelector('" + row(t) + "');return b?(b.classList.contains('ready')?'ready':b.classList.contains('writing')?'writing':'?'):''})()")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 850}); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(SEED + FAKE)
        await goto_app(pg); await booted(pg)
        await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_stack'")

        ta = pg.locator('.pane[data-tid=b1] textarea'); await ta.fill('A slow question'); await ta.press('Enter')
        await pg.wait_for_function(BUSY)
        await pg.locator('.pane[data-tid="b1"] [data-act="collapse"]').click(); await frames(pg)
        await pg.locator('.pane[data-tid="b2"] [data-act="collapse"]').click(); await frames(pg)
        stack = pg.locator('#panes > .rail-stack')
        check('two collapsed panes are one stack', await stack.count() == 1 and await stack.get_attribute('data-stack') == 'b1,b2', await stack.count())
        check('the stack strip shows the aggregate: writing', await soon(pg, "()=>!!document.querySelector('#panes .rail-stack .rbadge.writing')"))
        await stack.click()
        check('the popover opens', await soon(pg, "()=>!!document.querySelector('.rspop')"))
        check('the row whose reply is being written shows three dots', await soon(pg, f"()=>{state('b1')} === 'writing'"), await pg.evaluate(state('b1')))
        check('…the other row has no badge', await pg.evaluate(state('b2')) == '' and await pg.evaluate("document.querySelectorAll('.rspop .rbadge').length") == 1)

        await pg.evaluate('window.__go()')
        check('when it finishes the row shows Ready, popover still open', await soon(pg, f"()=>{state('b1')} === 'ready'") and await pg.locator('.rspop').is_visible(), await pg.evaluate(state('b1')))
        check('…and the other row still has none', await pg.evaluate(state('b2')) == '')
        check('…and the strip shows Ready too', await pg.evaluate("!!document.querySelector('#panes .rail-stack .rbadge.ready')"))

        # closed and reopened: still there
        await pg.keyboard.press('Escape'); await soon(pg, "()=>!document.querySelector('.rspop')")
        await pg.locator('#panes > .rail-stack').click()
        check('a popover opened later shows it too', await soon(pg, f"()=>{state('b1')} === 'ready'") and await pg.evaluate(state('b2')) == '', await pg.evaluate(state('b1')))

        # expanding it clears it
        await pg.locator('.rspop [data-rsexpand="b1"]').click()
        check('expanding the thread clears its badge', await soon(pg, "()=>!document.querySelector('.rbadge')"))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
