"""Two devices on one conversation (two browser profiles, the real server, fake Claude Code).

  - Switching devices: what one added shows on the other when its tab comes back, without a reload, and the
    other keeps its own layout (view, open panes) and where it was scrolled.
  - Both asked something without seeing the other's: neither is lost; the later one becomes another version.
  - Deleted on one device while the other still has it open: the other's new question is kept as a copy.
Replies that outlive their page are in test_sync_replies.py.
Asserts and exits non-zero."""
import asyncio, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import OUT, caught_up, frames, poll, soon
from sync_common import setup, check, fails


async def main():
    async with setup() as s:
        ask, back, texts = s.ask, s.back, s.texts
        A = await s.device()
        await ask(A, 'Question one from A')
        cid = await A.evaluate('__digress.conv.id')
        B = await s.device(900)
        await B.locator(f'[data-conv="{cid}"]').first.click()
        await soon(B, "id=>__digress.conv.id===id", cid)
        check(any('Question one from A' in t for t in await texts(B)), 'device B opens the conversation A made')

        # A goes to the canvas; B stays on panes. B asks; A comes back to its tab.
        await A.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()")
        await A.locator('#cv .cnode[data-ctid="main"]').wait_for()
        await ask(B, 'Question two from B')
        await back(A, "()=>(document.querySelector('#cv .cnode[data-ctid=main]')||{}).innerText?.includes('Question two from B')")
        card = await A.locator('#cv .cnode[data-ctid="main"]').inner_text()
        check('Question two from B' in card, 'A, coming back, shows what B asked without a reload', card[-300:])
        check(await A.evaluate('__digress.conv.ui.view') == 'canvas' and await B.evaluate('__digress.conv.ui.view') == 'panes', 'each device keeps its own view')
        await A.evaluate("document.querySelector('#viewSeg button[data-v=cols]').click()")

        # A scrolled up; B adds; A catches up: A stays where it was
        for i in range(3): await ask(A, f'Filler {i} ' + 'long question text ' * 20)
        await back(B, "()=>[...document.querySelectorAll('.pane[data-tid=main] .msg.user')].some(e=>e.textContent.includes('Filler 2'))")
        await A.evaluate("document.querySelector('.pane[data-tid=main] .pb').scrollTop=200"); await frames(A)
        await ask(B, 'Question three from B')
        await back(A, "()=>[...document.querySelectorAll('.pane[data-tid=main] .msg.user')].some(e=>e.textContent.includes('Question three from B'))")
        st = await A.evaluate("document.querySelector('.pane[data-tid=main] .pb').scrollTop")
        check(any('Question three from B' in t for t in await texts(A)) and abs(st - 200) < 5, f'A shows B’s new question and stays scrolled where it was ({st})')

        # both ask without seeing each other's: the later save merges, and its question becomes another version
        await ask(A, 'Concurrent from A')
        await ask(B, 'Concurrent from B')   # B hasn't caught up: its save is refused, merged, saved again
        d = s.convs()[cid]
        users = [m['content'] for m in d['msgs'].values() if m['role'] == 'user']
        alts = [t for t in d['threads'].values() if t.get('alt')]
        main_q = [d['msgs'][i]['content'] for i in d['order']['main'] if d['msgs'][i]['role'] == 'user']
        check('Concurrent from A' in users and 'Concurrent from B' in users, 'both devices’ questions are kept', users)
        check(main_q[-1] == 'Concurrent from A' and any(d['msgs'][d['order'][t['id']][0]]['content'] == 'Concurrent from B' for t in alts),
              'A’s (saved first) goes on in the main thread; B’s is another version from the same point', [main_q[-2:], alts])
        check(await B.locator('.vchip').count() >= 1, 'B shows the versions chip on its question')
        await back(A, "()=>!!document.querySelector('.pane[data-tid=main] .vchip')")
        check(await A.locator('.pane[data-tid="main"] .vchip').count() >= 1, 'A sees it too once it catches up')
        await B.screenshot(path=OUT + '/sync_versions.png')

        # deleted on one device while the other has it open: the other's new question is kept, as a copy
        await caught_up(B, s.rev(cid))
        await A.evaluate(f"__digress.deleteConv('{cid}')")
        await ask(B, 'Asked after A deleted it', wait=False)
        copies = lambda: [c for c in s.convs().values() if '(from this device)' in c.get('title', '') and any(m['content'] == 'Asked after A deleted it' for m in c['msgs'].values())]
        await poll(copies)
        await B.wait_for_timeout(1000)   # deliberate: give a stray save (or the reply's run) a chance to bring the deleted one back
        all_ = s.convs()
        copies = [c for c in all_.values() if '(from this device)' in c.get('title', '')]
        check(cid not in all_ and copies and any(m['content'] == 'Asked after A deleted it' for m in copies[0]['msgs'].values()), 'a conversation deleted elsewhere isn’t brought back; what B asked is kept as a copy', [c.get('title') for c in all_.values()])
        check(not s.errs, 'no page errors', s.errs[:3])
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
