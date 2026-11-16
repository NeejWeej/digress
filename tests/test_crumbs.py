"""Branch header breadcrumb: earlier ancestors are links that flash where the path continues;
the direct parent is plain text (the quote already goes there)."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, launch_args, goto_app, booted, frames, calm
from common import CORS
MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
}
FAKE = "window.fakeLLM={use:async()=>null};"
fails = []
def check(ok, what):
    print(('ok  ' if ok else 'FAIL'), what)
    if not ok: fails.append(what)

async def main():
    c = json.loads(open(FIX + '/conv.json').read())
    c['id'] = 'cCRUMB'
    c['msgs']['a2'] = {'id': 'a2', 'thread': 't1', 'role': 'assistant', 'ver': 0, 'content': 'Complex numbers carry phase and amplitude together.'}
    c['order']['t1'] = ['u2', 'a2']
    c['threads']['t3'] = {'id': 't3', 'parent': 't1', 'anchorMsg': 'a2', 'anchorText': 'phase and amplitude', 'anchorRange': {'s': 19, 'e': 36}, 'colorIdx': 2, 'created': 12, 'title': 'Phase?'}
    c['msgs']['u4'] = {'id': 'u4', 'thread': 't3', 'role': 'user', 'content': 'q3', 'ver': 0}
    c['order']['t3'] = ['u4']
    c['ui']['open'] = ['main', 't1', 't3']
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        pg.on('pageerror', lambda e: print('PAGEERR', e))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await pg.add_init_script("localStorage.setItem('fakesrv:convs/cCRUMB'," + json.dumps(json.dumps(c)) + ")")
        await goto_app(pg); await booted(pg)
        await pg.locator('#clist .citem').first.click(); await pg.wait_for_function("__digress.conv.id==='cCRUMB'"); await calm(pg)
        o = pg.locator('.pane[data-tid=t3] .ph-origin')
        print('t3 header:', await o.text_content())
        check((await o.text_content()).startswith('↳ Main › Why complex?'), 'the breadcrumb still reads Main › Why complex?')
        crumbs = await o.evaluate("o=>[...o.querySelectorAll('[data-crumb]')].map(c=>[c.textContent,c.dataset.via,c.title])")
        print('crumbs:', crumbs)
        check(len(crumbs) == 2 and crumbs[0][0] == 'Main' and crumbs[0][1] == 't1' and 'branches off the main thread' in crumbs[0][2], 'the grandparent is a link, with its tooltip')
        check(crumbs[1][0] == 'Why complex?' and crumbs[1][1] == 't3' and 'where this branch starts' in crumbs[1][2], 'the parent is a link too (going up a level)')
        # clicking the parent flashes where t3 starts in t1 (as the quote does)
        await o.locator('[data-crumb]').last.dispatch_event('click'); await calm(pg)
        fl = await pg.evaluate("[...document.querySelectorAll('.anchor.flash')].map(a=>[a.closest('.pane').dataset.tid,a.dataset.tid])")
        check(['t1', 't3'] in fl, 'clicking the parent flashes where t3 starts in t1')
        await calm(pg)
        await o.locator('[data-crumb]').first.click(); await calm(pg)
        fl = await pg.evaluate("[...document.querySelectorAll('.anchor.flash')].map(a=>[a.closest('.pane').dataset.tid,a.dataset.tid])")
        print('flashing after Main:', fl)
        check(['main', 't1'] in fl, 'clicking Main flashes where t1 branches off the main thread')
        # the quote still goes to where t3 starts in t1
        # (dispatched: with three panes the quote is clipped under the header buttons)
        await o.locator('q[data-back]').dispatch_event('click'); await calm(pg)
        fl = await pg.evaluate("[...document.querySelectorAll('.anchor.flash')].map(a=>[a.closest('.pane').dataset.tid,a.dataset.tid])")
        check(['t1', 't3'] in fl, 'the quote flashes where t3 starts in t1')
        # in a narrow window the line is cut off: a ⌄ shows; it wraps the line, and folds it back
        # (narrow panes put their buttons on a row of their own, so it takes a narrow one to cut the line)
        await pg.set_viewport_size({'width': 560, 'height': 900}); await calm(pg)
        ph = pg.locator('.pane[data-tid=t3] > .ph'); await ph.scroll_into_view_if_needed()
        check(await ph.locator('.pox').is_visible(), 'a cut-off origin line gets a ⌄')
        h0 = (await ph.bounding_box())['height']
        await ph.locator('.pox').click(); await calm(pg)
        full = await o.evaluate("e=>e.scrollWidth<=e.clientWidth+1&&getComputedStyle(e).whiteSpace==='normal'")
        h1 = (await ph.bounding_box())['height']
        check(full and h1 > h0, 'clicking it shows the whole line, wrapped')
        await pg.screenshot(path=FIX.replace('fixtures', '.artifacts') + '/crumbs_open.png')
        await ph.locator('.pox').click(); await calm(pg)
        check((await ph.bounding_box())['height'] == h0, 'clicking again folds it back to one line')
        check(not await pg.locator('.pane[data-tid=main] > .ph .pox').is_visible(), 'a line that fits gets no ⌄')
        # canvas cards still render their headers
        await pg.locator('#viewSeg [data-v=canvas]').click(); await pg.locator('#cv .cnode').first.wait_for(); await calm(pg)
        await pg.screenshot(path=FIX.replace('fixtures', '.artifacts') + '/crumbs_canvas.png')
        await b.close()
    print('\n' + (f'{len(fails)} failed' if fails else 'all passed'))
    sys.exit(1 if fails else 0)
asyncio.run(main())
