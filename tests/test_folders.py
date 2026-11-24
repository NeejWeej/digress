"""Folders in the sidebar.
  - With no folders the Folders section is still there: an empty list and a New folder row between its heading and
    the Conversations heading; folding the section hides the row too, and the dialog still opens from it.
  - A row's folder button opens a menu; New folder opens a dialog (name box, list of conversations with the row's
    ticked; Create is off without a name or without a ticked one, and says "Add to folder" for an existing name).
    The conversation moves out of the plain list into the folder, and the Folders section appears. The Conversations
    heading's New folder button opens the same dialog; several can be ticked. Archive is in the menu.
  - The Folders section folds as a whole; each folder folds too (remembered on this device, across a reload).
  - Filing into a folder that's folded opens it. A second conversation can go into the same folder from the menu.
  - Rename a folder from its header (every conversation in it follows); "Take out" puts one back in the list;
    removing a folder puts all of its conversations back and deletes nothing.
  - A filed conversation stays in the Conversations list (same order) with a tag naming its folder; a long folder name
    is cut with an ellipsis and leaves room for the title. The tag follows a rename and goes when it is taken out.
  - The folder is saved with the conversation (the store has it), the open one included.
  - On a phone the row's buttons are always there: the same steps work with taps.
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon, settle, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

SEED = r"""
for (let i = 0; i < 6; i++) {
  const id = 'c' + i, t = Date.now() - i * 60000;
  localStorage.setItem('fakesrv:convs/' + id, JSON.stringify({id, title: i == 5 ? 'A rather long conversation title about many different things at once' : 'Topic ' + i, created: t, updated: t, rev: 1,
    threads: {main: {id: 'main', parent: null, title: 'Main', colorIdx: 0}},
    msgs: {u: {role: 'user', thread: 'main', text: 'Question ' + i, ts: t}}, order: {main: ['u']}, nextColor: 1}));
}
"""

STORED = "(id)=>{const v=localStorage.getItem('fakesrv:convs/'+id);return v?JSON.parse(v).folder||'':null}"
IN_FOLDER = "([name])=>[...document.querySelectorAll('#flist .fgrp')].filter(g=>g.dataset.folder===name).flatMap(g=>[...g.querySelectorAll('.fbody .citem[data-conv]')].map(r=>r.dataset.conv))"
TAG = "(id)=>{const t=document.querySelector('#clist .citem[data-conv='+id+'] .ftag');return t?t.textContent:null}"
PLAIN = "[...document.querySelectorAll('#clist .citem[data-conv]')].map(r=>r.dataset.conv)"


async def file_into(pg, cid, name=None):
    await pg.locator(f'#clist .citem[data-conv={cid}]').hover()
    await pg.locator(f'#clist .citem[data-conv={cid}] [data-folderconv]').click()
    menu = pg.locator('#folderMenu.open'); await menu.wait_for()
    if name == '':
        await menu.locator('[data-fm=out]').click()
    else:
        await menu.locator(f'[data-fm="f:{name}"]').click()
    await frames(pg)


async def dialog_create(pg, name, tick=(), untick=()):
    """In the open New folder dialog: tick/untick rows by id, type the name, press OK."""
    for cid in tick: await pg.locator(f'#nfList input[value={cid}]').check()
    for cid in untick: await pg.locator(f'#nfList input[value={cid}]').uncheck()
    await pg.locator('#nfName').fill(name)
    await pg.locator('#mOk').click()
    await soon(pg, "()=>!document.querySelector('#modal.show')")
    await frames(pg)


async def desktop(p):
    b = await p.chromium.launch(**launch_args())
    pg = await b.new_page(viewport={'width': 1280, 'height': 800})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}")
    await goto_app(pg); await booted(pg)
    await pg.wait_for_function("document.querySelectorAll('#clist .citem[data-conv]').length >= 6"); await frames(pg)
    check('no folders: the Folders section is there', await pg.locator('#foldWrap').is_visible())
    check('…its list is empty', await pg.evaluate("document.getElementById('flist').children.length") == 0)
    check('…and New folder is visible in it, between the two headings', await pg.locator('#foldWrap #newFolder').is_visible() and await pg.evaluate(
        "(()=>{const a=document.querySelector('#foldWrap .sh').getBoundingClientRect(),n=document.getElementById('newFolder').getBoundingClientRect(),c=document.querySelector('#convWrap .sh').getBoundingClientRect();return a.bottom<=n.top+1&&n.bottom<=c.top+1})()"))
    await pg.screenshot(path=OUT + '/folders_empty.png')
    await pg.locator('#foldWrap .sfold').click(); await frames(pg)
    check('folding the section hides New folder', not await pg.locator('#newFolder').is_visible())
    await pg.locator('#foldWrap .sfold').click(); await frames(pg)
    await pg.locator('#newFolder').click(); await pg.locator('#modal.show #nfName').wait_for()
    check('the dialog opens from it', True)
    await pg.locator('#mCancel').click(); await soon(pg, "()=>!document.querySelector('#modal.show')")

    # first folder: the menu's New folder opens the dialog (nothing auto-opens when there are no folders)
    await pg.locator('#clist .citem[data-conv=c2]').hover()
    await pg.locator('.citem[data-conv=c2] [data-folderconv]').click()
    await pg.locator('#folderMenu.open [data-fm=new]').click()
    await pg.locator('#modal.show #nfName').wait_for(); await frames(pg)
    check('the menu closed when the dialog opened', not await pg.locator('#folderMenu.open').count())
    check("the dialog has the row's conversation ticked, first", await pg.evaluate("[...document.querySelectorAll('#nfList input:checked')].map(x=>x.value)") == ['c2']
          and await pg.evaluate("document.querySelector('#nfList input').value") == 'c2')
    check('OK is off with an empty name', await pg.locator('#mOk').is_disabled())
    await pg.locator('#nfName').fill('Statistics')
    check('OK is on with a name and a ticked conversation', await pg.locator('#mOk').is_enabled())
    check('OK says Create folder', (await pg.locator('#mOk').text_content()).strip() == 'Create folder')
    await pg.locator('#nfList input[value=c2]').uncheck()
    check('OK is off with nothing ticked', await pg.locator('#mOk').is_disabled())
    check('…and the hint says why', 'at least one' in (await pg.locator('#nfHint').text_content()))
    await pg.locator('#nfList input[value=c2]').check()
    await pg.locator('#nfName').fill('')
    await pg.locator('#nfName').type('Stat')
    check('typing shows in the name box', await pg.locator('#nfName').input_value() == 'Stat')
    nb = await pg.locator('#nfName').bounding_box()
    check('the name box is wide', nb['width'] > 250, nb)
    await settle(pg, 300)
    await pg.screenshot(path=OUT + '/folders_dialog.png')
    await pg.locator('#nfName').fill('  Statistics  '); await pg.locator('#nfName').press('Enter')
    await soon(pg, "()=>document.querySelector('#foldWrap').offsetParent!==null&&!document.querySelector('#modal.show')")
    check('Enter in the name box creates it', not await pg.locator('#modal.show').count())
    check('the conversation is in the folder', await pg.evaluate(IN_FOLDER, ['Statistics']) == ['c2'])
    check('…and still in the Conversations list', 'c2' in await pg.evaluate(PLAIN))
    check('…with a tag naming the folder', await pg.evaluate(TAG, 'c2') == 'Statistics', await pg.evaluate(TAG, 'c2'))
    check('an unfiled row has no tag', await pg.evaluate(TAG, 'c1') is None)
    await soon(pg, f"()=>({STORED})('c2')==='Statistics'")
    check('…saved with it (name trimmed)', await pg.evaluate(STORED, 'c2') == 'Statistics')

    # the open one (c0 is open at start) goes in too, through the menu's list
    open_id = await pg.evaluate("__digress.conv.id")
    await file_into(pg, open_id, 'Statistics')
    check('the open conversation can be filed', open_id in await pg.evaluate(IN_FOLDER, ['Statistics']), await pg.evaluate(IN_FOLDER, ['Statistics']))
    await soon(pg, f"()=>({STORED})('{open_id}')==='Statistics'")
    check('…and is saved with its folder', await pg.evaluate(STORED, open_id) == 'Statistics')
    await pg.locator('#newFolder').click()
    await pg.locator('#modal.show #nfName').wait_for()
    check('the heading button opens the dialog, nothing ticked unless the open one is free', await pg.evaluate("[...document.querySelectorAll('#nfList input:checked')].map(x=>x.value)") == [])
    await dialog_create(pg, 'Art', tick=['c3'])
    check('a second folder', await pg.evaluate(IN_FOLDER, ['Art']) == ['c3'])
    await pg.locator('#newFolder').click(); await pg.locator('#modal.show #nfName').wait_for()
    await dialog_create(pg, 'Music', tick=['c1', 'c4'])
    check('two ticked conversations are both filed', sorted(await pg.evaluate(IN_FOLDER, ['Music'])) == ['c1', 'c4'], await pg.evaluate(IN_FOLDER, ['Music']))
    await soon(pg, f"()=>({STORED})('c1')==='Music'&&({STORED})('c4')==='Music'")
    check('…and both are saved with it', True)
    check('folders are in name order', await pg.evaluate("[...document.querySelectorAll('#flist .fgrp')].map(g=>g.dataset.folder)") == ['Art', 'Music', 'Statistics'])
    check('filing leaves the list in newest-first order', await pg.evaluate(PLAIN) == ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'], await pg.evaluate(PLAIN))
    check('every filed row is tagged', [await pg.evaluate(TAG, c) for c in ['c0', 'c1', 'c2', 'c3', 'c4']] == ['Statistics', 'Music', 'Statistics', 'Art', 'Music'])

    # a long title and a long folder name share a row
    LONG = 'An unreasonably long folder name that cannot possibly fit'
    await pg.locator('#clist .citem[data-conv=c5]').hover(); await pg.locator('#clist .citem[data-conv=c5] [data-folderconv]').click()
    await pg.locator('#folderMenu.open [data-fm=new]').click(); await pg.locator('#modal.show #nfName').wait_for()
    await dialog_create(pg, LONG, tick=['c5'], untick=[])
    g = await pg.evaluate("(()=>{const r=document.querySelector('#clist .citem[data-conv=c5]'),t=r.querySelector('.t'),f=r.querySelector('.ftag'),rb=r.getBoundingClientRect(),tb=t.getBoundingClientRect(),fb=f.getBoundingClientRect();return {row:rb.right,tagR:fb.right,tagW:fb.width,tW:tb.width,ell:getComputedStyle(f).textOverflow,cut:f.scrollWidth>f.clientWidth}})()")
    check('long folder name: the title keeps more room than the tag', g['tW'] > g['tagW'], g)
    check('…the tag is cut with an ellipsis', g['ell'] == 'ellipsis' and g['cut'], g)
    check('…and stays inside the row', g['tagR'] <= g['row'] + 0.5, g)
    await file_into(pg, 'c5', '')
    await soon(pg, "()=>!document.querySelector('#clist .citem[data-conv=c5] .ftag')")
    await pg.screenshot(path=OUT + '/folders_open.png')

    # fold one folder, then the whole section; both remembered
    await pg.locator('#flist .fgrp[data-folder=Art] .fhd').click(); await frames(pg)
    check('a folder folds', not await pg.locator('#flist .fgrp[data-folder=Art] .fbody .citem').first.is_visible())
    await pg.locator('#foldWrap .sfold').click(); await frames(pg)
    check('the Folders section folds as a whole', not await pg.locator('#flist').is_visible() and not await pg.locator('#newFolder').is_visible())
    await pg.screenshot(path=OUT + '/folders_folded.png')
    await pg.reload(); await booted(pg); await frames(pg)
    check('folding is remembered', await pg.evaluate("document.getElementById('foldWrap').classList.contains('folded')&&document.querySelector('#flist .fgrp[data-folder=Art]').classList.contains('ffolded')"))
    await pg.locator('#foldWrap .sfold').click(); await frames(pg)

    # filing into a folded folder opens it
    await file_into(pg, 'c4', 'Art')
    check('filing into a folded folder opens it', await pg.locator('#flist .fgrp[data-folder=Art] .citem[data-conv=c4]').is_visible())

    # rename: every conversation follows
    await pg.locator('#flist .fgrp[data-folder=Art] .fhd').hover()
    await pg.locator('#flist .fgrp[data-folder=Art] [data-fren]').click()
    inp = pg.locator('#flist .fren'); await inp.fill('Art history'); await inp.press('Enter')
    await soon(pg, "()=>!!document.querySelector('#flist .fgrp[data-folder=\"Art history\"]')")
    check('rename: the tag shows the new name', await pg.evaluate(TAG, 'c3') == 'Art history' and await pg.evaluate(TAG, 'c4') == 'Art history', [await pg.evaluate(TAG, 'c3'), await pg.evaluate(TAG, 'c4')])
    check('rename: the folder has its new name', sorted(await pg.evaluate(IN_FOLDER, ['Art history'])) == ['c3', 'c4'])
    await soon(pg, f"()=>({STORED})('c3')==='Art history'&&({STORED})('c4')==='Art history'")
    check('…and every conversation in it is saved with it', await pg.evaluate(STORED, 'c3') == 'Art history')

    # take one out
    await file_into(pg, 'c4', '')
    check('Take out: it leaves the folder', await pg.evaluate(IN_FOLDER, ['Art history']) == ['c3'])
    check('…and its row has no tag', await pg.evaluate(TAG, 'c4') is None and 'c4' in await pg.evaluate(PLAIN))

    # an existing name joins that folder
    await pg.locator('#newFolder').click(); await pg.locator('#modal.show #nfName').wait_for()
    await pg.locator('#nfList input[value=c4]').check(); await pg.locator('#nfName').fill('Art history')
    await soon(pg, "()=>document.querySelector('#nfHint').textContent.includes('already')")
    check('an existing name says it joins', 'Art history' in await pg.locator('#nfHint').text_content())
    check('…and OK says Add to folder', (await pg.locator('#mOk').text_content()).strip() == 'Add to folder')
    await pg.locator('#mOk').click(); await soon(pg, "()=>!document.querySelector('#modal.show')"); await frames(pg)
    check('…and files into that folder', sorted(await pg.evaluate(IN_FOLDER, ['Art history'])) == ['c3', 'c4'])
    check('…without making another folder', len(await pg.evaluate("[...document.querySelectorAll('#flist .fgrp')].filter(g=>g.dataset.folder==='Art history')")) == 1)

    # archive from the menu
    await pg.locator('#flist .citem[data-conv=c1]').hover()
    await pg.locator('#flist .citem[data-conv=c1] [data-folderconv]').click()
    await pg.locator('#folderMenu.open [data-fm=arch]').click()
    await soon(pg, "()=>!!document.querySelector('#alist .citem[data-conv=c1]')")
    check('Archive in the menu archives it', not await pg.locator('#flist .citem[data-conv=c1]').count())
    check('active rows have no archive button of their own', not await pg.locator('#clist [data-archconv]').count())

    # remove a folder: its conversations go back, nothing deleted
    await pg.locator('#flist .fgrp[data-folder=Statistics] .fhd').hover()
    await pg.locator('#flist .fgrp[data-folder=Statistics] [data-fdrop]').click()
    await pg.locator('#mOk').click()
    await soon(pg, "()=>!document.querySelector('#flist .fgrp[data-folder=Statistics]')")
    plain = await pg.evaluate(PLAIN)
    check('removing a folder keeps its conversations in the list, untagged', 'c2' in plain and open_id in plain and await pg.evaluate(TAG, 'c2') is None and await pg.evaluate(TAG, open_id) is None, plain)
    await soon(pg, f"()=>({STORED})('c2')===''")
    check('…and nothing is deleted', await pg.evaluate(f"(ids)=>ids.every(id=>localStorage.getItem('fakesrv:convs/'+id))", ['c0', 'c1', 'c2', 'c3', 'c4']))

    check('no page errors', not errs, errs[:3])
    await b.close()


async def phone(p):
    b = await p.chromium.launch(**launch_args())
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    pg = await ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}")
    await goto_app(pg); await booted(pg)
    await pg.locator('#tSide').tap(); await frames(pg)
    await pg.wait_for_function("document.querySelectorAll('#clist .citem[data-conv]').length >= 6")
    check('phone: New folder is visible with no folders', await pg.locator('#foldWrap #newFolder').is_visible())
    await pg.screenshot(path=OUT + '/folders_empty_phone.png')
    btn = pg.locator('#clist .citem[data-conv=c1] [data-folderconv]')
    check('phone: the folder button is there without hovering', await btn.is_visible())
    await btn.tap()
    await pg.locator('#folderMenu.open [data-fm=new]').tap()
    await pg.locator('#modal.show #nfName').wait_for(); await frames(pg)
    check('phone: OK is off with an empty name', await pg.locator('#mOk').is_disabled())
    await pg.locator('#nfName').fill('Reading')
    check('phone: the name shows in the box', await pg.locator('#nfName').input_value() == 'Reading')
    nb = await pg.locator('#nfName').bounding_box()
    check('phone: the name box fits the screen', nb['x'] >= 0 and nb['x'] + nb['width'] <= 390 and nb['width'] > 200, nb)
    ob = await pg.locator('#mOk').bounding_box()
    check('phone: OK is on screen', ob['x'] >= 0 and ob['x'] + ob['width'] <= 390 and ob['y'] + ob['height'] <= 844, ob)
    await settle(pg, 300)
    await pg.screenshot(path=OUT + '/folders_dialog_phone.png')
    await pg.locator('#mOk').tap()
    await soon(pg, "()=>!!document.querySelector('#flist .fgrp[data-folder=Reading] .citem[data-conv=c1]')")
    check('phone: the filed row shows its tag', await pg.evaluate(TAG, 'c1') == 'Reading', await pg.evaluate(TAG, 'c1'))
    check('phone: filed with taps', await pg.locator('#flist .citem[data-conv=c1]').is_visible())
    check('phone: the sidebar stays open', await pg.evaluate("document.getElementById('app').classList.contains('sideopen')"))
    w = await pg.evaluate("(()=>{const t=document.querySelector('#clist .citem[data-conv=c2] .t');return t.getBoundingClientRect().width})()")
    check('phone: a row still has room for its title', w > 100, w)
    w = await pg.evaluate("(()=>{const r=document.querySelector('#clist .citem[data-conv=c1]'),t=r.querySelector('.t'),a=r.querySelector('.acts').getBoundingClientRect(),f=r.querySelector('.ftag').getBoundingClientRect();return {t:t.getBoundingClientRect().width,tagR:f.right,actsL:a.left}})()")
    check('phone: a tagged row keeps room for its title beside the buttons', w['t'] > 60, w)
    await pg.locator('#flist .fgrp[data-folder=Reading] .fhd .t').tap(); await frames(pg)
    check('phone: a folder folds with a tap', not await pg.locator('#flist .citem[data-conv=c1]').is_visible())
    await pg.screenshot(path=OUT + '/folders_phone.png')
    check('phone: no page errors', not errs, errs[:3])
    await b.close()


async def main():
    async with async_playwright() as p:
        await desktop(p)
        await phone(p)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
