"""Tests for sidebar branch sorting (By place / By time + ascending/descending)
and auto-stacking adjacent collapsed panes into a single compact rail.
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, soon, frames

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
if (!sessionStorage.getItem('seeded')) {
  sessionStorage.setItem('seeded', '1');
  localStorage.setItem('fakesrv:convs/c_sort', JSON.stringify({
    id: 'c_sort', title: 'Sort & Stack', titleKept: true, created: 100, updated: 100, rev: 1,
    doc: { kind: 'text', name: 'paper.md', text: 'Page 1 alpha\n\nPage 2 beta\n\nPage 3 gamma' },
    threads: {
      main: { id: 'main', parent: null, title: 'Main', created: 100 },
      b_p5: { id: 'b_p5', parent: 'main', anchorMsg: 'DOC', anchorPage: 4, anchorRange: { s: 10, e: 20 }, anchorText: 'Fifth', title: 'Page 5 branch', colorIdx: 0, created: 200 },
      b_p1: { id: 'b_p1', parent: 'main', anchorMsg: 'DOC', anchorPage: 0, anchorRange: { s: 5, e: 12 }, anchorText: 'First', title: 'Page 1 branch', colorIdx: 1, created: 300 },
      b_p3: { id: 'b_p3', parent: 'main', anchorMsg: 'DOC', anchorPage: 2, anchorRange: { s: 8, e: 15 }, anchorText: 'Third', title: 'Page 3 branch', colorIdx: 2, created: 400 },
    },
    order: { main: ['u1', 'a1'], b_p5: ['u2'], b_p1: ['u3'], b_p3: ['u4'] },
    msgs: {
      u1: { id: 'u1', thread: 'main', role: 'user', content: 'Overview', ts: 100 },
      a1: { id: 'a1', thread: 'main', role: 'assistant', content: 'Summary reply', ts: 101 },
      u2: { id: 'u2', thread: 'b_p5', role: 'user', content: 'Q5', ts: 200 },
      u3: { id: 'u3', thread: 'b_p1', role: 'user', content: 'Q1', ts: 300 },
      u4: { id: 'u4', thread: 'b_p3', role: 'user', content: 'Q3', ts: 400 },
    },
  }));
  localStorage.setItem('fakesrv:layout/c_sort', JSON.stringify({
    devices: { other: { at: 100, ui: { open: ['main', 'b_p5', 'b_p1', 'b_p3'], collapsed: [], layout: 'cols', view: 'panes', sizes: {} } } },
  }));
}
"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, **launch_args())
        ctx = await b.new_context(viewport={'width': 1400, 'height': 850})
        pg = await ctx.new_page()
        await pg.add_init_script(SEED)
        await goto_app(pg)
        await booted(pg)
        await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_sort'")

        tree_ids = lambda: pg.evaluate("[...document.querySelectorAll('#tree .mnode[data-map]')].map(n => n.dataset.map)")

        # --- 1. Sidebar branch sort & direction ---
        check('default sort is By place ascending with Main first',
              await pg.locator('#treeSort').inner_text() == 'By place'
              and await pg.locator('#treeDir').inner_text() == '↑'
              and await tree_ids() == ['main', 'b_p1', 'b_p3', 'b_p5'],
              await tree_ids())

        await pg.locator('#treeDir').click(); await frames(pg)
        check('descending By place reverses document branches while keeping Main first',
              await pg.locator('#treeDir').inner_text() == '↓'
              and await tree_ids() == ['main', 'b_p5', 'b_p3', 'b_p1'],
              await tree_ids())

        await pg.locator('#treeSort').click(); await frames(pg)
        check('switching to By time (descending) puts newest created branch first',
              await pg.locator('#treeSort').inner_text() == 'By time'
              and await tree_ids() == ['main', 'b_p3', 'b_p1', 'b_p5'],
              await tree_ids())

        await pg.locator('#treeDir').click(); await frames(pg)
        check('By time ascending puts oldest created branch first',
              await pg.locator('#treeDir').inner_text() == '↑'
              and await tree_ids() == ['main', 'b_p5', 'b_p1', 'b_p3'],
              await tree_ids())

        # Reload verifies localStorage persistence
        await pg.reload()
        await booted(pg)
        await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_sort'")
        check('sort mode and direction persist across reload',
              await pg.locator('#treeSort').inner_text() == 'By time'
              and await pg.locator('#treeDir').inner_text() == '↑'
              and await tree_ids() == ['main', 'b_p5', 'b_p1', 'b_p3'],
              await tree_ids())

        # --- 2. Auto-stacking adjacent collapsed rails ---
        # Collapse b_p5 only -> stays a single .pane.rail
        await pg.locator('.pane[data-tid="b_p5"] [data-act="collapse"]').click(); await frames(pg)
        check('one collapsed pane stays a single strip',
              await pg.locator('#panes > .pane.rail').count() == 1
              and await pg.locator('#panes > .rail-stack').count() == 0)

        # Collapse adjacent b_p1 -> merges into one .rail-stack of 2
        await pg.locator('.pane[data-tid="b_p1"] [data-act="collapse"]').click(); await frames(pg)
        stack = pg.locator('#panes > .rail-stack')
        check('two adjacent collapsed panes auto-stack into one compact rail',
              await pg.locator('#panes > .pane.rail').count() == 0
              and await stack.count() == 1
              and await stack.get_attribute('data-stack') == 'b_p5,b_p1'
              and '2 collapsed' in await stack.inner_text(),
              await stack.inner_text() if await stack.count() else 'no stack')

        # Click stack -> opens popover; Esc closes it
        await stack.click(); await frames(pg)
        check('clicking stacked rail opens popover listing its panes',
              await pg.locator('.rspop').is_visible()
              and await pg.locator('.rspop .rsrow').count() == 2)
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Escape closes the stacked rail popover', await pg.locator('.rspop').count() == 0)

        # Reopen popover and expand just b_p5 -> b_p1 returns to a single strip
        await stack.click(); await frames(pg)
        await pg.locator('.rspop [data-rsexpand="b_p5"]').click(); await frames(pg)
        check('expanding one pane from the stack restores it and leaves the remaining one as a single strip',
              await pg.locator('#panes > .rail-stack').count() == 0
              and await pg.locator('#panes > .pane.rail[data-tid="b_p1"]').count() == 1
              and await pg.locator('#panes > .pane:not(.rail)[data-tid="b_p5"]').count() == 1)

        # Collapse others (Focus) on main -> b_p5, b_p1, b_p3 collapse into one stack of 3
        await pg.locator('.pane[data-tid="main"] [data-act="focus"]').click(); await frames(pg)
        check('Collapse others (Focus) stacks 3 adjacent collapsed panes into one rail',
              await stack.count() == 1
              and await stack.get_attribute('data-stack') == 'b_p5,b_p1,b_p3'
              and '3 collapsed' in await stack.inner_text())

        # Expand all from popover restores all panes
        await stack.click(); await frames(pg)
        await pg.locator('.rspop [data-unstack-all]').click(); await frames(pg)
        check('Expand all in stack popover expands every stacked pane',
              await pg.locator('#panes > .rail-stack').count() == 0
              and await pg.locator('#panes > .pane.rail').count() == 0
              and await pg.locator('#panes > .pane').count() == 4)

        await b.close()
    if fails:
        print('FAILED:', fails)
        sys.exit(1)

if __name__ == '__main__':
    asyncio.run(main())
