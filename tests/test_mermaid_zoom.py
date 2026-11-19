"""Zooming into a diagram, with buttons only.
  - A zoom button under each drawn diagram opens a strip: + / − / Fit and four arrows. Nothing covers the diagram.
  - + zooms in place: the box keeps its height, so the conversation doesn't move; the drawing gets wider.
  - The arrows move the view (by half of it); they're off where there's nothing more that way.
  - A tall diagram fits in at most 60% of the window's height, whole, instead of running off the screen.
  - Once zoomed in, dragging the diagram moves it.
  - Scrolling over a diagram scrolls the conversation, never the diagram.
  - Fit, and closing the strip, go back to the whole diagram. The same works in a canvas card.
  - Phones and tablets without a mouse get no strip: the browser's pinch-zoom does it.
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
GRAPH = 'flowchart TD\n' + ''.join(f'  N{i}[Step number {i}] --> N{i+1}[Step number {i+1}]\n  N{i} --> S{i}[Side {i}]\n' for i in range(6))
REPLY = ('Some words before.\n\n' * 12) + '```mermaid\n' + GRAPH + '```\n\n' + ('And some words after.\n\n' * 25)
FAKE = "window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const out=%s;opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};" % json.dumps(REPLY)
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

STATE = """(sel) => { const box=document.querySelector(sel), v=box.querySelector('.mm-view'), svg=v.querySelector('svg');
  const d=n=>box.querySelector(`[data-mmz="${n}"]`).disabled;
  const R=svg.getBoundingClientRect(),vb=svg.viewBox.baseVal;
  return {k:+box.dataset.k||1, w:Math.min(R.width, R.height*vb.width/vb.height), vh:v.getBoundingClientRect().height, bh:box.getBoundingClientRect().height,
    sl:v.scrollLeft, st:v.scrollTop, vw:v.clientWidth, on:box.classList.contains('mmz-on'),
    ctl:getComputedStyle(box.querySelector('.mm-ctl')).display, out:d('out'), inn:d('in'), fit:d('fit'), l:d('l'), r:d('r'), u:d('u'), dn:d('d')} }"""

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
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Draw the steps'); await answered(pg, ta.press('Enter'))
        SEL = '.pane[data-tid=main] .mermaid-box'
        await pg.wait_for_function(f"!!document.querySelector('{SEL} .mm-view svg')", timeout=20000)
        box = pg.locator(SEL)
        await box.scroll_into_view_if_needed(); await frames(pg)
        s0 = await pg.evaluate(STATE, SEL)
        check('a tall diagram fits in 60% of the window’s height', s0['vh'] <= 0.6 * 850 + 2, s0['vh'])
        check('a drawn diagram has the zoom button, strip closed', not s0['on'] and s0['ctl'] == 'none' and await box.locator('[data-mmz=tog]').count() == 1, s0)

        await box.hover(); await box.locator('[data-mmz=tog]').click(); await frames(pg)
        s1 = await pg.evaluate(STATE, SEL)
        check('it opens the strip under the diagram', s1['on'] and s1['ctl'] != 'none')
        check('…at the whole diagram: −, Fit and the arrows are off, + is on', s1['out'] and s1['fit'] and s1['l'] and s1['r'] and s1['u'] and s1['dn'] and not s1['inn'], s1)
        bar = await box.locator('.mm-bar').bounding_box(); view = await box.locator('.mm-view').bounding_box()
        check('…below the diagram, not over it', bar['y'] >= view['y'] + view['height'] - 1, [bar, view])

        await box.locator('[data-mmz=in]').click(); await frames(pg)
        s2 = await pg.evaluate(STATE, SEL)
        check('+ zooms in: the drawing is 1.5× as wide', abs(s2['w'] / s1['w'] - 1.5) < 0.02, [s1['w'], s2['w']])
        check('…in place: the box keeps its height', abs(s2['bh'] - s1['bh']) < 1 and abs(s2['vh'] - s1['vh']) < 1, [s1['bh'], s2['bh']])
        check('…and the arrows that lead somewhere come on', not s2['dn'] and not s2['out'] and not s2['fit'], s2)
        await box.locator('[data-mmz=in]').click(); await frames(pg)
        await box.locator('[data-mmz=d]').click(); await pg.wait_for_timeout(600)
        s3 = await pg.evaluate(STATE, SEL)
        check('↓ moves the view by about half its height', abs((s3['st'] - s2['st'] * 1) - s3['vh'] / 2) < s3['vh'] * 0.2 or s3['st'] > s2['st'] + 50, [s2['st'], s3['st'], s3['vh']])
        check('…and ↑ comes on', not s3['u'], s3)

        # drag to move
        vb = await box.locator('.mm-view').bounding_box(); s_ = await pg.evaluate(STATE, SEL)
        await pg.mouse.move(vb['x'] + vb['width'] / 2, vb['y'] + vb['height'] / 2); await pg.mouse.down()
        await pg.mouse.move(vb['x'] + vb['width'] / 2 - 80, vb['y'] + vb['height'] / 2 - 60, steps=4); await pg.mouse.up(); await frames(pg)
        s_d = await pg.evaluate(STATE, SEL)
        check('dragging the zoomed diagram moves it', s_d['sl'] > s_['sl'] + 40 and s_d['st'] > s_['st'] + 30, [s_, s_d])
        check('…without selecting anything', await pg.evaluate('getSelection().isCollapsed'))
        s3 = s_d
        # hold an arrow: it keeps going
        st = s3['st']; bb = await box.locator('[data-mmz=d]').bounding_box()
        if not s3['dn']:
            await pg.mouse.move(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2); await pg.mouse.down(); await pg.wait_for_timeout(900); await pg.mouse.up(); await pg.wait_for_timeout(200)
            s4 = await pg.evaluate(STATE, SEL)
            check('holding ↓ glides on', s4['st'] > st + 30 or s4['dn'], [st, s4['st']])

        # scrolling over the diagram scrolls the conversation
        pane_top = "document.querySelector('.pane[data-tid=main] .msgs, .pane[data-tid=main] .scroll')"
        before = await pg.evaluate("(()=>{const v=document.querySelector('" + SEL + " .mm-view');let e=v.parentElement;while(e&&!(e.scrollHeight>e.clientHeight+5&&/auto|scroll/.test(getComputedStyle(e).overflowY)))e=e.parentElement;window.__sc=e;return [e.scrollTop,v.scrollTop]})()")
        vb = await box.locator('.mm-view').bounding_box()
        await pg.mouse.move(vb['x'] + vb['width'] / 2, vb['y'] + vb['height'] / 2); await pg.mouse.wheel(0, 300); await pg.wait_for_timeout(400)
        after = await pg.evaluate("[window.__sc.scrollTop, document.querySelector('" + SEL + " .mm-view').scrollTop]")
        check('scrolling over the diagram scrolls the conversation, not the diagram', after[0] != before[0] and after[1] == before[1], [before, after])
        await box.scroll_into_view_if_needed(); await frames(pg)
        await pg.screenshot(path=OUT + '/mermaid_zoom.png')

        await box.locator('[data-mmz=fit]').click(); await frames(pg)
        s5 = await pg.evaluate(STATE, SEL)
        check('Fit goes back to the whole diagram', abs(s5['w'] - s1['w']) < 1 and s5['st'] == 0 and s5['k'] == 1 and s5['dn'], s5)
        await box.locator('[data-mmz=in]').click(); await box.locator('[data-mmz=tog]').click(); await frames(pg)
        s6 = await pg.evaluate(STATE, SEL)
        check('closing the strip does too', not s6['on'] and s6['k'] == 1 and abs(s6['w'] - s1['w']) < 1, s6)

        # on the canvas, inside a card
        await pg.locator('#viewSeg [data-v=canvas]').click(); await frames(pg)
        await pg.locator('#cv .cnode[data-ctid=main] [data-cact=exp]').first.click()
        CSEL = '#cv .cnode[data-ctid=main] .mermaid-box'
        await pg.wait_for_function(f"!!document.querySelector('{CSEL} .mm-view svg')", timeout=20000)
        cb = pg.locator(CSEL); await cb.scroll_into_view_if_needed()
        pos0 = await pg.evaluate("(()=>{const n=document.querySelector('#cv .cnode[data-ctid=main]');return [n.offsetLeft,n.offsetTop]})()")
        await cb.hover(); await cb.locator('[data-mmz=tog]').click(); await cb.locator('[data-mmz=in]').click(); await frames(pg)
        c1 = await pg.evaluate(STATE, CSEL)
        pos1 = await pg.evaluate("(()=>{const n=document.querySelector('#cv .cnode[data-ctid=main]');return [n.offsetLeft,n.offsetTop]})()")
        check('in a canvas card: the strip zooms the diagram, and the card stays put', c1['on'] and c1['k'] == 1.5 and pos0 == pos1, [c1, pos0, pos1])
        cam0 = await pg.evaluate('JSON.stringify(__digress.conv.ui.cv&&__digress.conv.ui.cv.cam||null)')
        vb = await cb.locator('.mm-view').bounding_box()
        await pg.mouse.move(vb['x'] + vb['width'] / 2, vb['y'] + vb['height'] / 2); await pg.mouse.down()
        await pg.mouse.move(vb['x'] + vb['width'] / 2 - 70, vb['y'] + vb['height'] / 2 - 50, steps=4); await pg.mouse.up(); await frames(pg)
        c2 = await pg.evaluate(STATE, CSEL)
        pos2 = await pg.evaluate("(()=>{const n=document.querySelector('#cv .cnode[data-ctid=main]');return [n.offsetLeft,n.offsetTop]})()")
        print('canvas drag:', c1['sl'], c1['st'], '->', c2['sl'], c2['st'], pos1, pos2, cam0, await pg.evaluate('JSON.stringify(__digress.conv.ui.cv&&__digress.conv.ui.cv.cam||null)'))
        check('…and dragging it there moves the diagram (not the card or the canvas)', c2['sl'] > c1['sl'] + 30 and pos2 == pos1, [c1, c2, pos1, pos2])
        # a phone: no zoom strip (the browser's pinch-zoom does it); the height cap still applies
        ph = await b.new_page(viewport={'width': 390, 'height': 800}, is_mobile=True, has_touch=True)
        await ph.route('**/*', route); await ph.add_init_script(FAKE); await goto_app(ph); await booted(ph)
        await ph.evaluate("matchMedia('(hover:none) and (pointer:coarse)').matches") or check('(set up: the phone matches hover:none, pointer:coarse)', False)
        pta = ph.locator('.pane[data-tid=main] textarea'); await pta.fill('Draw the steps'); await answered(ph, pta.press('Enter'))
        await ph.wait_for_function(f"!!document.querySelector('{SEL} .mm-view svg')", timeout=20000)
        check('on a phone there is no zoom button (pinch-zoom the page instead)', not await ph.locator(SEL + ' [data-mmz=tog]').is_visible())
        check('…and the tall diagram still fits in 60% of the height', (await ph.locator(SEL + ' .mm-view').bounding_box())['height'] <= 0.6 * 800 + 2)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
