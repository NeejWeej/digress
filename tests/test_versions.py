"""Other versions of a question: Redo or Edit on a reply that can't be replaced (the conversation went on)
asks again in a new thread starting where the question did, without touching anything; the question shows
"N versions"; "Use this version" swaps which one the conversation goes on with (and back); branches can be
hidden from the tree. The saved conversation is checked with ThreadOps.check. Asserts, exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app

MAP = {'marked.min.js': ROOT + 'marked/marked.min.js', 'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
       'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js', 'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js'}
FAKE = r"""
window.__calls = [];
window.fakeLLM = { use: async (n) => n === 'sample' ? async (msgs, opts) => {
  window.__calls.push(msgs.map(m => m.content.split('\n\n---\n\n').pop()));
  const q = msgs[msgs.length - 1].content.split('\n\n---\n\n').pop();
  return { text: `ANSWER(${opts.model || 'default'}) to ${q}`, truncated: false, modelApplied: opts.model || 'claude-opus-5-5' };
} : null };
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:500])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 900}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE); await goto_app(pg); await pg.wait_for_timeout(1200)
        main = pg.locator('.pane[data-tid=main]'); ta = main.locator('textarea')
        qtexts = lambda pane: pane.locator('.msg.user .body').all_inner_texts()
        alts = pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])')
        async def saved():
            return await pg.evaluate("""() => { const k = Object.keys(localStorage).find(k => k.startsWith('fakesrv:convs/'));
              const c = JSON.parse(localStorage.getItem(k)); return {c, bad: ThreadOps.check(c, [])}; }""")

        await pg.select_option('#mSel', 'claude-haiku-5-5')
        await ta.fill('Q1 what is a tide?'); await ta.press('Enter'); await pg.wait_for_timeout(700)
        await ta.fill('Q2 and neap tides?'); await ta.press('Enter'); await pg.wait_for_timeout(700)
        await pg.select_option('#mSel', 'claude-opus-5-5')

        r1 = main.locator('.msg.assistant').first
        title = await r1.locator('[data-act=redo]').get_attribute('title')
        check('an earlier reply can still be redone, as another version', title.startswith('Redo as another version'), title)
        await r1.locator('[data-act=redo]').click(); await pg.wait_for_timeout(900)
        check('it opens beside, asking the same question with the model selected now', await alts.count() == 1 and await qtexts(alts.first) == ['Q1 what is a tide?'] and 'ANSWER(claude-opus-5-5) to Q1' in await alts.first.locator('.msg.assistant').inner_text())
        check('…and sees only what the original saw: no later messages, no side-question prefix', pg and (await pg.evaluate('window.__calls.at(-1)')) == ['Q1 what is a tide?'], await pg.evaluate('window.__calls.at(-1)'))
        check('nothing in the main thread changed', await qtexts(main) == ['Q1 what is a tide?', 'Q2 and neap tides?'] and 'claude-haiku-5-5' in await r1.inner_text())
        chip = main.locator('.msg.user').first.locator('.vchip')
        check('the question says it has 2 versions', await chip.count() == 1 and '2 versions' in await chip.inner_text())
        check('…and so does the version’s own question', '2 versions' in await alts.first.locator('.msg.user .vchip').inner_text())
        check('the version is labeled as one, with “Use this version”', 'another version' in await alts.first.locator('.ph-origin').inner_text() and await alts.first.locator('[data-usev]').count() == 1)
        check('it isn’t shown as a side-question chip on the reply before it', await main.locator('.bchip').count() == 0)

        # edit an earlier question: another version with the new text
        q1 = main.locator('.msg.user').first; await q1.hover(); await q1.locator('[data-act=edit]').click(); await pg.wait_for_timeout(200)
        hint = await main.locator('.uedit .hint').inner_text()
        check('editing an earlier question says it becomes another version', 'another version' in hint, hint)
        await main.locator('.uedit textarea').fill('Q1b why are there two tides a day?'); await main.locator('.uedit textarea').press('Enter'); await pg.wait_for_timeout(900)
        check('…and it does: a third version, main untouched', await alts.count() == 2 and await qtexts(main) == ['Q1 what is a tide?', 'Q2 and neap tides?'] and '3 versions' in await chip.inner_text())
        vb = pg.locator('.pane', has=pg.locator('.msg.user .body', has_text='Q1b'))
        vb_tid = await vb.get_attribute('data-tid')

        # use the edited version
        await vb.locator('[data-usev]').click(); await pg.wait_for_timeout(600)
        check('“Use this version”: the main thread now goes on with it', await qtexts(main) == ['Q1b why are there two tides a day?'], await qtexts(main))
        check('…and the old conversation moved into that pane, nothing lost', await qtexts(pg.locator(f'.pane[data-tid={vb_tid}]')) == ['Q1 what is a tide?', 'Q2 and neap tides?'])
        check('…the conversation title follows the question in use', (await pg.locator('#cTitle').inner_text()).strip() == 'Q1b why are there two tides a day?')
        s = await saved(); check('…and the saved conversation is well formed', not s['bad'], s['bad'])
        ta2 = main.locator('textarea'); await ta2.fill('Q3 follow-up'); await ta2.press('Enter'); await pg.wait_for_timeout(700)
        check('continuing in main now builds on the version in use', await pg.evaluate('window.__calls.at(-1)') == ['Q1b why are there two tides a day?', 'ANSWER(claude-opus-5-5) to Q1b why are there two tides a day?', 'Q3 follow-up'], await pg.evaluate('window.__calls.at(-1)'))
        await pg.locator(f'.pane[data-tid={vb_tid}] [data-usev]').click(); await pg.wait_for_timeout(600)
        check('using the other one swaps back', await qtexts(main) == ['Q1 what is a tide?', 'Q2 and neap tides?'] and await qtexts(pg.locator(f'.pane[data-tid={vb_tid}]')) == ['Q1b why are there two tides a day?', 'Q3 follow-up'])

        # hide a version from the tree
        row = pg.locator(f'.mnode[data-map="{vb_tid}"]'); await row.hover(); await row.locator('[data-hideb]').click(); await pg.wait_for_timeout(300)
        check('a hidden branch leaves the tree, with a way to show it', await pg.locator(f'.mnode[data-map="{vb_tid}"]').count() == 0 and 'Show 1 hidden branch' in await pg.locator('.showhid').inner_text())
        check('…the question still counts it among its versions', '3 versions' in await chip.inner_text())
        await pg.locator('.showhid').click(); await pg.wait_for_timeout(200)
        check('“show hidden” brings it back', await pg.locator(f'.mnode[data-map="{vb_tid}"]').count() == 1)

        await pg.screenshot(path=OUT + '/versions.png')
        await pg.wait_for_timeout(1000)   # saves are debounced
        await pg.reload(); await pg.wait_for_timeout(1500)
        got = [await qtexts(pg.locator('.pane[data-tid=main]')), await pg.locator('.pane[data-tid=main] .msg.user').first.locator('.vchip').all_inner_texts()]
        check('after a reload it all stays', got[0] == ['Q1 what is a tide?', 'Q2 and neap tides?'] and '3 versions' in ''.join(got[1]), got)
        s = await saved(); check('the saved conversation is well formed', not s['bad'], s['bad'])
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
