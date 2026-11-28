"""Two adjacent collapsed panes fold into one .rail-stack, which layout() makes anew each time. Panes after it
must not be moved by that (moving an element resets its scroll): a long, scrolled branch keeps its place when a
document reference in it opens the document. Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, soon, frames

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

LONG = '\n\n'.join(f'Paragraph {i} of a long answer, see [part 2] for the detail.' for i in range(60))
CONV = {
    'id': 'c_stack', 'title': 'Stack scroll', 'titleKept': True, 'created': 100, 'updated': 100, 'rev': 1,
    'doc': {'kind': 'text', 'name': 'paper.md', 'text': 'Page 1 alpha\n\nPage 2 beta\n\nPage 3 gamma'},
    'threads': {
        'main': {'id': 'main', 'parent': None, 'title': 'Main', 'created': 100},
        'ba': {'id': 'ba', 'parent': 'main', 'title': 'Branch A', 'colorIdx': 0, 'created': 200},
        'bb': {'id': 'bb', 'parent': 'main', 'title': 'Branch B', 'colorIdx': 1, 'created': 300},
    },
    'order': {'main': ['u1'], 'ba': ['u2'], 'bb': ['u3', 'a3']},
    'msgs': {
        'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'Overview', 'ts': 100},
        'u2': {'id': 'u2', 'thread': 'ba', 'role': 'user', 'content': 'QA', 'ts': 200},
        'u3': {'id': 'u3', 'thread': 'bb', 'role': 'user', 'content': 'QB', 'ts': 300},
        'a3': {'id': 'a3', 'thread': 'bb', 'role': 'assistant', 'content': LONG, 'ts': 301},
    },
}
SEED = "if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" \
    "localStorage.setItem('fakesrv:convs/c_stack',%s);" \
    "localStorage.setItem('fakesrv:layout/c_stack',%s);}" % (
        json.dumps(json.dumps(CONV)),
        json.dumps(json.dumps({'devices': {'other': {'at': 100, 'ui': {'open': ['main', 'ba', 'bb'], 'collapsed': ['main', 'ba'], 'layout': 'cols', 'view': 'panes', 'sizes': {}}}}})))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, **launch_args())
        pg = await (await b.new_context(viewport={'width': 1400, 'height': 850})).new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(SEED)
        await goto_app(pg); await booted(pg)
        await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_stack'")
        await pg.wait_for_selector('#panes > .rail-stack')
        pb = pg.locator('.pane[data-tid="bb"] .pb')
        await pg.wait_for_function("(()=>{const p=document.querySelector('.pane[data-tid=\"bb\"] .pb');return p&&p.scrollHeight>p.clientHeight+500&&p.querySelector('a.pref[data-part]')})()")
        check('two adjacent collapsed panes are one stack before a long pane', await pg.locator('#panes > .rail-stack').get_attribute('data-stack') == 'main,ba')
        await pb.evaluate("p=>{p.scrollTop=600}"); await frames(pg)
        before = await pb.evaluate("p=>p.scrollTop")
        check('(the pane is scrolled down)', before > 300, before)
        await pg.evaluate("document.querySelector('.pane[data-tid=\"bb\"] .pb a.pref[data-part]').click()")
        await pg.wait_for_selector('.docpane'); await frames(pg, 3)
        after = await pg.locator('.pane[data-tid="bb"] .pb').evaluate("p=>p.scrollTop")
        check('a document reference opening the document leaves the pane after the stack where it was', abs(after - before) < 2, (before, after))
        check('no page errors', not errs, errs[:3])
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
