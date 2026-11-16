"""A note saved by a web clipper (Obsidian Web Clipper's default template): its YAML front matter becomes
the title, byline and source link, instead of showing as a block of YAML. Asserts and exits non-zero.
"""
import asyncio, os, sys, tempfile
from playwright.async_api import async_playwright
from common import ROOT, launch_args, goto_app, booted, answered, soon
from common import CORS

MAP = {'marked.min.js': ROOT + 'marked/marked.min.js', 'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
       'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js', 'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js'}
FAKE = r"""
window.__sys = [];
window.fakeLLM = { use: async (n) => n === 'sample' ? async (input, opts) => { window.__sys.push(input[0].content.split('\n\n---\n\n')[0]); return {text: 'Hi.', truncated: false}; } : null };
"""
NOTE = '''---
title: "Why attention scales"
source: "https://example.com/blog/attention"
author:
  - "[[Ada Writer]]"
published: 2025-03-14
created: 2026-11-13
description: "A post about attention."
tags:
  - "clippings"
---
Attention compares every query with every key. The marker ZEBRA-CLIP is here.

## Scaling by the square root

More text.
'''
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:400])
    if not ok: fails.append(name)

async def main():
    tmp = tempfile.mkdtemp(); path = os.path.join(tmp, 'Why attention scales.md')
    open(path, 'w').write(NOTE)
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

        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', path)
        await pg.locator('#docGo').click(); await pg.wait_for_function("__digress.conv.doc&&(document.querySelector('.docbody')||{}).textContent?.includes('ZEBRA-CLIP')")
        body = pg.locator('.docbody'); text = await body.inner_text()
        check('the YAML block is gone from the document', 'clippings' not in text and 'created:' not in text and 'source:' not in text, text[:300])
        check('…the title is the heading, once', await body.locator('h1').count() == 1 and (await body.locator('h1').inner_text()).strip() == 'Why attention scales' and text.count('Why attention scales') == 1, text[:200])
        check('…with who wrote it, where and when (wiki-link brackets dropped)', 'Ada Writer · example.com · ' in text and '2025' in text and '[[' not in text, text[:200])
        check('the conversation is named after the note', (await pg.locator('.citem').first.text_content()).strip() == 'Why attention scales')

        ta = pg.locator('.pane[data-tid="main"] textarea'); await ta.fill('hello'); await answered(pg, ta.press('Enter'))
        s = await pg.evaluate('window.__sys[0]') or ''
        check('the model is told where it came from', 'from https://example.com/blog/attention)' in s, s[-1200:][:600])
        check('…and gets the text without the YAML', 'ZEBRA-CLIP' in s and 'clippings' not in s)

        # plain Markdown (no front matter) is untouched
        await pg.locator('#newDoc').click()
        await pg.locator('#docPaste').fill('---\n\nJust a rule above, not front matter.'); await pg.locator('#docGo').click(); await soon(pg, "() => (document.querySelector('.docbody')||{}).textContent?.includes('Just a rule above')")
        check('a document that only starts with a rule is left alone', 'Just a rule above' in await pg.locator('.docbody').inner_text())
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
