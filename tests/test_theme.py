"""Themes and the prompts file.

The palette button lists the themes; hovering one previews it, clicking keeps it (also after a reload; a theme that was taken out opens as the closest kept one),
Escape closes the menu. The system prompt the model gets comes from web/prompts.js, including the line
asking it to link the pages it found with web search. Asserts and exits non-zero.
"""
import asyncio, sys
from playwright.async_api import async_playwright
from common import OUT, ROOT, launch_args, goto_app, booted, answered, frames, quiet
from common import CORS

MAP = {'marked.min.js': ROOT + 'marked/marked.min.js', 'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
       'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js', 'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js'}
FAKE = r"""
window.__sys = [];
window.fakeLLM = { use: async (n) => n === 'sample' ? async (input, opts) => { window.__sys.push(input[0].content.split('\n\n---\n\n')[0]); return {text: 'Hi.', truncated: false}; } : null };
"""
UNFOLD = "document.querySelectorAll('.thmenu.open .thgrp[aria-expanded=false]').forEach(b=>b.click())"   # open every section of the theme menu
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
        names = await pg.locator('.thmenu button[data-theme]').all_text_contents()   # (the PDF pages looks follow: test_pdf_look.py)
        check('the menu lists every theme', len(names) == await pg.evaluate('THEMES.length') and any('Shades of Purple' in n for n in names) and any('Sand' in n for n in names), names)
        check('…Rainforest among them, day and night', any('Rainforest Day' in n for n in names) and any('Rainforest Night' in n for n in names), names)
        groups = await pg.evaluate("[...document.querySelectorAll('.thmenu.open .thgrp')].map(h=>[h.dataset.g,h.getAttribute('aria-expanded')])")
        check('in sections: Light, Dark, PDF pages, Font; only the one holding the current theme open', groups == [['light', 'true'], ['dark', 'false'], ['pdf', 'false'], ['font', 'false']], groups)
        check('…a folded one shows a dot per choice and its picked one', await pg.locator('.thgrp[data-g=dark] .thdot').count() == await pg.evaluate("THEMES.filter(t=>t[2]==='dark').length")
              and await pg.locator('.thgrp[data-g=pdf] .thcur').inner_text() == 'Original' and not await pg.locator('.thmenu button[data-theme=gruvbox]').is_visible())
        await pg.locator('.thgrp[data-g=dark]').click(); await frames(pg)
        check('clicking a section’s header opens it', await pg.locator('.thmenu button[data-theme=gruvbox]').is_visible() and await pg.locator('.thmenu.open').count() == 1)
        await pg.locator('.thmenu button[data-theme=gruvbox]').hover(); await frames(pg)
        check('hovering a theme previews it', await theme() == 'gruvbox' and await var('--bg') == '#1d2021')
        await pg.locator('.thgrp[data-g=dark]').hover(); await frames(pg)
        check('…moving off it onto a section’s header (still in the menu) puts the kept one back', await theme() == 'light', await theme())
        await pg.locator('.thmenu button[data-theme=gruvbox]').hover(); await frames(pg)
        await pg.mouse.move(5, 400); await frames(pg)
        check('…and so does leaving the menu', await theme() == 'light')
        await pg.locator('.thmenu button[data-theme=purple]').click(); await frames(pg)
        check('clicking keeps it, and it is dark', await theme() == 'purple' and await pg.evaluate('document.documentElement.dataset.mode') == 'dark'
              and await pg.locator('.thmenu button[data-theme=purple]').get_attribute('aria-checked') == 'true')
        sw = await pg.locator('.thmenu button[data-theme=sand] .thsw').evaluate("e=>getComputedStyle(e).backgroundColor")
        check('each swatch shows its own theme’s colors, not the current one', sw == 'rgb(233, 224, 207)', sw)
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Escape closes the menu', await pg.locator('.thmenu.open').count() == 0 and await theme() == 'purple')
        await pg.reload(); await booted(pg)
        check('the theme stays after a reload', await theme() == 'purple' and await var('--panel') == '#2d2b55')
        # a theme's optional dressing (backdrop, edges, pane header): only where the theme sets it
        dress = "(t)=>{applyTheme(t);const q=(x,p)=>getComputedStyle(document.querySelector(x))[p];return [q('.top','borderBottomWidth'),q('.stage','backgroundImage')!=='none',q('.pane>.ph','backgroundColor')]}"
        plain, fancy = await pg.evaluate(dress, 'light'), await pg.evaluate(dress, 'columbia')
        check('a plain theme keeps the plain edges, no backdrop', plain[0] == '1px' and not plain[1] and plain[2] == 'rgba(0, 0, 0, 0)', plain)
        check('a dressed theme (Columbia) gets its brass edge, sky and tinted pane headers', fancy[0] == '3px' and fancy[1] and fancy[2] != 'rgba(0, 0, 0, 0)', fancy)
        await pg.evaluate("applyTheme('purple')")
        # a theme that was taken out: a saved choice of it opens the closest kept one, and is saved as that
        await pg.evaluate("const s=JSON.parse(localStorage.getItem('sq:settings')||'{}');s.theme='frappe';localStorage.setItem('sq:settings',JSON.stringify(s))")
        await pg.reload(); await booted(pg)
        check('a retired theme (Frappé) opens as the closest kept one (Mocha), and is saved as that', await theme() == 'mocha'
              and await pg.evaluate("JSON.parse(localStorage.getItem('sq:settings')).theme") == 'mocha', await theme())
        await pg.evaluate("const s=JSON.parse(localStorage.getItem('sq:settings'));s.theme='purple';localStorage.setItem('sq:settings',JSON.stringify(s))")
        await pg.reload(); await booted(pg)
        await pg.locator('#themeB').click(); await frames(pg)
        check('opened again, the Dark section (holding Shades of Purple) is the open one', await pg.evaluate("[...document.querySelectorAll('.thmenu.open .thgrp[aria-expanded=true]')].map(h=>h.dataset.g)") == ['dark'])
        await pg.keyboard.press('Escape')
        # a short phone screen: the menu stays on screen and scrolls, everything open
        await pg.set_viewport_size({'width': 390, 'height': 520}); await frames(pg)
        tb = '.tmore #themeB' if not await pg.locator('.top #themeB').is_visible() else '#themeB'
        if tb != '#themeB': await pg.locator('#moreB').click(); await frames(pg)
        await pg.locator(tb).click(); await frames(pg); await pg.evaluate(UNFOLD); await frames(pg)
        box = await pg.evaluate("(()=>{const m=document.querySelector('.thmenu.open'),r=m.getBoundingClientRect();return {top:r.top,bottom:r.bottom,vh:innerHeight,sh:m.scrollHeight,ch:m.clientHeight}})()")
        check('on a short screen the open menu fits the screen', box['top'] >= 0 and box['bottom'] <= box['vh'], box)
        check('…and scrolls to show the rest', box['sh'] > box['ch'], box)
        await pg.locator('.thmenu.open button[data-pdf=sepia]').scroll_into_view_if_needed()
        check('…down to the last choice', await pg.locator('.thmenu.open button[data-pdf=sepia]').is_visible())
        await pg.screenshot(path=OUT + '/theme_menu_phone.png')
        await pg.keyboard.press('Escape'); await pg.set_viewport_size({'width': 1300, 'height': 800}); await frames(pg)

        # fonts: hovering previews on the page but never moves the menu's rows (it once swapped back and forth under the pointer)
        font = lambda: pg.evaluate('document.documentElement.dataset.font')
        await pg.locator('#themeB').click(); await frames(pg)
        await pg.locator('.thgrp[data-g=font]').click(); await frames(pg)
        rows = "[...document.querySelectorAll('.thmenu.open button[data-font]')].map(b=>[b.offsetTop,b.offsetHeight,b.offsetWidth])"   # within the menu (hovering may scroll it)
        before = await pg.evaluate(rows); body_font = "getComputedStyle(document.querySelector('.thmenu.open button[data-font=mono]')).fontFamily"
        menu_font = await pg.evaluate(body_font)
        await pg.locator('.thmenu.open button[data-font=mono]').hover(); await frames(pg)
        reply_font = await pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--serif')")
        check('hovering a font previews it on the page', await font() == 'mono' and 'JetBrains Mono' in reply_font, [await font(), reply_font])
        check('…while the menu keeps its own font and its rows stay put', await pg.evaluate(body_font) == menu_font and await pg.evaluate(rows) == before)
        await pg.locator('.thgrp[data-g=font]').hover(); await frames(pg)
        check('…and moving off it puts the chosen font back', await font() == 'default')
        await pg.locator('.thmenu.open button[data-font=literata]').click(); await frames(pg)
        check('clicking a font keeps it, and a web font’s stylesheet is loaded only now', await font() == 'literata'
              and await pg.evaluate("[...document.querySelectorAll('link[data-fontcss]')].some(l=>l.dataset.fontcss.includes('/literata@'))"))
        await pg.keyboard.press('Escape'); await quiet(pg); await pg.reload(); await booted(pg)
        check('the font stays after a reload', await font() == 'literata')

        ta = pg.locator('.pane[data-tid="main"] textarea'); await ta.fill('hello'); await answered(pg, ta.press('Enter'))
        sys_ = await pg.evaluate('window.__sys[0]')
        want = await pg.evaluate(r'PROMPTS.system + "\n\n" + PROMPTS.howDigress')
        check('the system prompt comes from web/prompts.js', sys_ == want and sys_.startswith('You are a tutor who loves these ideas'), (sys_ or '')[:200])
        check('…and asks for inline links to pages found with web search', 'cite it right where you use it, as a Markdown link' in sys_)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
