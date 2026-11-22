"""The Activity page (the sidebar's Activity button), worked out from what's saved; nothing new is recorded.
  - A grid of days: questions, branches and reviews per day; the kind chips filter it; a day lists its conversations.
  - What you remember: about how many cards you'd recall now (FSRS), recall over 30 days, what's coming due,
    the cards you keep missing.
  - Rabbit holes: the deepest chain of branches, the most branched conversations, passages branched from twice.
  - Escape closes it; a conversation in it opens that conversation.
Asserts and exits non-zero."""
import asyncio, sys, json, time
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

DAY = 86400000
now = int(time.time() * 1000)
def conv(cid, title, depth, extra_on_main=0, t0=now):
    th = {'main': {'id': 'main', 'parent': None, 'title': 'Main', 'colorIdx': 0}}
    msgs = {'q0': {'id': 'q0', 'thread': 'main', 'role': 'user', 'text': 'Q', 'content': 'Q', 'ts': t0},
            'a0': {'id': 'a0', 'thread': 'main', 'role': 'assistant', 'content': 'An answer about softmax and keys.', 'ts': t0 + 1}}
    order = {'main': ['q0', 'a0']}
    par = 'main'
    for i in range(depth):
        tid = f'b{i}'; th[tid] = {'id': tid, 'parent': par, 'anchorMsg': 'a0' if par == 'main' else f'a{tid}', 'anchorText': f'step {i}', 'title': f'Level {i + 1}', 'colorIdx': i + 1, 'created': t0 + i}
        msgs[f'q{tid}'] = {'id': f'q{tid}', 'thread': tid, 'role': 'user', 'content': 'why?', 'ts': t0 + i}
        msgs[f'a{tid}'] = {'id': f'a{tid}', 'thread': tid, 'role': 'assistant', 'content': 'because', 'ts': t0 + i}
        order[tid] = [f'q{tid}', f'a{tid}']; par = tid
    for j in range(extra_on_main):   # branches off the same passage
        tid = f'x{j}'; th[tid] = {'id': tid, 'parent': 'main', 'anchorMsg': 'a0', 'anchorText': 'softmax and keys', 'title': f'Again {j}', 'colorIdx': 9, 'created': t0}
        order[tid] = []
    return {'id': cid, 'title': title, 'created': t0, 'updated': t0, 'rev': 1, 'threads': th, 'msgs': msgs, 'order': order, 'nextColor': 12}

CONVS = [conv('cdeep', 'Deep one', 4, 0, now - 3 * DAY), conv('cwide', 'Wide one', 1, 4, now - 10 * DAY)]
def card(i, reviews, status='active'):
    return {'id': f'k{i}', 'conv': 'cdeep', 'convTitle': 'Deep one', 'thread': 'b0', 'front': f'Card {i}?', 'back': 'A.', 'status': status, 'created': now - 9 * DAY,
            'due': now - DAY, 'fsrs': {'S': 4, 'D': 5, 'state': 'review', 'last': now - 2 * DAY, 'reps': len(reviews), 'lapses': 0} if reviews else None, 'reviews': reviews}
CARDS = [card(0, [{'at': now - 5 * DAY, 'g': 3}, {'at': now - 2 * DAY, 'g': 3}]),
         card(1, [{'at': now - 5 * DAY, 'g': 1}, {'at': now - 4 * DAY, 'g': 1}, {'at': now - 2 * DAY, 'g': 3}]),
         card(2, [])]
SEED = "if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + ''.join(
    f"localStorage.setItem('fakesrv:convs/{c['id']}',{json.dumps(json.dumps(c))});" for c in CONVS) + ''.join(
    f"localStorage.setItem('fakesrv:cards/{k['id']}',{json.dumps(json.dumps(k))});" for k in CARDS) + "}"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1280, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(SEED)
        await goto_app(pg); await booted(pg)
        await pg.locator('#actBtn').click(); await pg.locator('#activity .acgrid').wait_for(); await frames(pg, 3)
        top = await pg.locator('#activity .actop').inner_text()
        # questions: 1 + 4 (deep) + 1 + 1 (wide) = 7; branches: 4 + 1 + 4 = 9 (wide has more than deep: no tie to order by chance); reviews: 5
        check('totals: questions, branches, reviews', '7 questions' in top.replace('\n', ' ') and '9 branches' in top.replace('\n', ' ') and '5 reviews' in top.replace('\n', ' '), top)
        lit = await pg.evaluate("[...document.querySelectorAll('#activity .acday[data-aday]:not(.l0)')].length")
        check('the grid lights the days something happened', lit == 5, lit)
        await pg.locator('#activity [data-akind=r]').click(); await frames(pg)
        check('the Reviews chip shows only review days', await pg.evaluate("document.querySelectorAll('#activity .acday[data-aday]:not(.l0)').length") == 3)
        await pg.locator('#activity [data-akind=all]').click(); await frames(pg)
        key = await pg.evaluate(f"(()=>{{const d=new Date({now - 3 * DAY});return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}})()")
        await pg.locator(f'#activity [data-aday="{key}"]').click(); await frames(pg)
        check('a day lists what you did, by conversation', 'Deep one' in await pg.locator('#activity .acdaybox').inner_text())

        mem = await pg.locator('#activity .acmem').inner_text()
        check('what you remember: cards you’d recall now, of those kept', '~2' in mem and 'of your 3 cards' in mem, mem[:200])
        check('…recall over 30 days', '60%' in mem, mem)
        check('…the ones you keep missing', 'Card 1?' in mem and 'missed 2 times' in mem)
        check('…and what’s coming due', await pg.locator('#activity .acbars rect').count() == 14)

        holes = await pg.locator('#activity .acholes').inner_text()
        check('rabbit holes: the deepest dive', '4 levels down' in holes.lower() and await pg.locator('#activity .acpath .acstep').count() == 5, holes[:300])
        check('…most branched first', holes.index('Wide one') < holes.index('Deep one', holes.index('MOST') if 'MOST' in holes else holes.index('Most')), holes)
        check('…a passage you kept coming back to', 'softmax and keys' in holes and '4 branches' in holes)
        await pg.screenshot(path=OUT + '/activity.png', full_page=True)

        await pg.locator('#activity [data-acard=k1]').click(); await pg.locator('#cardsModal.show').wait_for(); await frames(pg, 3)
        f = pg.locator('#cardsModal .kitem.kfocus')
        check('a card that keeps slipping opens that card, marked, in view', await f.count() == 1 and 'Card 1?' in await f.inner_text() and await f.is_visible())
        await pg.keyboard.press('Escape'); await frames(pg)
        await pg.locator('#actBtn').click(); await pg.locator('#activity .acgrid').wait_for()
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Escape closes it', not await pg.locator('#activity').is_visible())
        await pg.locator('#actBtn').click(); await pg.locator('#activity .acpath').wait_for()
        await pg.locator('#activity .acpath .acstep').last.click()
        await pg.wait_for_function("__digress.conv && __digress.conv.id==='cdeep' && __digress.conv.ui.open.includes('b3')")
        check('a step in the dive opens that branch, in its conversation', not await pg.locator('#activity').is_visible())
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
