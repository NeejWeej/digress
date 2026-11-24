"""suggest_card: the model suggests a flashcard while it answers, whenever it judges something has landed.
  - Offered only in a conversation with flashcards on (the page names it in the request's tools).
  - A call adds the card to the inbox (src 'suggested', pointing at the reply), says so in a toast, and the same
    question twice is refused.
  - Card drafting is offered the same tools (one prompt cache) but refuses the call: it has its own instructions.
  - The Prompts page lists the tools and what switches each on.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon, answered

FAKE = r"""window.fakeTools=true;window.__tools=[];window.__results=[];
window.fakeLLM={use:async(n)=>n!=='sample'?null:async(msgs,opts)=>{
  const last=msgs[msgs.length-1].content;window.__tools.push(opts.tools);
  if(/\[Flashcards\]/.test(last)){window.__results.push(['draft',await opts.callTool('suggest_card',{front:'Drafting?',back:'No.'})]);return {text:'[]'}}
  if(/CARD/.test(last)){const c={front:'What is a prior?',back:'What you believe before seeing the evidence.'};
    window.__results.push(['reply',await opts.callTool('suggest_card',c)],['again',await opts.callTool('suggest_card',c)])}
  const out='Answered.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:400])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea:not(.pptext)')
        async def ask(t):
            await ta.fill(t); await answered(pg, ta.press('Enter')); await frames(pg)

        await ask('Hello.')
        check('cards off: not offered', 'suggest_card' not in (await pg.evaluate('window.__tools'))[-1], await pg.evaluate('window.__tools'))

        await pg.locator('.pane[data-tid=main] .kicon').click(); await pg.locator('[data-kact=on]').click()
        await soon(pg, '() => __digress.conv.cards && __digress.conv.cards.on')
        await pg.locator('[data-kact=close]').click(); await frames(pg)

        await ask('CARD please.')
        check('cards on: offered', 'suggest_card' in (await pg.evaluate('window.__tools'))[-1])
        res = dict((k, v) for k, v in await pg.evaluate('window.__results'))
        check('the call is answered: added', 'parts' in res.get('reply', {}) and 'inbox' in res['reply']['parts'][0]['text'], res)
        check('the same question twice is refused', 'already' in (res.get('again') or {}).get('error', ''), res)
        card = await pg.evaluate("""(() => { const c = [...__digress.cards.values()].filter(c => c.src === 'suggested'); const m = __digress.conv;
            const reply = m.order.main.map(id => m.msgs[id]).filter(x => x.role === 'assistant').pop();
            return c.length === 1 && {status: c[0].status, front: c[0].front, atReply: c[0].at.msg === reply.id, conv: c[0].conv === m.id}; })()""")
        check('one card, in the inbox, from that reply', card and card['status'] == 'inbox' and card['atReply'] and card['conv'] and card['front'] == 'What is a prior?', card)
        await soon(pg, "() => /suggested 1 flashcard/.test(document.querySelector('#toast').textContent)")
        check('a toast says so', True)

        # drafting (Make cards) gets the same tools but refuses the call
        await pg.locator('.pane[data-tid=main] .kicon').click(); await pg.locator('[data-kact=make]').click()
        await soon(pg, "() => window.__results.some(r => r[0] === 'draft')")
        dr = [v for k, v in await pg.evaluate('window.__results') if k == 'draft'][0]
        check('drafting is offered it too (one prompt cache)', 'suggest_card' in (await pg.evaluate('window.__tools'))[-1])
        check('…but refuses it', 'error' in dr and 'Not in this request' in dr['error'], dr)
        check('no card from that', await pg.evaluate("[...__digress.cards.values()].filter(c => c.front === 'Drafting?').length") == 0)
        await pg.keyboard.press('Escape'); await frames(pg)

        # the Prompts page lists the tools
        await pg.locator('#promptsBtn').click(); await soon(pg, "() => document.querySelector('#ppTools .pptool')")
        t = await pg.locator('#ppTools').inner_text()
        check('the Tools section lists web search, the document tools and suggest_card', all(x in t for x in ('Web search', 'Reading the document', 'Suggesting flashcards', 'suggest_card')), t[:300])

        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
