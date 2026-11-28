"""Unsent drafts: text typed in a thread's message box is kept on this device (localStorage "digress:drafts").
  - A draft in main and in a branch survives a reload.
  - The pane's box and the same thread's canvas card box show one draft: typing in one fills in the other.
  - Sending clears it (also after a reload), from the pane and from the canvas card.
  - A draft in one conversation's main doesn't appear in another conversation's main, in the panes or on the canvas.
  - The clipper's "Add to current thread" on the canvas puts the text in the selected card's box, and it is kept.
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, soon, frames, settle, answered, saved, quiet, new_conv

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

FAKE_LLM = """window.fakeLLM = {
  use: async (name) => name === 'sample' ? async (messages, opts) => {
    const reply = 'Attention weighs the values by how well each key matches the query, then adds them up.';
    if (opts && opts.onToken) opts.onToken(reply);
    return { text: reply };
  } : null
};"""

DRAFTS = "(() => { try { return JSON.parse(localStorage.getItem('digress:drafts') || '{}') } catch (e) { return null } })()"
pane_box = lambda tid: f'.pane[data-tid="{tid}"] .composer textarea'
card_box = lambda tid: f'#cv .cnode[data-ctid="{tid}"] .cask textarea'

async def post_clip(pg, payload):
    return await pg.evaluate("""(payload) => new Promise((resolve) => {
      const id = 't-' + Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source === window && e.data && e.data.digressClipAck === 1 && e.data.id === id) { window.removeEventListener('message', onMsg); resolve(e.data); }
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ digressClip: 1, id, payload }, location.origin);
    })""", payload)

async def draft_in_store(pg, tid, cid=None):
    d = await pg.evaluate(DRAFTS)
    cid = cid or await pg.evaluate("__digress.conv.id")
    return ((d or {}).get(cid) or {}).get(tid, {}).get('v')

async def view(pg, v):
    await pg.evaluate("v => document.querySelector(`#viewSeg button[data-v=${v}]`).click()", v)
    if v == 'canvas': await pg.locator('#cv .cnode').first.wait_for()
    else: await pg.locator('.pane[data-tid="main"]').wait_for()
    await settle(pg)

async def open_card(pg, *tids):
    """Expand each card on the canvas (only an expanded card has a message box)."""
    for tid in tids:
        if not await pg.locator(card_box(tid)).count():
            await pg.locator(f'#cv .cnode[data-ctid="{tid}"] [data-cact=exp]').click()
        await pg.locator(card_box(tid)).wait_for()
    await settle(pg)

async def reload(pg):
    await saved(pg, layout=True); await quiet(pg)
    await pg.reload(); await booted(pg)
    await pg.locator('.pane[data-tid="main"]').wait_for()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE_LLM)
        await goto_app(pg); await booted(pg)

        # a conversation with a branch
        await pg.locator(pane_box('main')).fill('Explain attention'); await answered(pg, pg.locator(pane_box('main')).press('Enter'))
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid="main"] .msg.assistant .body'); const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n=w.nextNode(); while(n&&n.nodeValue.trim().length<25)n=w.nextNode();
          const r=document.createRange(); r.setStart(n,2); r.setEnd(n,20); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#pop.show').wait_for(); await pg.locator('#popIn').fill('Why that?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        bt = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        cidA = await pg.evaluate("__digress.conv.id")
        await pg.locator(pane_box(bt)).wait_for()
        check('(a branch exists; its box is empty, and so is main’s)', await pg.locator(pane_box(bt)).input_value() == '' and await pg.locator(pane_box('main')).input_value() == '')

        # 1. drafts in main and in a branch survive a reload
        await pg.locator(pane_box('main')).fill('half a question in main')
        await pg.locator(pane_box(bt)).fill('half a question in the branch')
        check('the drafts are kept per conversation and thread on this device',
              await draft_in_store(pg, 'main') == 'half a question in main' and await draft_in_store(pg, bt) == 'half a question in the branch', await pg.evaluate(DRAFTS))
        check('…and are not part of the conversation', 'draft' not in json.dumps(await pg.evaluate("__digress.conv.ui")).lower())
        await reload(pg)
        check('main’s draft is there after a reload', await pg.locator(pane_box('main')).input_value() == 'half a question in main')
        await pg.locator(pane_box(bt)).wait_for()
        check('…and the branch’s', await pg.locator(pane_box(bt)).input_value() == 'half a question in the branch')
        check('…and the send button is live for it', await pg.locator('.pane[data-tid="main"] .composer .sendb').is_enabled())

        # 2. pane <-> canvas card
        await view(pg, 'canvas'); await open_card(pg, 'main', bt)
        check('the canvas card shows the pane’s draft (main)', await pg.locator(card_box('main')).input_value() == 'half a question in main')
        check('…and the branch’s', await pg.locator(card_box(bt)).input_value() == 'half a question in the branch')
        await pg.locator(card_box(bt)).fill('typed on the canvas')
        check('typing in the card is kept as the same draft', await draft_in_store(pg, bt) == 'typed on the canvas')
        await view(pg, 'cols')
        check('the pane shows what was typed in the card', await pg.locator(pane_box(bt)).input_value() == 'typed on the canvas')
        await pg.locator(pane_box(bt)).fill('typed in the pane again')
        await view(pg, 'canvas'); await open_card(pg, bt)
        check('…and the card what was typed in the pane', await pg.locator(card_box(bt)).input_value() == 'typed in the pane again')
        # both boxes at once (the pane stays in the DOM while the canvas is up): typing in one fills the other
        await pg.locator(card_box(bt)).fill('typed in the card, pane hidden')
        check('the pane’s box is updated while the canvas is up',
              await pg.evaluate("tid => document.querySelector(`.pane[data-tid=\"${tid}\"] .composer textarea`).value", bt) == 'typed in the card, pane hidden')

        # 3. send clears it: from the card, then from the pane, each also after a reload
        n0 = await pg.evaluate("Object.keys(__digress.conv.msgs).length")
        await answered(pg, pg.locator(f'#cv .cnode[data-ctid="{bt}"] [data-cact=ask]').click())
        check('sending from the card clears the draft', await draft_in_store(pg, bt) is None and await pg.locator(card_box(bt)).input_value() == '', await pg.evaluate(DRAFTS))
        await view(pg, 'cols')
        check('…and the pane’s box', await pg.locator(pane_box(bt)).input_value() == '')
        await reload(pg)
        check('…and it stays cleared after a reload (the other draft is still there)',
              await pg.locator(pane_box(bt)).input_value() == '' and await pg.locator(pane_box('main')).input_value() == 'half a question in main')
        await answered(pg, pg.locator(pane_box('main')).press('Enter'))
        check('sending from the pane clears the draft', await draft_in_store(pg, 'main') is None and await pg.locator(pane_box('main')).input_value() == '', await pg.evaluate(DRAFTS))
        await view(pg, 'canvas'); await open_card(pg, 'main')
        check('…and the card’s box', await pg.locator(card_box('main')).input_value() == '')
        await view(pg, 'cols')
        await reload(pg)
        check('…and it stays cleared after a reload', await pg.locator(pane_box('main')).input_value() == '' and (await pg.evaluate(DRAFTS)) == {}, await pg.evaluate(DRAFTS))

        # 4. a draft in conversation A's main isn't in conversation B's main
        await pg.locator(pane_box('main')).fill('this belongs to conversation A')
        await saved(pg, layout=True)
        await new_conv(pg)
        cidB = await pg.evaluate("__digress.conv.id")
        check('(a second conversation is open)', cidB != cidA, [cidA, cidB])
        check('another conversation’s main box is empty (panes)', await pg.locator(pane_box('main')).input_value() == '')
        await view(pg, 'canvas'); await open_card(pg, 'main')
        check('…and its card’s box is empty (canvas)', await pg.locator(card_box('main')).input_value() == '')
        await pg.locator(card_box('main')).fill('this belongs to conversation B')
        await view(pg, 'cols')
        check('…typing there stays there', await pg.locator(pane_box('main')).input_value() == 'this belongs to conversation B'
              and await draft_in_store(pg, 'main', cidA) == 'this belongs to conversation A', await pg.evaluate(DRAFTS))
        await pg.locator(f'#side .citem[data-conv="{cidA}"]').click()
        await soon(pg, f"() => __digress.conv.id === '{cidA}'")
        await pg.locator(pane_box('main')).wait_for()
        check('going back to the first one brings its own draft back', await soon(pg, "() => document.querySelector('.pane[data-tid=main] .composer textarea').value === 'this belongs to conversation A'"),
              await pg.locator(pane_box('main')).input_value())
        await view(pg, 'canvas'); await open_card(pg, 'main')
        check('…on the canvas too', await pg.locator(card_box('main')).input_value() == 'this belongs to conversation A')
        await pg.locator(card_box('main')).fill('')
        await view(pg, 'cols')
        check('emptying a draft removes it', await draft_in_store(pg, 'main') is None and await pg.locator(pane_box('main')).input_value() == '')

        # 5. the clipper's "Add to current thread" on the canvas: the selected card's box
        await view(pg, 'canvas'); await open_card(pg, 'main', bt)
        await pg.locator(f'#cv .cnode[data-ctid="{bt}"] .ch .ct').click()
        await soon(pg, f"() => __digress.conv.ui.cv.sel === '{bt}'")
        ack = await post_clip(pg, {'mode': 'branch', 'useCurrentConv': True, 'useCurrentThread': True, 'title': 'A page', 'url': 'https://example.com/p', 'text': 'Clipped line for the card.'})
        check('clip on the canvas drafts into the selected card', ack.get('ok') and ack.get('threadId') == bt, ack)
        val = await pg.locator(card_box(bt)).input_value()
        check('…its box has the quote', 'Clipped line for the card.' in val and 'A page' in val, val)
        check('…it is kept as that thread’s draft', 'Clipped line for the card.' in (await draft_in_store(pg, bt) or ''))
        check('…and not in main’s box', await pg.locator(card_box('main')).input_value() == '')
        await view(pg, 'cols')
        check('…the pane shows it too', 'Clipped line for the card.' in await pg.locator(pane_box(bt)).input_value())
        await reload(pg)
        check('…and it is still there after a reload', 'Clipped line for the card.' in await pg.locator(pane_box(bt)).input_value())
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
