"""The model picker groups the models by who makes them (Anthropic, OpenAI), each group folding, so a long list is out
of the way: opened, the group with the current model is unfolded and the others folded; a folded group still says
which of its models is picked. In a group, the newest of each kind shows; earlier versions fold under Older (open when
the current model is one of them). Default stays at the top. Picking sets the hidden <select> (#mSel) as before. With
only one family, it's a plain list.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

GPT = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']] + [[m, m.upper()] for m in GPT]
LATEST = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna']   # the newest of each kind
FAKE = "window.fakeLLM = {use: async () => async (m, o) => ({text: 'ok'})};"
# the fake server lists only Claude models unless told otherwise: both families
MODELS_JS = "window.fakeModels = %s;"
import json
GROUPS = "[...document.querySelectorAll('.mmenu .thgrp')].map(g => [g.dataset.g, g.getAttribute('aria-expanded'), g.querySelector('.thcur').textContent, g.querySelector('.mcount').textContent])"
VISIBLE = "[...document.querySelectorAll('.mmenu button[data-model]')].filter(b => b.offsetParent).map(b => b.dataset.model)"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        pg = await b.new_page(viewport={'width': 1440, 'height': 860}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE + MODELS_JS % json.dumps(MODELS))
        await goto_app(pg); await booted(pg)
        await pg.wait_for_function("document.querySelectorAll('#mSel option').length > 5")
        check('the button shows the current model', 'Default' in await pg.locator('#mPick').inner_text(), await pg.locator('#mPick').inner_text())
        await pg.locator('#mPick').click(); await frames(pg)
        check('opening it shows Default, then Anthropic and OpenAI', await pg.evaluate("[...document.querySelectorAll('.mmenu > button:not(.mconn), .mmenu > .thgrp')].map(b => b.dataset.model || b.dataset.g)") == ['auto', 'claude', 'gpt'])
        check('…and Connections… at the bottom', await pg.locator('.mmenu > .mconn').count() == 1)
        g = await pg.evaluate(GROUPS)
        check('Default (not yet known which model): the first group, Anthropic, open; OpenAI folded (with its count)', g == [['claude', 'true', '', '2'], ['gpt', 'false', '', '10']], g)
        check('…so OpenAI’s 10 models aren’t in the way', await pg.evaluate(VISIBLE) == ['auto', 'claude-opus-5-5', 'claude-haiku-5-5'], await pg.evaluate(VISIBLE))
        await pg.screenshot(path=OUT + '/model_menu.png')
        await pg.locator('.mmenu .thgrp[data-g=gpt]').click(); await frames(pg)
        vis = await pg.evaluate(VISIBLE)
        check('unfolding OpenAI shows the newest of each kind, not every version', [v for v in vis if v.startswith('gpt')] == LATEST, vis)
        check('…with the rest under “Older (6)”', (await pg.locator('.mmenu .thgrp[data-g=gpt] + .thlist .molder').inner_text()).split() == ['Older', '6'])
        await pg.screenshot(path=OUT + '/model_menu_openai.png')
        await pg.locator('.mmenu .thgrp[data-g=gpt] + .thlist .molder').click(); await frames(pg)
        check('Older unfolds the earlier versions', len([v for v in await pg.evaluate(VISIBLE) if v.startswith('gpt')]) == 10)
        await pg.locator('.mmenu button[data-model="gpt-6-sol"]').click(); await frames(pg)
        check('picking one sets the model and closes the menu', await pg.evaluate("document.getElementById('mSel').value") == 'gpt-6-sol' and not await pg.locator('.mmenu.open').count() and 'GPT-6-SOL' in await pg.locator('#mPick').inner_text())
        await pg.locator('#mPick').click(); await frames(pg)
        g = await pg.evaluate(GROUPS)
        check('opened again: OpenAI (the current one’s) open, Anthropic folded', [x[:2] for x in g] == [['claude', 'false'], ['gpt', 'true']], g)
        check('…and its Older open, since the current model is an older one', await pg.locator('.mmenu .thgrp[data-g=gpt] + .thlist .molder').get_attribute('aria-expanded') == 'true')
        check('Anthropic has nothing older, so no Older row', await pg.locator('.mmenu .thgrp[data-g=claude] + .thlist .molder').count() == 0)
        await pg.locator('.mmenu .thgrp[data-g=gpt]').click(); await frames(pg)
        check('a folded group still says which of its models is picked', (await pg.evaluate(GROUPS))[1][2] == 'GPT-6-SOL', await pg.evaluate(GROUPS))
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Esc closes it', not await pg.locator('.mmenu.open').count())
        await pg.select_option('#mSel', 'claude-haiku-5-5'); await frames(pg)
        check('setting the <select> directly updates the button too', 'Haiku' in await pg.locator('#mPick').inner_text(), await pg.locator('#mPick').inner_text())
        await pg.locator('#mPick').click(); await frames(pg); await pg.mouse.click(700, 600); await frames(pg)
        check('a click elsewhere closes it', not await pg.locator('.mmenu.open').count())
        await pg.close()

        # one family: a plain list
        pg = await b.new_page(viewport={'width': 1440, 'height': 860}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE); await goto_app(pg); await booted(pg)
        await pg.wait_for_function("document.querySelectorAll('#mSel option').length > 2")
        await pg.locator('#mPick').click(); await frames(pg)
        check('with one family, no groups: a plain list', await pg.locator('.mmenu .thgrp').count() == 0 and len(await pg.evaluate(VISIBLE)) >= 3)
        # on a phone it's in the ⋯ menu and still opens
        await pg.close()
        pg = await b.new_page(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE + MODELS_JS % json.dumps(MODELS)); await goto_app(pg); await booted(pg)
        await pg.wait_for_function("document.querySelectorAll('#mSel option').length > 5")
        if not await pg.locator('#mPick').is_visible():
            await pg.locator('#moreB').click(); await frames(pg)
        await pg.locator('#mPick').click(); await frames(pg)
        box = await pg.locator('.mmenu').bounding_box()
        check('on a phone it opens on screen', box and box['x'] >= 0 and box['x'] + box['width'] <= 390 and box['y'] + box['height'] <= 800, box)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
