"""A folder's prompt: where new chats in it start, and nothing more.
  - A folder can have a prompt (its header's prompt button, a dialog; saved in the store's prompts/custom as
    folders:{name:text}); the header marks a folder that has one.
  - New chat in a folder (its header's + button) opens a fresh conversation filed there, with a copy of the folder's
    prompt as its own system prompt; in a folder without one it starts with the default.
  - Editing the folder's prompt changes no conversation already in it.
  - Moving a conversation into a folder with a prompt asks; keeping its own is the default (Cancel), and "Use the
    folder's" switches it (the open one and one that isn't open). A folder without a prompt, or a conversation that
    already has the same prompt, asks nothing.
  - Renaming a folder carries its prompt; removing it drops the prompt and the conversations keep theirs.
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon, settle, quiet, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

WORK = 'You are a pair programmer. Be terse.'
SEED = r"""
for (let i = 0; i < 4; i++) {
  const id = 'c' + i, t = Date.now() - i * 60000;
  const c = {id, title: 'Topic ' + i, created: t, updated: t, rev: 1,
    threads: {main: {id: 'main', parent: null, title: 'Main', colorIdx: 0}},
    msgs: {u: {role: 'user', thread: 'main', text: 'Question ' + i, ts: t}}, order: {main: ['u']}, nextColor: 1};
  if (i === 1) c.folder = 'Work';
  if (i === 3) c.folder = 'Plain';
  localStorage.setItem('fakesrv:convs/' + id, JSON.stringify(c));
}
localStorage.setItem('fakesrv:prompts/custom', JSON.stringify({folders: {Work: %s}}));
""" % json.dumps(WORK)

STORED = "(id)=>{const v=localStorage.getItem('fakesrv:convs/'+id);return v?JSON.parse(v):null}"
FPROMPTS = "()=>{const v=localStorage.getItem('fakesrv:prompts/custom');return v?(JSON.parse(v).folders||{}):{}}"


async def header_btn(pg, folder, act):
    g = pg.locator(f'#flist .fgrp[data-folder="{folder}"] .fhd')
    await g.hover(); await g.locator(f'[data-{act}]').click()


async def file_into(pg, cid, name):
    await pg.locator(f'#clist .citem[data-conv={cid}]').hover()
    await pg.locator(f'#clist .citem[data-conv={cid}] [data-folderconv]').click()
    menu = pg.locator('#folderMenu.open'); await menu.wait_for()
    await menu.locator('[data-fm=out]' if name == '' else f'[data-fm="f:{name}"]').click()
    await frames(pg)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}")
        await goto_app(pg); await booted(pg)
        await soon(pg, "()=>!!document.querySelector('#flist .fgrp[data-folder=Work] .fpmark')")
        check('a folder with a prompt is marked', await pg.locator('#flist .fgrp[data-folder=Work] .fpmark').count() == 1)
        check('…one without is not', await pg.locator('#flist .fgrp[data-folder=Plain] .fpmark').count() == 0)

        # new chat in the folder: filed there, with a copy of the prompt
        await header_btn(pg, 'Work', 'fchat')
        await soon(pg, "()=>__digress.conv&&__digress.conv.folder==='Work'&&!__digress.conv.order.main.length")
        c = await pg.evaluate("({folder:__digress.conv.folder,system:__digress.conv.system||'',id:__digress.conv.id})")
        check('New chat in a folder is filed there', c['folder'] == 'Work', c)
        check('…and starts with a copy of the folder’s prompt', c['system'] == WORK, c)
        check('…its row is in the folder', await pg.locator(f'#flist .fgrp[data-folder=Work] .citem[data-conv="{c["id"]}"]').count() == 1)
        check('…and the composer has the focus', await soon(pg, "()=>document.activeElement===document.querySelector('.pane[data-tid=main] textarea')"))
        await soon(pg, f"()=>{{const v=({STORED})('{c['id']}');return v&&v.folder==='Work'&&v.system==={json.dumps(WORK)}}}")
        check('…saved with both (it has its own prompt, so it isn’t blank)', (await pg.evaluate(STORED, c['id']) or {}).get('system') == WORK)
        await pg.screenshot(path=OUT + '/folder_prompts_new_chat.png')

        await header_btn(pg, 'Plain', 'fchat')
        await soon(pg, "()=>__digress.conv&&__digress.conv.folder==='Plain'")
        check('New chat in a folder without a prompt starts with the default', not await pg.evaluate("__digress.conv.system||''"))

        # edit the folder's prompt: nothing already in it changes
        await pg.locator('#clist .citem[data-conv=c0]').click(); await soon(pg, "()=>__digress.conv.id==='c0'")
        await header_btn(pg, 'Work', 'fprompt')
        await pg.locator('#modal.show #fSysEd').wait_for()
        check('the prompt dialog shows the folder’s prompt', await pg.locator('#fSysEd').input_value() == WORK)
        await settle(pg, 200); await pg.screenshot(path=OUT + '/folder_prompts_dialog.png')
        NEW = 'You are a careful reviewer.'
        await pg.locator('#fSysEd').fill(NEW); await pg.locator('#mOk').click()
        await soon(pg, f"()=>({FPROMPTS})().Work==={json.dumps(NEW)}")
        check('the folder’s prompt is saved', (await pg.evaluate(FPROMPTS)).get('Work') == NEW)
        check('…the chat started from it keeps its copy', (await pg.evaluate(STORED, c['id']) or {}).get('system') == WORK)
        check('…and a conversation already in it keeps its own', not (await pg.evaluate(STORED, 'c1') or {}).get('system'))

        # moving one in that isn't open: asked, and keeping is the default
        await file_into(pg, 'c2', 'Work')
        await pg.locator('#modal.show').wait_for()
        check('moving a conversation in asks', 'folder’s prompt' in (await pg.locator('#mTitle').text_content()))
        check('…offering to keep its own', 'Keep' in (await pg.locator('#mCancel').text_content()))
        await pg.screenshot(path=OUT + '/folder_prompts_ask.png')
        await pg.locator('#mCancel').click(); await soon(pg, "()=>!document.querySelector('#modal.show')")
        await soon(pg, f"()=>({STORED})('c2').folder==='Work'")
        check('Keep: it is filed and keeps its prompt', not (await pg.evaluate(STORED, 'c2') or {}).get('system'))

        # the open one: Use the folder's switches it
        await file_into(pg, 'c0', 'Work')
        await pg.locator('#modal.show').wait_for()
        await pg.locator('#mOk').click(); await soon(pg, "()=>!document.querySelector('#modal.show')")
        await soon(pg, f"()=>__digress.conv.system==={json.dumps(NEW)}")
        check('Use the folder’s: the open conversation switches', await pg.evaluate("__digress.conv.system") == NEW)

        # one that isn't open, switched: out and back in
        await file_into(pg, 'c2', '')
        await file_into(pg, 'c2', 'Work')
        await pg.locator('#modal.show').wait_for(); await pg.locator('#mOk').click()
        await soon(pg, f"()=>({STORED})('c2').system==={json.dumps(NEW)}")
        check('…and so does one that isn’t open', (await pg.evaluate(STORED, 'c2') or {}).get('system') == NEW)

        # same prompt already, or a folder without one: nothing asked
        await file_into(pg, 'c2', '')
        await file_into(pg, 'c2', 'Work'); await settle(pg, 300)
        check('a conversation with the same prompt is not asked', not await pg.locator('#modal.show').count())
        await file_into(pg, 'c2', 'Plain'); await settle(pg, 300)
        check('a folder without a prompt asks nothing', not await pg.locator('#modal.show').count())

        # rename carries the prompt; remove drops it, conversations keep theirs
        await header_btn(pg, 'Work', 'fren')
        inp = pg.locator('#flist .fren'); await inp.fill('Code'); await inp.press('Enter')
        await soon(pg, f"()=>({FPROMPTS})().Code==={json.dumps(NEW)}")
        fp = await pg.evaluate(FPROMPTS)
        check('renaming a folder carries its prompt', fp.get('Code') == NEW and 'Work' not in fp, fp)
        await header_btn(pg, 'Code', 'fdrop')
        check('the remove dialog says the prompt goes and conversations keep theirs', 'keep the prompts' in (await pg.locator('#mBody').text_content()))
        await pg.locator('#mOk').click()
        await soon(pg, f"()=>!('Code' in ({FPROMPTS})())")
        check('removing a folder drops its prompt', 'Code' not in await pg.evaluate(FPROMPTS))
        await soon(pg, "()=>!__digress.conv.folder")
        check('…and the conversations keep the prompts they have', await pg.evaluate("__digress.conv.system") == NEW and (await pg.evaluate(STORED, c['id']) or {}).get('system') == WORK)

        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
