"""Ask about Digress (the ? beside How it works): a chat that has Digress's own documentation, never saved.
  - GET /api/guide returns the README, the docs and the developer notes, read from the repository.
  - The ? opens a panel; a suggested question or a typed one gets an answer with the documentation in its system
    prompt; a follow-up carries the chat so far.
  - Nothing is saved: no conversation is created or changed. Closing and reopening keeps the chat; a reload clears it.
Runs the real server with fake Claude Code. Asserts and exits non-zero."""
import asyncio, json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import soon, frames
from sync_common import setup, check, fails
from test_server import req, REPO


async def main():
    async with setup() as s:
        st, body = req(s.base, 'GET', '/api/guide')
        docs = json.loads(body)['docs'] if st == 200 else []
        files = [d['file'] for d in docs]
        check(st == 200 and files[0] == 'README.md' and 'AGENTS.md' in files and 'docs/setup.md' in files, 'GET /api/guide: the README, the docs and the developer notes', files)
        check(docs and docs[0]['text'] == open(os.path.join(REPO, 'README.md')).read(), '…read from the files as they are now')
        total = sum(len(d['text']) for d in docs)

        A = await s.device()
        await s.ask(A, 'A real question first')
        cid = await A.evaluate('__digress.conv.id'); before = json.dumps(s.convs(), sort_keys=True)
        await A.locator('#guideB').click()
        g = A.locator('#guide.open')
        check(await g.count() == 1 and await g.is_visible(), 'the ? beside How it works opens the panel')
        check(not await A.evaluate("document.querySelector('#help').open"), '…without opening How it works')
        await g.locator('.gchips .chip').first.click()
        await soon(A, "()=>{const a=[...document.querySelectorAll('#guide .gm.a')].at(-1);return a&&!a.classList.contains('wait')&&/turns=/.test(a.textContent)}", timeout=15000)
        ans = await g.locator('.gm.a').last.inner_text()
        m = re.search(r'system=(\d+) turns=(\d+)', ans)
        check(m and int(m.group(1)) > total and m.group(2) == '1', f'a suggested question is answered with all of the documentation in the system prompt ({total} characters of docs)', ans[:200])
        await A.locator('#guideIn').fill('And a follow-up?'); await A.locator('#guideIn').press('Enter')
        await soon(A, "()=>document.querySelectorAll('#guide .gm.a').length===2&&/turns=2/.test([...document.querySelectorAll('#guide .gm.a')].at(-1).textContent)", timeout=15000)
        check(await g.locator('.gm.a').count() == 2 and 'turns=2' in await g.locator('.gm.a').last.inner_text(), 'a follow-up carries the chat so far', await g.locator('.gm.a').last.inner_text())
        await A.screenshot(path=os.path.join(os.path.dirname(__file__), '.artifacts', 'guide.png'))

        await A.wait_for_timeout(800)   # (deliberate: give a wrong save time to happen)
        check(json.dumps(s.convs(), sort_keys=True) == before and await A.evaluate('__digress.conv.id') == cid, 'nothing is saved: no conversation created or changed')
        await A.keyboard.press('Escape'); await frames(A)
        check(not await A.locator('#guide.open').count(), 'Esc closes it')
        await A.locator('#guideB').click()
        check(await g.locator('.gm.a').count() == 2, 'reopening keeps the chat')
        await A.reload(); await A.wait_for_function("!!window.__digress&&!!__digress.conv")
        await A.locator('#guideB').click()
        check(await A.locator('#guide.open .gm').count() == 0 and await A.locator('#guide.open .gchips').count() == 1, 'a reload clears it')
        check(not s.errs, 'no page errors', s.errs[:3])
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
