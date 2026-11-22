"""Fixing a reply: Redo asks again with the model and effort selected now, Edit changes the question and asks
again. Both make a new branch starting just before the question, beside the original, which stays as it was, the
same anywhere in a thread, the last question included (tests/test_versions.py). Use this version moves the branch onto
the main line, and the toast's "Delete the old version" removes the old one. Only a reply that failed is retried in
place. Also what a reply shows while it works (a
shimmering line, the time, the steps so far) and under it when done (model and effort). Asserts, exits non-zero.
"""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, settled, saved, changed, soon, frames
from common import CORS

MAP = {'marked.min.js': ROOT + 'marked/marked.min.js', 'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
       'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js', 'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js'}
FAKE = r"""
window.__n = 0;
window.fakeLLM = { use: async (n) => n === 'sample' ? async (msgs, opts) => {
  const q = msgs[msgs.length - 1].content.split('\n\n---\n\n').pop();
  window.__n++;
  if (q.includes('FAILONCE') && !window.__failed) { window.__failed = true; throw new Error('the model failed'); }
  if (q.includes('SLOW')) {
    opts.onSearch('tide tables'); await new Promise(r => setTimeout(r, 900));
    opts.onSearch('moon phases'); await new Promise(r => setTimeout(r, 2600));
  }
  return { text: `ANSWER model=${opts.model || 'default'} effort=${opts.effort || 'auto'} q=${q} n=${window.__n}`, truncated: false, modelApplied: opts.model || 'claude-opus-5-5' };
} : null };
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:400])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 850}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE); await goto_app(pg); await booted(pg)
        main = pg.locator('.pane[data-tid=main]')
        replies = main.locator('.msg.assistant'); qs = main.locator('.msg.user')
        ta = main.locator('textarea')

        await pg.select_option('#mSel', 'claude-haiku-5-5'); await pg.select_option('#eSel', 'high')
        await ta.fill('What is a tide?'); await answered(pg, ta.press('Enter'))
        r1 = await replies.first.inner_text()
        check('first reply, with the model picked by mistake', 'model=claude-haiku-5-5' in r1, r1)
        foot = await replies.first.locator('.model').inner_text()
        check('under the reply: the model and the effort', foot.strip() == 'Haiku 5.5 · High effort', foot)
        check('the latest reply can be redone', await replies.first.locator('[data-act=redo]').count() == 1)
        check('…and its question edited', await qs.first.locator('[data-act=edit]').count() == 1)

        threads = lambda: pg.evaluate("Object.keys(__digress.conv.threads).length")
        def newest(): return pg.evaluate("Object.values(__digress.conv.threads).filter(t=>t.alt).sort((a,b)=>b.created-a.created)[0]?.id||null")
        def reply_in(tid): return pg.evaluate("t => { const o = __digress.conv.order[t] || []; const m = o.map(id => __digress.conv.msgs[id]).filter(m => m.role === 'assistant').pop(); return m ? m.content : null }", tid)

        # Redo: a new branch with a fresh answer; the original stays
        await pg.select_option('#mSel', 'claude-opus-5-5'); await pg.select_option('#eSel', 'auto')
        n0 = await threads()
        await changed(pg, 'window.__n', replies.first.locator('[data-act=redo]').click()); await settled(pg)
        b1 = await newest()
        check('Redo asks again in a new branch, with the model selected now', await threads() == n0 + 1 and b1 and 'model=claude-opus-5-5' in (await reply_in(b1) or ''), [await threads(), b1])
        check('…and the original answer stays as it was', 'model=claude-haiku-5-5' in await replies.first.inner_text() and await replies.count() == 1)
        check('…the new branch opens beside it', await pg.locator(f'.pane[data-tid="{b1}"]').count() == 1)

        # Edit: the edited question goes to a new branch from just before it; the original stays
        await qs.first.hover(); await qs.first.locator('[data-act=edit]').click(); await main.locator('.uedit textarea').wait_for()
        box = main.locator('.uedit textarea')
        check('Edit opens the question for editing', await box.count() == 1 and await box.input_value() == 'What is a tide?')
        check('…saying it goes in a new branch (the last question too)', 'new branch' in await main.locator('.uedit .hint').inner_text())
        await box.press('Escape'); await frames(pg)
        check('Escape cancels, nothing changed', await main.locator('.uedit').count() == 0 and (await qs.first.locator('.body').inner_text()) == 'What is a tide?')
        await qs.first.hover(); await qs.first.locator('[data-act=edit]').click(); await box.wait_for()
        n0 = await threads()
        await box.fill('What causes spring tides?'); await changed(pg, 'window.__n', box.press('Enter')); await settled(pg)
        b2 = await newest()
        check('editing the last question asks it in a new branch', await threads() == n0 + 1 and 'q=What causes spring tides?' in (await reply_in(b2) or ''), [await threads(), b2])
        check('…the original question and answer stay', (await qs.first.locator('.body').inner_text()) == 'What is a tide?' and 'q=What is a tide?' in await replies.first.inner_text())
        check('…and so does the conversation’s title', (await pg.locator('#cTitle').inner_text()).strip() == 'What is a tide?')
        tip = "e => e.getAttribute('title') || e.dataset.tip || ''"   # hovering turns title= into data-tip=
        redo_t = lambda r: r.locator('[data-act=redo]').evaluate(tip)
        edit_t = lambda q: q.locator('[data-act=edit]').evaluate(tip)
        check('the buttons say so: a new branch, this stays', (await redo_t(replies.first)).startswith('Redo in a new branch') and 'new branch' in await edit_t(qs.first))

        # Use this version: the branch goes onto the main line; the old one, now a branch, can go in one click
        await pg.locator(f'.pane[data-tid="{b2}"] [data-usev]').first.click()
        await soon(pg, "() => [...document.querySelectorAll('.toast.show')].some(t => /Delete the old version/.test(t.textContent))")
        check('Use this version puts the edited question on the main line', (await qs.first.locator('.body').inner_text()) == 'What causes spring tides?')
        await pg.locator('#toast .tact').click(); await pg.wait_for_selector('#modal.show'); await pg.locator('#mOk').click(); await frames(pg, 4)
        check('…and “Delete the old version” removes the old one, keeping the new', not await pg.evaluate("t => !!__digress.conv.threads[t]", b2) and (await qs.first.locator('.body').inner_text()) == 'What causes spring tides?')

        # a reply that failed: Retry fills it in place (there's nothing to keep)
        await ta.fill('FAILONCE then answer'); await answered(pg, ta.press('Enter'))
        n0 = await threads()
        check('a failed reply offers Retry', await replies.last.locator('[data-act=retry]').count() == 1, await replies.last.inner_text())
        await changed(pg, 'window.__n', replies.last.locator('[data-act=retry]').click()); await settled(pg)
        check('…which answers in place, with no new branch', await threads() == n0 and 'q=FAILONCE' in await replies.last.inner_text())

        # while it works
        await ta.fill('SLOW what about the moon?'); await ta.press('Enter')
        # the fake searches "tide tables", 0.9 s later "moon phases", and answers 2.6 s after that
        await soon(pg, "() => [...document.querySelectorAll('.pane[data-tid=main] .msg.assistant')].at(-1).querySelector('.live .lhead')?.innerText.includes('moon phases')")
        live = replies.last.locator('.live')
        await pg.screenshot(path=OUT + '/redo-live.png')
        steps = await live.locator('.lsteps li').all_inner_texts() if await live.count() else []
        head = await live.locator('.lhead').inner_text() if await live.count() else ''
        check('while working: a shimmering line says what it is doing', await live.locator('.lhead .shimmer').count() == 1 and 'Searching the web for “moon phases”' in head, head)
        check('…with the steps so far listed under it', steps == ['Searched the web for “tide tables”'], steps)
        await soon(pg, r"() => /\d.*s\s*$/.test([...document.querySelectorAll('.pane[data-tid=main] .msg.assistant')].at(-1).querySelector('.live .lhead')?.innerText || '')")   # the timer shows up a moment in
        head = await live.locator('.lhead').inner_text() if await live.count() else ''
        check('…and the time so far, once it takes a moment', any(c.isdigit() for c in head) and head.rstrip().endswith('s'), head)
        await settled(pg)
        check('when done, the live view is gone and the answer is there', await replies.last.locator('.live').count() == 0 and 'q=SLOW' in await replies.last.inner_text())

        await pg.screenshot(path=OUT + '/redo-done.png')
        await saved(pg)
        await pg.reload(); await booted(pg)
        check('after a reload, the same buttons (a new branch, everywhere)', (await redo_t(replies.last)).startswith('Redo in a new branch') and (await redo_t(replies.first)).startswith('Redo in a new branch'))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
