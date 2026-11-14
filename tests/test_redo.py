"""Fixing a reply: Redo asks again with the model and effort selected now, Edit changes the question and asks
again. In place only while nothing depends on that reply (it's the thread's last, no branch starts from it,
no flashcard came from it); otherwise they make another version (tests/test_versions.py). Also what a reply shows while it works (a
shimmering line, the time, the steps so far) and under it when done (model and effort). Asserts, exits non-zero.
"""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, settled, saved, changed, soon, frames

MAP = {'marked.min.js': ROOT + 'marked/marked.min.js', 'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
       'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js', 'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js'}
FAKE = r"""
window.__n = 0;
window.fakeLLM = { use: async (n) => n === 'sample' ? async (msgs, opts) => {
  const q = msgs[msgs.length - 1].content.split('\n\n---\n\n').pop();
  window.__n++;
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
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
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

        # redo with the right model
        await pg.select_option('#mSel', 'claude-opus-5-5'); await pg.select_option('#eSel', 'auto')
        await changed(pg, 'window.__n', replies.first.locator('[data-act=redo]').click()); await settled(pg)   # asked again, and answered
        r1 = await replies.first.inner_text()
        check('Redo asks again with the model selected now, replacing the reply', 'model=claude-opus-5-5' in r1 and await replies.count() == 1, r1)
        check('…and the footer says so', (await replies.first.locator('.model').inner_text()).strip() == 'Opus 5.5 · auto effort')

        # edit the question
        await qs.first.hover(); await qs.first.locator('[data-act=edit]').click(); await main.locator('.uedit textarea').wait_for()
        box = main.locator('.uedit textarea')
        check('Edit opens the question for editing', await box.count() == 1 and await box.input_value() == 'What is a tide?')
        await box.press('Escape'); await frames(pg)
        check('Escape cancels, nothing changed', await main.locator('.uedit').count() == 0 and (await qs.first.locator('.body').inner_text()) == 'What is a tide?')
        await qs.first.hover(); await qs.first.locator('[data-act=edit]').click(); await box.wait_for()
        await box.fill('What causes spring tides?'); await changed(pg, 'window.__n', box.press('Enter')); await settled(pg)
        r1 = await replies.first.inner_text()
        check('Enter sends the edited question and replaces the reply', 'q=What causes spring tides?' in r1 and await qs.count() == 1 and await replies.count() == 1, r1)
        check('…the question shows the new text', (await qs.first.locator('.body').inner_text()) == 'What causes spring tides?')
        check('…and the conversation title, taken from it, follows', (await pg.locator('#cTitle').inner_text()).strip() == 'What causes spring tides?')

        # once the conversation goes on, the earlier ones are fixed
        await ta.fill('And neap tides?'); await answered(pg, ta.press('Enter'))
        tip = "e => e.getAttribute('title') || e.dataset.tip || ''"   # hovering turns title= into data-tip=
        redo_t = lambda r: r.locator('[data-act=redo]').evaluate(tip)
        edit_t = lambda q: q.locator('[data-act=edit]').evaluate(tip)
        check('after a follow-up, the earlier reply and question can only be redone/edited as another version (test_versions.py)',
              (await redo_t(replies.first)).startswith('Redo as another version') and 'another version' in await edit_t(qs.first))
        check('…the new ones in place', (await redo_t(replies.nth(1))).startswith('Redo: ') and 'replaces the reply' in await edit_t(qs.nth(1)))

        # a branch from the latest reply: no more redo there
        await replies.nth(1).locator('[data-act=wbranch]').click(); await pg.wait_for_function('Object.keys(__digress.conv.threads).length > 1'); await frames(pg)
        check('a branch from a reply means it can’t be redone in place (the branch would lose its start)',
              (await redo_t(replies.nth(1))).startswith('Redo as another version') and 'another version' in await edit_t(qs.nth(1)))

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
        check('after a reload, the same buttons (in place only for the last reply)', (await redo_t(replies.last)).startswith('Redo: ') and (await redo_t(replies.first)).startswith('Redo as another version'))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
