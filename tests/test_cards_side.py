"""Flashcards from the sidebar: a conversation with cards shows a small badge (how many are due); hovering
its row gives a button that opens that conversation and its cards, and the cards dialog names the
conversation instead of "This conversation". Asserts and exits non-zero."""
import asyncio, json, sys, time
from playwright.async_api import async_playwright
from common import ROOT, launch_args, goto_app, booted, answered, saved, soon, frames, new_conv
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
FAKE = r"""
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{const out='A short answer.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false};};
  return null;}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        async def new(q):
            await new_conv(pg)
            ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter')); await saved(pg)
            return await pg.evaluate('__digress.conv.id')
        a = await new('Cards about attention')
        b_ = await new('Plain chat, no cards')
        c = await new('Cards not due yet')
        now = int(time.time() * 1000)
        def card(i, cid, due, status='active'):
            return {'id': f'k{i}', 'conv': cid, 'thread': 'main', 'at': {'thread': 'main', 'msg': 'x'}, 'where': 'Main', 'src': '', 'front': f'Front {i}', 'back': f'Back {i}', 'status': status, 'due': due, 'reviews': []}
        cards = [card(1, a, now - 1000), card(2, a, now - 500), card(3, a, now + 864e5), card(4, a, 0, 'inbox'), card(5, c, now + 3 * 864e5)]
        await pg.evaluate("cs=>{for(const k of cs)localStorage.setItem('fakesrv:cards/'+k.id,JSON.stringify(k))}", cards)
        await pg.reload(); await booted(pg)
        await soon(pg, "id => !!document.querySelector(`#side .citem[data-conv='${id}'] .cbadge`)", a)   # the cards have loaded

        badge = lambda cid: pg.locator(f'#side .citem[data-conv="{cid}"] .cbadge')
        check('a conversation with due cards shows a badge with how many', await badge(a).count() == 1 and (await badge(a).inner_text()).strip() == '2' and 'due' in (await badge(a).get_attribute('class')), await badge(a).count())
        check('cards none of them due: a quiet badge, no number', await badge(c).count() == 1 and (await badge(c).inner_text()).strip() == '' and 'due' not in (await badge(c).get_attribute('class')))
        check('a conversation without cards shows none', await badge(b_).count() == 0)

        # open another conversation, then use A's button from the sidebar
        await pg.locator(f'#side .citem[data-conv="{b_}"]').click(); await pg.wait_for_function('id => __digress.conv.id === id', arg=b_)
        row = pg.locator(f'#side .citem[data-conv="{a}"]')
        await row.hover(); await frames(pg)
        btn = row.locator('[data-cardsconv]')
        check('hovering the row shows the cards button (the badge steps aside)', await btn.is_visible() and not await badge(a).is_visible())
        await btn.click(); await soon(pg, "id => __digress.conv.id === id && !!document.querySelector('#cardsModal.show')", a)
        check('it opens that conversation', await pg.evaluate('__digress.conv.id') == a)
        check('…and its flashcards', await pg.locator('#cardsModal.show').count() == 1)
        sel = await pg.locator(f'#cardsModal [data-kscope] option[value="{a}"]').inner_text()
        check('the dialog names the conversation, not just “This conversation”', 'Cards about attention' in sel, sel)
        check('…scoped to it, starting on what’s due', await pg.evaluate("document.querySelector('#cardsModal [data-kscope]').value") == a and 'Front 1' in await pg.locator('#cardsModal').inner_text())
        check('cards turned off for new drafts are still there to review, with a way to turn drafting back on',
              'New cards are off' in await pg.locator('#cardsModal').inner_text() and await pg.locator('#cardsModal [data-kact=on]').count() == 1 and await pg.locator('#cardsModal [data-kact=make]').count() == 0)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
