"""Reviewing flashcards never waits on the network, and a card can be skipped.
  - Rating a card goes on to the next one straight away even when the server never answers (a network that's
    there but goes nowhere); the review is kept on this device and sent in the background.
  - When sending fails, a toast says so once and the review shows "N changes saved on this device, not synced
    yet"; when the connection is back, the outbox is sent and the note goes away.
  - Skip (or S) goes on to the next card; the skipped one comes back at the end. With one card left there's no Skip.
Asserts and exits non-zero."""
import asyncio, json, sys, time
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, frames, soon
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

now = int(time.time() * 1000)
CARDS = {f'kc{i}': {'id': f'kc{i}', 'conv': 'cX', 'convTitle': 'Attention', 'thread': 'main', 'src': 'made', 'front': f'Front {i}',
                    'back': f'Back {i}', 'status': 'active', 'created': now, 'due': now - 10000 + i, 'fsrs': None, 'reviews': []} for i in range(3)}
SEED = "(()=>{const c=%s;for(const [id,d] of Object.entries(c))if(!localStorage.getItem('fakesrv:cards/'+id))localStorage.setItem('fakesrv:cards/'+id,JSON.stringify(d))})()" % json.dumps(CARDS)
# the network for cards: 'ok', 'hang' (never answers, until the request is given up) or 'fail' (no connection)
NET = r"""(()=>{window.__net='ok';const f=window.fetch;window.fetch=(u,o={})=>{
  if(String(u).includes('api/store/cards')&&o.method&&window.__net!=='ok'){
    if(window.__net==='fail')return Promise.reject(new TypeError('Failed to fetch'));
    window.__hung=(window.__hung||0)+1;return new Promise((_,no)=>o.signal&&o.signal.addEventListener('abort',()=>no(o.signal.reason)))}
  return f(u,o)}})()"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(SEED)
        await goto_app(pg); await booted(pg); await pg.evaluate(NET)
        front = lambda: pg.locator('#cardsModal .kfront').inner_text()
        await pg.locator('#reviewBtn').click(); await pg.locator('#cardsModal .kfront').wait_for()
        check('(three cards due, the first one shown)', 'Front 0' in await front() and '3 due' in await pg.locator('#cardsModal .kbar').inner_text())

        # skip
        await pg.locator('#cardsModal [data-kact=skip]').click(); await frames(pg)
        check('Skip goes on to the next card', 'Front 1' in await front(), await front())
        await pg.keyboard.press('s'); await frames(pg)
        check('…S too', 'Front 2' in await front(), await front())
        await pg.keyboard.press('s'); await frames(pg)
        check('…and the skipped ones come back at the end, in the order skipped', 'Front 0' in await front(), await front())

        # a network that goes nowhere: rating doesn't wait
        await pg.evaluate("window.__net='hang'")
        await pg.keyboard.press('Space'); await frames(pg)
        t0 = time.time(); await pg.keyboard.press('3')
        await pg.wait_for_function("document.querySelector('#cardsModal .kfront')?.textContent.includes('Front 1')", timeout=1500)
        check('rating goes on to the next card straight away, even when the server never answers', time.time() - t0 < 1.5 and await pg.evaluate("window.__hung") >= 1)
        check('…the review is kept on this device', await pg.evaluate("JSON.parse(localStorage.getItem('digress:cards'))['kc0'].reviews.length") == 1)

        # sending fails: say so
        await pg.evaluate("window.__net='fail'")
        await pg.keyboard.press('Space'); await pg.keyboard.press('3'); await frames(pg)
        await soon(pg, "() => (document.querySelector('#cardsModal .kpend')||{}).textContent?.includes('not synced yet')", timeout=12000)
        note = await pg.locator('#cardsModal .kpend').inner_text()
        check('when sending fails, the review says how many changes wait on this device', note.startswith('2 changes saved on this device'), note)
        check('…a toast says so', 'it will sync when the server is back' in await pg.locator('#toast').inner_text())
        z = await pg.evaluate("['#toast','#cardsModal','#pal'].map(q=>+getComputedStyle(document.querySelector(q)).zIndex)")
        check('…shown in front of the flashcards (and search), not under the dimmed background', z[0] > z[1] and z[0] > z[2], z)
        check('…and one card left: no Skip', await pg.locator('#cardsModal [data-kact=skip]').count() == 0)
        await pg.evaluate("document.getElementById('toast').classList.add('show')"); await pg.wait_for_timeout(300)   # deliberate: the toast may have faded by now; show it for the screenshot
        await pg.screenshot(path=OUT + '/cards_offline_review.png')

        # back online: the outbox goes, the note goes
        await pg.evaluate("window.__net='ok'; dispatchEvent(new Event('online'))")
        await soon(pg, "() => !(document.querySelector('#cardsModal .kpend')||{}).textContent", timeout=10000)
        stored = await pg.evaluate("['kc0','kc1'].map(id=>JSON.parse(localStorage.getItem('fakesrv:cards/'+id)).reviews.length)")
        check('back online, the reviews reach the server and the note goes', stored == [1, 1] and await pg.evaluate("localStorage.getItem('digress:cards-outbox')") == '[]', stored)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
