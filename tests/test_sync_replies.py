"""Replies that outlive their page (the real server, fake Claude Code, RUN_DETACH_MS 15 s).

  - A reply carries on when its page goes to another conversation, reloads, or loses its connection, and
    one that nobody came back to in time is saved as cut off, with Continue.
Two devices editing the same conversation are in test_sync_devices.py.
Asserts and exits non-zero."""
import asyncio, os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from common import poll, soon
from sync_common import setup, check, fails, ticks, LAST_MAIN


async def main():
    async with setup() as s:
        ask, idle = s.ask, s.idle
        A = await s.device()
        await ask(A, 'Question one from A')
        cid = await A.evaluate('__digress.conv.id')
        last_saved = lambda: (lambda d: d['msgs'][d['order']['main'][-1]])(s.convs()[cid])

        # a reply carries on when its page goes elsewhere, and is there on return.
        # The fake writes 30 ticks 100 ms apart (3 s) and the server stops a reply nobody is attached to after
        # 15 s, so it finishes well inside that window. The window also has to cover a reload (below) on a busy machine.
        await ask(A, 'SLOWISH one', wait=False); await ticks(A, 7)
        await A.locator('#newConv').click()
        last = await poll(lambda: (lambda m: m if m['content'] == 'tick ' * 30 and 'run' not in m else None)(last_saved()))
        last = last or last_saved()
        check(last['content'] == 'tick ' * 30 and 'run' not in last, 'a reply finished while its page was on another conversation is saved', last)
        await A.locator(f'[data-conv="{cid}"]').first.click()
        await soon(A, "id=>__digress.conv.id===id", cid)
        body = await A.locator('.pane[data-tid="main"] .msg.assistant .body').last.inner_text()
        check(body.strip().startswith('tick tick') and body.count('tick') == 30, 'and it’s there on coming back', body[:120])

        # …and survives a reload in the middle (HOLD: the fake keeps writing until released, however long the
        # reload takes; with the whole suite running, a reload here can take several seconds)
        await ask(A, 'HOLD two', wait=False); await ticks(A)
        t0 = time.time(); await A.reload()
        back = await soon(A, f"(()=>{{const m=window.__digress&&__digress.conv&&{LAST_MAIN};return !!(m&&m.pending&&m.run)}})()", timeout=14000)
        print(f'     (reload and reconnect took {time.time() - t0:.1f} s)')
        # still writing: new ticks arrive after the reconnect (a fast machine reloads in 0.2 s, a busy one in 8)
        n = await A.evaluate(f"(({LAST_MAIN}).content||'').split('tick').length-1")
        await ticks(A, n + 3)
        check(back, 'after a reload mid-reply, it reconnects and is still writing')
        s.release(); await idle(A)
        body = await A.locator('.pane[data-tid="main"] .msg.assistant .body').last.inner_text()
        whole = last_saved()['content']
        check(body.strip() == whole.strip() and whole.endswith('done.') and whole.count('tick') >= n + 3 and 'error' not in body.lower(),
              'the whole reply, once, after the reload (as the server saved it)', [body.count('tick'), whole.count('tick'), body[-120:]])

        # …and a dropped connection (the server is still there): reconnects and finishes
        await ask(A, 'SLOWISH three', wait=False); await ticks(A)
        await A.context.set_offline(True); await A.wait_for_timeout(1200); await A.context.set_offline(False)   # the drop itself lasts 1.2 s
        await idle(A)
        body = await A.locator('.pane[data-tid="main"] .msg.assistant .body').last.inner_text()
        check(body.count('tick') == 30, 'after the network drops for a moment, the reply finishes', [body.count('tick'), body[-200:]])

        # Stop on one device ends the reply on another device watching it (the server's last line says so; the
        # stream used to just end, and the other page took that for a dropped connection and kept reconnecting)
        B = await s.device(); await B.locator(f'[data-conv="{cid}"]').first.click(); await soon(B, "id=>__digress.conv.id===id", cid)
        await ask(A, 'SLOW stop me', wait=False); await ticks(A)
        watching = await s.back(B, f"()=>{{const m={LAST_MAIN};return m.role==='assistant'&&m.pending&&(m.content||'').includes('tick')}}")
        check(watching, 'the other device picks up the reply being written')
        await A.locator('.pane[data-tid="main"] .sendb').click()
        ended = await soon(B, f"()=>{{const m={LAST_MAIN};return !m.pending&&m.error==='Stopped.'}}", timeout=8000)
        check(ended, 'Stop on one device ends it on the other, as Stopped.', await B.evaluate(f"(()=>{{const m={LAST_MAIN};return [m.pending,m.error,(m.content||'').length]}})()"))
        await idle(A); await B.context.close()

        # nobody comes back in time: cut off, kept, with Continue
        await ask(A, 'SLOW and long', wait=False); await ticks(A)
        await A.close()
        await poll(lambda: (lambda m: m.get('cut') and 'run' not in m)(last_saved()), timeout=45)   # stopped after RUN_DETACH_MS and saved by the server
        A = await s.device(); await A.locator(f'[data-conv="{cid}"]').first.click()
        await soon(A, "id=>__digress.conv.id===id&&!![...document.querySelectorAll('.pane[data-tid=main] .msg.assistant')].at(-1)?.querySelector('[data-act=continue]')", cid)
        last = A.locator('.pane[data-tid="main"] .msg.assistant').last
        check(await last.locator('[data-act="continue"]').count() == 1 and 'Cut off' in await last.inner_text(), 'a reply nobody came back to is saved as cut off, with Continue', (await last.inner_text())[-300:])
        before = (await last.locator('.body').inner_text()).count('tick')
        # Continue asks again from where it stopped (the fake doesn't know it's a continuation: it just answers)
        await A.evaluate("PROMPTS.continueCut='Carry on, SLOWISH.'")
        await last.locator('[data-act="continue"]').click(); await idle(A)
        last = A.locator('.pane[data-tid="main"] .msg.assistant').last
        after = (await last.locator('.body').inner_text()).count('tick')
        check(after == before + 30 and await last.locator('[data-act="continue"]').count() == 0, f'Continue adds on to what was there ({before} → {after})')
        check(not s.errs, 'no page errors', s.errs[:3])
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
