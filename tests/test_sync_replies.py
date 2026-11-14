"""Replies that outlive their page (the real server, fake Claude Code, RUN_DETACH_MS 2.5 s).

  - A reply carries on when its page goes to another conversation, reloads, or loses its connection, and
    one that nobody came back to in time is saved as cut off, with Continue.
Two devices editing the same conversation are in test_sync_devices.py.
Asserts and exits non-zero."""
import asyncio, os, sys
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
        # 2.5 s, so the page stays for 7 ticks (0.7 s) first: the reply then finishes inside that window.
        await ask(A, 'SLOWISH one', wait=False); await ticks(A, 7)
        await A.locator('#newConv').click()
        last = await poll(lambda: (lambda m: m if m['content'] == 'tick ' * 30 and 'run' not in m else None)(last_saved()))
        last = last or last_saved()
        check(last['content'] == 'tick ' * 30 and 'run' not in last, 'a reply finished while its page was on another conversation is saved', last)
        await A.locator(f'[data-conv="{cid}"]').first.click()
        await soon(A, "id=>__digress.conv.id===id", cid)
        body = await A.locator('.pane[data-tid="main"] .msg.assistant .body').last.inner_text()
        check(body.strip().startswith('tick tick') and body.count('tick') == 30, 'and it’s there on coming back', body[:120])

        # …and survives a reload in the middle
        await ask(A, 'SLOWMID two', wait=False); await ticks(A)
        await A.reload()
        await soon(A, f"(()=>{{const m=window.__digress&&__digress.conv&&{LAST_MAIN};return !!(m&&m.pending&&m.run)}})()")
        check(await A.evaluate(f"(()=>{{const m={LAST_MAIN};return !!(m.pending&&m.run)}})()"), 'after a reload mid-reply, it reconnects and is still writing')
        await idle(A)
        body = await A.locator('.pane[data-tid="main"] .msg.assistant .body').last.inner_text()
        check(body.count('tick') == 80 and 'error' not in body.lower(), 'the whole reply, once, after the reload', [body.count('tick'), body[-200:]])

        # …and a dropped connection (the server is still there): reconnects and finishes
        await ask(A, 'SLOWISH three', wait=False); await ticks(A)
        await A.context.set_offline(True); await A.wait_for_timeout(1200); await A.context.set_offline(False)   # the drop itself lasts 1.2 s
        await idle(A)
        body = await A.locator('.pane[data-tid="main"] .msg.assistant .body').last.inner_text()
        check(body.count('tick') == 30, 'after the network drops for a moment, the reply finishes', [body.count('tick'), body[-200:]])

        # nobody comes back in time: cut off, kept, with Continue
        await ask(A, 'SLOW and long', wait=False); await ticks(A)
        await A.close()
        await poll(lambda: (lambda m: m.get('cut') and 'run' not in m)(last_saved()))   # stopped after RUN_DETACH_MS and saved by the server
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
