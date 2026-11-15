"""Several windows of one browser on one machine (the real server, fake Claude Code).
  - The address names the open conversation (#c=ID): a window opened, reloaded or bookmarked with it opens that
    conversation; an unknown ID says so and opens the latest; changing the hash switches conversation.
  - Each window keeps its own layout (window 1 under the device ID, window n under ID+'wn'), so a canvas in one
    window and columns in another don't overwrite each other, and a reload keeps its window number.
  - A change saved in one window shows in the others straight away, without clicking into them.
  - ⌘/Ctrl-click on a conversation in the sidebar opens it in a new window.
Asserts and exits non-zero."""
import asyncio, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import soon, saved, frames
from sync_common import setup, check, fails
from test_server import req


async def main():
    async with setup() as s:
        A = await s.device(); ctx = A.context
        await s.ask(A, 'First conversation')
        other = await A.evaluate('__digress.conv.id')
        await A.locator('#newConv').click()
        await s.ask(A, 'Second conversation, the one on two monitors')
        cid = await A.evaluate('__digress.conv.id')
        check(await A.evaluate('location.hash') == f'#c={cid}', 'the address names the open conversation once saved', await A.evaluate('location.hash'))

        # a second window, straight to that conversation by its address
        await A.locator('#newConv').click(); await frames(A)
        check(await A.evaluate('location.hash') == '', 'a new, unsaved conversation has no ID in the address')
        await A.locator(f'[data-conv="{other}"]').first.click(); await soon(A, "id=>__digress.conv.id===id", other)
        B = await s.window(ctx, f'/#c={cid}')
        check(await soon(B, "id=>__digress.conv&&__digress.conv.id===id", cid), 'a window opened at #c=ID opens that conversation (not the latest)', await B.evaluate('__digress.conv.id'))
        await A.evaluate(f"location.hash='#c={cid}'")
        check(await soon(A, "id=>__digress.conv.id===id", cid), 'changing the hash switches to that conversation')
        dev = await A.evaluate("localStorage.getItem('digress:device')")
        nA, nB = await A.evaluate("sessionStorage.getItem('digress:window')"), await B.evaluate("sessionStorage.getItem('digress:window')")
        check((nA, nB) == ('1', '2'), 'the two windows take window numbers 1 and 2', (nA, nB))

        # canvas in one window, columns (with a pane resized) in the other: both layouts are kept
        await B.locator('#viewSeg [data-v=canvas]').click(); await saved(B, layout=True)
        await A.evaluate("__digress.conv.ui.sizes.main=520"); await A.locator('#viewSeg [data-v=cols]').click()
        await saved(A, layout=True)
        lay = json.loads(req(s.base, 'GET', f'/api/layout/{cid}')[1])['devices']
        check(lay.get(dev, {}).get('ui', {}).get('view') == 'panes' and lay.get(dev + 'w2', {}).get('ui', {}).get('view') == 'canvas',
              'each window saved its own layout (columns under the device, canvas under window 2)', {k: v['ui'].get('view') for k, v in lay.items()})
        await B.reload(); await soon(B, "id=>__digress.conv&&__digress.conv.id===id", cid)
        check(await B.evaluate("sessionStorage.getItem('digress:window')") == '2', 'a reload keeps its window number')
        check(await soon(B, "()=>__digress.conv.ui.view==='canvas'"), '…and its own layout (the canvas)', await B.evaluate('__digress.conv.ui.view'))
        await A.reload(); await soon(A, "id=>__digress.conv&&__digress.conv.id===id", cid)
        check(await A.evaluate('__digress.conv.ui.view') == 'panes', 'the other window reopens in columns', await A.evaluate('__digress.conv.ui.view'))

        # a question asked in one window shows in the other without clicking into it
        await s.ask(A, 'Asked on monitor one')
        seen = await soon(B, "()=>Object.values(__digress.conv.msgs).some(m=>m.role==='user'&&(m.content||m.text||'').includes('monitor one'))", timeout=6000)
        check(seen, 'a question asked in one window shows in the other straight away')

        # a third window gets the lowest free number; closing window 2 frees it
        C = await s.window(ctx, '/')
        check(await C.evaluate("sessionStorage.getItem('digress:window')") == '3', 'a third window is window 3')
        await B.close()
        D = await s.window(ctx, f'/#c={cid}')
        check(await D.evaluate("sessionStorage.getItem('digress:window')") == '2', 'after window 2 closes, the next new window takes 2 (and its layout)')
        check(await soon(D, "()=>__digress.conv&&__digress.conv.ui.view==='canvas'"), '…opening in window 2’s canvas')

        # an ID that isn't there: says so, opens the latest
        E = await s.window(ctx, '/#c=cnothere')
        await soon(E, "()=>__digress.conv.order.main.length>0")
        t = await E.locator('#toast').inner_text()
        check('isn’t here' in t and await E.evaluate('__digress.conv.order.main.length') > 0, 'an unknown ID says so and opens the latest', t)

        # ⌘/Ctrl-click in the sidebar: a new window at that conversation
        async with ctx.expect_page() as w:
            await A.locator(f'.citem[data-conv="{other}"]').first.click(modifiers=['ControlOrMeta'])
        F = await w.value; await F.wait_for_load_state()
        await soon(F, "()=>window.__digress&&__digress.conv&&__digress.conv.order.main.length>0")
        check(await F.evaluate('__digress.conv.id') == other and F.url.endswith(f'#c={other}'), 'Ctrl-click on a conversation opens a new window at it (not the latest)', F.url)
        check(await A.evaluate('__digress.conv.id') == cid, '…and leaves this window where it was')
        check(not s.errs, 'no page errors', s.errs[:3])
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
