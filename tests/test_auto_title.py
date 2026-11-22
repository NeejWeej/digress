"""Titles from a fast model.
  - A conversation named by a long first question gets a short title once its first reply ends; so does a branch
    (from its passage and question). The fast model of the family in use: Haiku for Claude, Terra for GPT.
  - A short, clear first question stays the title; no call.
  - A title you set is never replaced: renamed while the call runs, yours stays; a renamed branch keeps its name.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, answered, soon, frames, settle

# the fake server lists Claude and GPT models (its own list has Claude only)
MODELS = r"""
(()=>{let f=window.fetch;Object.defineProperty(window,'fetch',{configurable:true,get:()=>f,set:(v)=>{f=async(i,o)=>{const u=String(typeof i==='string'?i:i.url);
  if(/(^|\/)api\/models(\?|$)/.test(u))return new Response(JSON.stringify({models:[['claude-opus-5-5','Opus 5.5'],['claude-haiku-5-5','Haiku 5.5'],['gpt-6.2-sol','GPT-6.2-Sol'],['gpt-6.1-terra','GPT-6.1 Terra'],['gpt-5.6-terra','GPT-5.6-Terra']],defaultLabel:'Opus 5.5'}),{headers:{'content-type':'application/json'}});
  return v(i,o)}}})})();
window.__calls = []; window.__hold = null; window.fakeTitles = true;
window.fakeLLM = {use: async (n) => n !== 'sample' ? null : async (input, opts) => {
  const last = input[input.length - 1].content;
  let out;
  if (last.includes('Write a short, specific title')) {
    window.__calls.push({model: opts.model, ask: last});
    if (window.__hold) await window.__hold;
    out = last.includes('side question') ? '"Scaling attention scores."' : 'Title: Attention in transformers';
  } else out = 'Attention is a soft dictionary lookup. The scores are scaled by the square root of the dimension. ' + 'More. '.repeat(40);
  opts.onText && opts.onText({text: out});
  return {text: out, truncated: false, modelApplied: opts.model};
}};
"""
LONG = 'Okay so I have been reading about transformers and I wanted to ask you how attention actually works in practice'
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)
TITLES = "window.__calls.length"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(MODELS)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(LONG); await answered(pg, ta.press('Enter'))
        await soon(pg, "() => __digress.conv.title === 'Attention in transformers'")
        c = (await pg.evaluate("window.__calls"))[0]
        check('…from Haiku, for a Claude conversation', c['model'] == 'claude-haiku-5-5', c['model'])
        check('…given the question and the start of the reply', LONG in c['ask'] and 'soft dictionary lookup' in c['ask'])

        # a branch from a highlight, with a vague question
        await pg.evaluate("""()=>{const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body');const r=document.createRange(),t=b.querySelector('p').firstChild;
          const i=t.data.indexOf('scaled by the square root');r.setStart(t,i);r.setEnd(t,i+25);getSelection().removeAllRanges();getSelection().addRange(r);b.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))}""")
        await pg.locator('#pop textarea').first.wait_for()
        pt = pg.locator('#pop textarea').first; await pt.fill('why?'); await pt.press('Enter')
        await soon(pg, f"() => {TITLES} === 2")
        bt = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        await soon(pg, f"() => __digress.conv.threads['{bt}'].title === 'Scaling attention scores'")
        ask = (await pg.evaluate("window.__calls"))[1]['ask']
        check('a vague branch question gets a title, from its passage and question', 'scaled by the square root' in ask and '“why?”' in ask, ask[-300:])
        check('…cleaned of quotes and full stop', await pg.evaluate(f"__digress.conv.threads['{bt}'].title") == 'Scaling attention scores')

        # renamed while the call runs: yours stays
        await pg.locator('#newConv').click(); await frames(pg)
        await pg.evaluate("window.__hold = new Promise(r => window.__go = r); 0")
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(LONG + ' again'); await answered(pg, ta.press('Enter'))
        await soon(pg, f"() => {TITLES} === 3")
        await pg.evaluate("(()=>{const t=document.getElementById('cTitle');t.focus();t.textContent='My own name';t.blur()})()")
        await pg.evaluate("window.__go()"); await frames(pg, 6); await settle(pg, 300)
        check('a title you set while it ran is kept', await pg.evaluate("__digress.conv.title") == 'My own name', await pg.evaluate("__digress.conv.title"))
        await pg.evaluate("window.__hold = null")

        # a short, clear question: no call
        await pg.locator('#newConv').click(); await frames(pg)
        n = await pg.evaluate(TITLES)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain the Raft consensus algorithm'); await answered(pg, ta.press('Enter'))
        await settle(pg, 400)
        check('a short, clear question stays the title (no call)', await pg.evaluate(TITLES) == n and await pg.evaluate("__digress.conv.title") == 'Explain the Raft consensus algorithm')

        # a GPT conversation: Terra
        await pg.locator('#newConv').click(); await frames(pg)
        await pg.evaluate("(()=>{const s=document.getElementById('mSel');s.value='gpt-6.2-sol';s.dispatchEvent(new Event('change'))})()")
        check('(set up: GPT picked)', await pg.evaluate("document.getElementById('mSel').value") == 'gpt-6.2-sol')
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(LONG + ' with GPT'); await answered(pg, ta.press('Enter'))
        await soon(pg, f"() => {TITLES} === {n + 1}")
        check('a GPT conversation is titled by Terra (the newest)', (await pg.evaluate("window.__calls"))[-1]['model'] == 'gpt-6.1-terra', await pg.evaluate("window.__calls.at(-1).model"))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

if __name__=="__main__": asyncio.run(main())
