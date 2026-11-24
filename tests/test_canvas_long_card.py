"""A collapsed canvas card of a long thread (more than CARD_ROWS_ALL = 8 messages) lists only the first two messages, every
message a branch comes off (with the question before it) and the last two; each run in between is one "⋯ N more" row.
  - the rows: u0, a0, gap, u7, a7, gap, u14, a14 (a 30-message thread, branch off a7); the gaps count 12 and 12
  - the line to the branch starts at a7's row
  - a thread of 8 or fewer messages has no gap and lists everything
  - clicking a gap expands the card at that message; the card's top-bar button shrinks it back to the summary
  - a branch off a hidden message (a11) makes it and its question show
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import OUT, launch_args, goto_app, booted, settle, soon

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def seed(n, branches):
    """A main thread of n user/assistant pairs; branches = [(tid, anchor message)]."""
    return r"""
const N=%d, BR=%s, now=Date.now(), msgs={}, order=[], threads={main:{id:'main',parent:null,title:'Main thread',colorIdx:-1}}, ord={};
for(let i=0;i<N;i++){msgs['u'+i]={id:'u'+i,role:'user',thread:'main',content:'Question number '+i+' about something',ts:now};
  msgs['a'+i]={id:'a'+i,role:'assistant',thread:'main',content:'Answer '+i+'. The quick brown fox jumps over the lazy dog. '.repeat(3),ts:now};order.push('u'+i,'a'+i)}
ord.main=order;
BR.forEach(([t,a],k)=>{msgs[t+'u']={id:t+'u',role:'user',thread:t,content:'Side about '+a,ts:now};msgs[t+'a']={id:t+'a',role:'assistant',thread:t,content:'Side reply',ts:now};
  threads[t]={id:t,parent:'main',anchorMsg:a,anchorText:'quick brown',anchorRange:{s:9,e:20},title:'Side '+t,colorIdx:k,created:now};ord[t]=[t+'u',t+'a']});
localStorage.setItem('fakesrv:convs/cl',JSON.stringify({id:'cl',title:'Long',created:now,updated:now,rev:1,threads,msgs,order:ord,nextColor:BR.length}));
localStorage.setItem('fakesrv:layout/cl',JSON.stringify({devices:{other:{at:now,ui:{open:['main'],collapsed:[],layout:'cols',view:'canvas',sizes:{}}}}}));
""" % (n, str(branches).replace('(', '[').replace(')', ']'))

FAKE = "window.fakeLLM={use:async()=>async()=>({text:'ok'})};"
CARD = '#cv .cnode[data-ctid=main]'
ROWS = f"[...document.querySelectorAll('{CARD} .crs > .cr')].map(r => r.classList.contains('gap') ? 'gap:' + r.textContent.trim() + ':' + r.dataset.cmid : r.dataset.cmid)"

async def opened(b, n, branches):
    pg = await b.new_page(viewport={'width': 1300, 'height': 900})
    pg.on('pageerror', lambda e: fails.append('pageerror ' + str(e)[:200]))
    await pg.add_init_script("if(!sessionStorage.getItem('s')){sessionStorage.setItem('s','1');" + seed(n, branches) + "}" + FAKE)
    await goto_app(pg); await booted(pg)
    await pg.wait_for_selector(CARD + ' .crs'); await settle(pg, 200)
    return pg

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())

        pg = await opened(b, 15, [('b1', 'a7')])
        rows = await pg.evaluate(ROWS)
        print(rows)
        check('long card: first two, the branch point with its question, last two, gaps between',
              rows == ['u0', 'a0', 'gap:⋯ 12 more messages:u1', 'u7', 'a7', 'gap:⋯ 12 more messages:u8', 'u14', 'a14'], rows)
        # the line to b1 starts at a7's row
        ok = await soon(pg, f"() => document.querySelectorAll('#edges circle').length >= 1")
        info = await pg.evaluate(f"""() => {{
          const row = document.querySelector('{CARD} .crs .cr[data-cmid=a7]').getBoundingClientRect();
          const c = [...document.querySelectorAll('#edges circle')].map(e => e.getBoundingClientRect());
          return {{top: row.top, bot: row.bottom, c: c.map(r => r.top + r.height / 2)}} }}""")
        check('the line to b1 starts at a7\'s row', ok and len(info['c']) == 1 and info['top'] - 1 <= info['c'][0] <= info['bot'] + 1, info)
        check('the card is not expanded', await pg.locator(CARD + ' .cfull').count() == 0)
        await pg.screenshot(path=OUT + '/canvas_long_card.png')

        # a gap expands the card at its message
        await pg.locator(CARD + ' .cr.gap').nth(1).click()
        check('clicking a gap expands the card', await soon(pg, f"() => !!document.querySelector('{CARD} .cfull')"))
        await settle(pg, 300)
        vis = await pg.evaluate(f"""() => {{ const f = document.querySelector('{CARD} .cfull'), m = f && f.querySelector('.msg[data-mid=a8]');
          if (!m) return null; const fr = f.getBoundingClientRect(), mr = m.getBoundingClientRect();
          return {{top: mr.top - fr.top, bot: mr.bottom - fr.bottom, st: f.scrollTop}} }}""")
        check('…and the message it stood for (a8) is in view inside it', vis and vis['top'] >= -2 and vis['top'] < 560 and vis['st'] > 0, vis)
        # back to the summary
        await pg.evaluate(f"document.querySelector('{CARD} [data-cact=exp]').click()")
        check('the top bar button shrinks it back', await soon(pg, f"() => !document.querySelector('{CARD} .cfull') && document.querySelectorAll('{CARD} .cr.gap').length === 2"))
        check('…to the same rows', await pg.evaluate(ROWS) == rows)
        await pg.close()

        # a short thread: no gaps, every message
        pg = await opened(b, 4, [('b1', 'a1')])
        rows = await pg.evaluate(ROWS)
        check('8 messages: all listed, no gap', rows == [f'{r}{i}' for i in range(4) for r in 'ua'] and 'gap' not in str(rows), rows)
        check('the branch card (2 messages) lists both', await pg.evaluate("[...document.querySelectorAll('#cv .cnode[data-ctid=b1] .crs > .cr')].map(r=>r.dataset.cmid)") == ['b1u', 'b1a'])
        await pg.close()
        pg = await opened(b, 5, [])
        check('10 messages: gap appears', await pg.locator(CARD + ' .cr.gap').count() == 1, await pg.evaluate(ROWS))
        await pg.close()

        # a branch off a hidden message (a11) shows it and its question
        pg = await opened(b, 15, [('b1', 'a7'), ('b2', 'a11')])
        rows = await pg.evaluate(ROWS)
        check('a branch off a11 makes a11 and u11 show',
              rows == ['u0', 'a0', 'gap:⋯ 12 more messages:u1', 'u7', 'a7', 'gap:⋯ 6 more messages:u8', 'u11', 'a11', 'gap:⋯ 4 more messages:u12', 'u14', 'a14'], rows)
        await pg.close()
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
