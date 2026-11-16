"""Themes and the prompts file.

The palette button lists the themes; hovering one previews it, clicking keeps it (also after a reload),
Escape closes the menu. The system prompt the model gets comes from web/prompts.js, including the line
asking it to link the pages it found with web search. Asserts and exits non-zero.
"""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, launch_args, goto_app, booted, answered, frames
from common import CORS

MAP = {'marked.min.js': ROOT + 'marked/marked.min.js', 'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
       'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js', 'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js'}
FAKE = r"""
window.__sys = [];
window.fakeLLM = { use: async (n) => n === 'sample' ? async (input, opts) => { window.__sys.push(input[0].content.split('\n\n---\n\n')[0]); return {text: 'Hi.', truncated: false}; } : null };
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:400])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 800}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE); await goto_app(pg); await booted(pg)
        var = lambda n: pg.evaluate(f"getComputedStyle(document.documentElement).getPropertyValue('{n}').trim()")
        theme = lambda: pg.evaluate('document.documentElement.dataset.theme')

        check('starts matching the device (light here)', await theme() == 'light' and await var('--bg') == '#f5f3ee', await theme())
        await pg.locator('#themeB').click(); await frames(pg)
        names = await pg.locator('.thmenu button').all_text_contents()
        check('the menu lists every theme', len(names) == 10 and any('Shades of Purple' in n for n in names) and any('Sand' in n for n in names), names)
        await pg.locator('.thmenu button[data-theme=gruvbox]').hover(); await frames(pg)
        check('hovering a theme previews it', await theme() == 'gruvbox' and await var('--bg') == '#1d2021')
        await pg.mouse.move(5, 400); await frames(pg)
        check('…and leaving the menu puts the kept one back', await theme() == 'light')
        await pg.locator('.thmenu button[data-theme=purple]').click(); await frames(pg)
        check('clicking keeps it, and it is dark', await theme() == 'purple' and await pg.evaluate('document.documentElement.dataset.mode') == 'dark'
              and await pg.locator('.thmenu button[data-theme=purple]').get_attribute('aria-checked') == 'true')
        sw = await pg.locator('.thmenu button[data-theme=sand] .thsw').evaluate("e=>getComputedStyle(e).backgroundColor")
        check('each swatch shows its own theme’s colors, not the current one', sw == 'rgb(233, 224, 207)', sw)
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Escape closes the menu', await pg.locator('.thmenu.open').count() == 0 and await theme() == 'purple')
        await pg.reload(); await booted(pg)
        check('the theme stays after a reload', await theme() == 'purple' and await var('--panel') == '#2d2b55')

        ta = pg.locator('.pane[data-tid="main"] textarea'); await ta.fill('hello'); await answered(pg, ta.press('Enter'))
        sys_ = await pg.evaluate('window.__sys[0]')
        want = await pg.evaluate('PROMPTS.system')
        check('the system prompt comes from web/prompts.js', sys_ == want and sys_.startswith('You are a patient, precise tutor'), (sys_ or '')[:200])
        check('…and asks for inline links to pages found with web search', 'cite it right where you use it, as a Markdown link' in sys_)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
