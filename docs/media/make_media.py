"""Make the screenshots and the GIF used in the README.

    .venv/bin/python docs/media/make_media.py

Needs what the tests need (`npm install`, Playwright with Chromium) plus Pillow for the GIF
(`pip install pillow`). It starts its own Digress server on a free port with a throwaway data folder
and a stand-in for the Claude Code CLI that streams the canned replies below, so no model is called
and your own conversations are never touched. Output: docs/media/*.png and docs/media/branching.gif.
"""
import asyncio, base64, json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request, io

from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
NM = os.path.join(REPO, 'node_modules') + '/'
W, H = 1400, 850

# the page loads its libraries from CDNs; serve local copies so this runs offline
MAP = {
    'marked.min.js': NM + 'marked/marked.min.js',
    'purify.min.js': NM + 'dompurify/dist/purify.min.js',
    'highlight.min.js': NM + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': NM + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': NM + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': NM + 'minisearch/dist/umd/index.js',
    'pdf.js/3.11.174/pdf.min.js': NM + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': NM + 'pdfjs-dist/build/pdf.worker.min.js',
}

# ---- canned replies: the first key found in the latest message picks the reply -------------------
Q_MAIN = 'How does attention work in a transformer?'
Q_SQRT = 'Why the square root, exactly?'
Q_HEADS = 'Why several heads instead of one big one?'
Q_DOC = 'Give me the big picture of these notes.'
Q_POS = 'Why sines and cosines, and not just the position number?'

REPLIES = [
    ('takeaway', r"""- Dot products of random $d_k$-dimensional vectors have variance $d_k$, so raw scores grow with head size.
- Large scores push softmax toward one-hot weights, where gradients vanish.
- Dividing by $\sqrt{d_k}$ resets the variance to 1, keeping attention soft and trainable."""),
    (Q_SQRT.lower(), r"""Because of how the variance of a dot product grows with dimension.

Suppose the components of $q$ and $k$ are independent, with mean 0 and variance 1. Then

$$q \cdot k = \sum_{i=1}^{d_k} q_i k_i$$

has mean 0 and **variance $d_k$**, so its typical size grows like $\sqrt{d_k}$.

With $d_k = 64$, raw scores land around $\pm 8$. Softmax over numbers that far apart is nearly one-hot: one weight close to 1, the rest close to 0. In that regime the gradient through softmax almost vanishes, and learning stalls.

Dividing by $\sqrt{d_k}$ brings the variance back to 1 whatever the head size, so softmax stays in its soft, trainable range.

> Dividing by $d_k$ instead would overcorrect: scores shrink toward 0 and attention turns nearly uniform."""),
    (Q_HEADS.lower(), r"""One head gives each token **one** distribution over the sequence. If a token needs to look at its subject *and* at the word right before it, a single head has to compromise between the two.

Multi-head attention splits $d_{\text{model}}$ into $h$ smaller subspaces and runs attention in each:

| | 1 head | 8 heads |
|---|---|---|
| dimensions per head | 512 | 64 |
| attention patterns per token | 1 | 8 |
| total compute | about the same | about the same |

Each head learns its own $W^Q, W^K, W^V$, so each can specialise. Probing studies find heads that track the previous token, heads that link pronouns to what they refer to, and heads that follow syntactic dependencies. Their outputs are concatenated and mixed by $W^O$.

Same cost, many more kinds of relationship."""),
    (Q_POS.lower(), r"""A raw position number has two problems: it grows without bound, and a model trained on sequences of length 512 has never seen position 3000.

Sines and cosines fix both:

- **Bounded.** Every component stays in $[-1, 1]$, at any position.
- **Many scales at once.** Low dimensions oscillate quickly (fine position), high dimensions slowly (coarse position), like the hands of a clock.
- **Relative offsets are linear.** For a fixed offset $k$, $PE_{pos+k}$ is a rotation of $PE_{pos}$, so "three tokens back" looks the same everywhere and attention can learn it once.

That last property is the deep one, and it is exactly what later schemes such as RoPE build in directly [p. 2]."""),
    ('big picture', r"""These notes build attention up in four steps:

1. **The bottleneck.** An RNN squeezes a whole sentence into one fixed vector, and long-range information fades [p. 1].
2. **Attention as lookup.** Each token issues a *query*, compares it with every *key*, and takes a softmax-weighted average of the *values* [p. 1].
3. **Multi-head attention.** Several smaller heads run in parallel so different heads can follow different relationships [p. 2].
4. **Position.** Attention ignores word order, so position is added to the embeddings with sinusoidal encodings [p. 2].

The thread running through all of it: every token can reach every other token in **one step**, and everything is a matrix multiply, so it trains fast on GPUs."""),
    ('attention work', r"""Attention lets every token decide which other tokens matter to it, then pull in information from them in proportion.

### Three roles
Each token's embedding is projected three ways:
- a **query** $q$: what this token is looking for
- a **key** $k$: what it offers to others
- a **value** $v$: the information it actually passes along

### The computation
For the whole sequence at once:

$$\text{Attention}(Q,K,V)=\operatorname{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right)V$$

1. Score every query against every key with a dot product.
2. Divide by the square root of the key dimension so the scores stay in a sensible range.
3. Softmax each row into weights that sum to 1.
4. Take the weighted average of the values.

Think of it as a soft dictionary lookup: instead of returning the one value whose key matches, it returns a blend of all of them, weighted by how well each key matches.

### Why it works so well
Every token reaches every other token in a single step, so long-range dependencies don't have to survive a long chain of recurrent updates. Transformers also run several attentions side by side, called multi-head attention, each with its own projections, so different heads can track different relationships."""),
]

FAKE_CLI = r"""#!/usr/bin/env node
// Stand-in for `claude -p` (stream-json), streaming canned replies for the README media.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0 (media fake)'); process.exit(0); }
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const replies = JSON.parse(fs.readFileSync(process.env.MEDIA_REPLIES, 'utf8'));
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  const msg = JSON.parse(input.trim().split('\n')[0]);
  let prompt = msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const k = prompt.lastIndexOf('Now reply to my latest message:'); if (k >= 0) prompt = prompt.slice(k);
  const low = prompt.toLowerCase();
  const hit = replies.find(([key]) => low.includes(key));
  const text = hit ? hit[1] : 'Good question. (No canned reply for this one.)';
  const model = arg('--model');
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  emit({ type: 'system', subtype: 'init', model });
  emit({ type: 'stream_event', event: { type: 'message_start', message: { model } } });
  const delay = Number(process.env.MEDIA_DELAY || 12);
  const parts = text.match(/[\s\S]{1,9}/g);
  for (const p of parts) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } } });
    await new Promise((r) => setTimeout(r, delay));
  }
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
  emit({ type: 'assistant', message: { model, content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text });
});
"""

# ---- a small PDF of lecture notes, printed by Chromium -------------------------------------------
NOTES = """<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A5;margin:16mm 15mm}
body{font-family:Georgia,'DejaVu Serif',serif;font-size:10.5pt;line-height:1.45;color:#1d1d1f}
h1{font-size:17pt;margin:0 0 2pt;font-weight:normal}
.sub{color:#666;font-style:italic;margin-bottom:14pt}
h2{font-size:11.5pt;margin:13pt 0 4pt}
.eq{text-align:center;margin:8pt 0;font-style:italic}
p{margin:0 0 6pt}
body{font-variant-ligatures:none}
.pb{page-break-before:always}
</style></head><body>
<h1>Attention from first principles</h1>
<div class="sub">Lecture notes, week 6</div>
<h2>1. The bottleneck</h2>
<p>A recurrent encoder reads a sentence one word at a time and compresses everything it has seen into a single hidden vector. For short sentences this works. For long ones, information about early words has to survive many updates, and in practice it fades: the model forgets the subject by the time it reaches the verb.</p>
<p>Attention removes the bottleneck. Instead of one summary vector, the decoder keeps every encoder state and, at each step, decides which of them to look at.</p>
<h2>2. Attention as a soft lookup</h2>
<p>Each token produces a query, a key and a value by multiplying its embedding with three learned matrices. A token's query is compared with every key by a dot product; the scores are scaled, turned into weights with a softmax, and used to average the values:</p>
<p class="eq">Attention(Q, K, V) = softmax(QK<sup>T</sup> / &radic;d<sub>k</sub>) V</p>
<p>This is a dictionary lookup made differentiable. A hard lookup returns the one value whose key matches; attention returns a blend of all values, weighted by how well each key matches the query.</p>
<h2 class="pb">3. Many heads</h2>
<p>A single attention produces one weighting per token. Multi-head attention runs several smaller attentions in parallel, each with its own projections, and concatenates the results. Different heads learn different relationships: one follows the previous token, another links a pronoun to its referent.</p>
<h2>4. Where is word order?</h2>
<p>Attention treats its input as a set: shuffle the tokens and every output is shuffled the same way. To give the model a sense of order, a positional encoding is added to each embedding before the first layer. The original transformer uses sines and cosines of different frequencies:</p>
<p class="eq">PE(pos, 2i) = sin(pos / 10000<sup>2i/d</sup>)</p>
<p>Because every frequency is present, nearby positions get similar codes and a fixed offset between two positions always corresponds to the same transformation.</p>
<h2>5. Cost</h2>
<p>Every token attends to every other, so time and memory grow with the square of the sequence length. Most work on efficient transformers is about avoiding that square.</p>
</body></html>"""


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def start_server(tmp):
    cli = os.path.join(tmp, 'claude'); open(cli, 'w').write(FAKE_CLI); os.chmod(cli, 0o755)
    rep = os.path.join(tmp, 'replies.json'); json.dump(REPLIES, open(rep, 'w'))
    port = free_port()
    env = {**os.environ, 'PORT': str(port), 'HOST': '127.0.0.1', 'DATA_DIR': os.path.join(tmp, 'data'),
           'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': cli, 'ANTHROPIC_API_KEY': '', 'DEFAULT_MODEL': 'claude-opus-5-5',
           'CHATGPT_AUTH_FILE': os.path.join(tmp, 'no-chatgpt.json'), 'DEV': '0', 'MEDIA_REPLIES': rep}
    proc = subprocess.Popen(['node', os.path.join(REPO, 'server', 'server.mjs')], env=env, cwd=tmp,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}/'
    for _ in range(100):
        try:
            if json.load(urllib.request.urlopen(url + 'api/health')).get('app') == 'digress': return proc, url
        except Exception: time.sleep(0.1)
    proc.kill(); sys.exit('server did not start')


# a visible mouse pointer for the GIF (headless screenshots don't draw one)
CURSOR = """(() => { const c=document.createElement('div'); c.id='__cur';
  c.innerHTML='<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  c.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px)';
  document.body.appendChild(c);
  addEventListener('mousemove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px'},true); })()"""

FIND = """([root, phrase, scroll]) => { const el=document.querySelector(root); if(!el) return null;
  const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); const nodes=[]; let n, all='';
  while((n=w.nextNode())){ nodes.push([n, all.length]); all+=n.nodeValue; }
  const i=all.indexOf(phrase); if(i<0) return null; const j=i+phrase.length;
  const at=(k,end)=>{ for(let x=nodes.length-1;x>=0;x--){ const [nd,o]=nodes[x]; if(end?o<k:o<=k) return [nd,k-o]; } };
  const [a,ao]=at(i,false), [b,bo]=at(j,true);
  if(scroll){ a.parentElement.scrollIntoView({block:'center'}); return 'scrolled'; }
  const r=document.createRange(); r.setStart(a,ao); r.setEnd(b,bo);
  const rs=[...r.getClientRects()].filter(q=>q.width>0); const f=rs[0], l=rs[rs.length-1];
  return [f.left+1, f.top+f.height/2, l.right-1, l.top+l.height/2]; }"""


class Recorder:
    """Collects frames with Chrome's screencast, which is much smoother than a screenshot loop."""
    def __init__(self, page): self.page, self.frames = page, []
    async def start(self):
        self.cdp = await self.page.context.new_cdp_session(self.page)
        async def on_frame(e):
            self.frames.append((e['metadata']['timestamp'], base64.b64decode(e['data'])))
            try: await self.cdp.send('Page.screencastFrameAck', {'sessionId': e['sessionId']})
            except Exception: pass
        self.cdp.on('Page.screencastFrame', lambda e: asyncio.ensure_future(on_frame(e)))
        await self.cdp.send('Page.startScreencast', {'format': 'png', 'maxWidth': W, 'maxHeight': H, 'everyNthFrame': 1})
    async def stop(self):
        await self.cdp.send('Page.stopScreencast'); await asyncio.sleep(0.2)
    async def hold(self, s): await asyncio.sleep(s)


async def drag_select(pg, root, phrase, steps=14):
    assert await pg.evaluate(FIND, [root, phrase, True]), f'{phrase!r} not found in {root}'
    await pg.wait_for_timeout(900)
    box = await pg.evaluate(FIND, [root, phrase, False])
    assert box, f'{phrase!r} not found in {root}'
    x0, y0, x1, y1 = box
    await pg.mouse.move(x0 - 60, y0 + 70, steps=1)
    await pg.mouse.move(x0, y0, steps=12); await pg.wait_for_timeout(250)
    await pg.mouse.down()
    await pg.mouse.move(x1, y1, steps=steps)
    await pg.wait_for_timeout(120)
    await pg.mouse.up()


async def ask_main(pg, q, wait=4000):
    ta = pg.locator('.pane[data-tid=main] textarea')
    await ta.fill(q); await ta.press('Enter'); await pg.wait_for_timeout(wait)


async def branch(pg, root, phrase, q, wait=4500):
    await drag_select(pg, root, phrase)
    await pg.wait_for_selector('#pop.show', timeout=3000)
    await pg.locator('#popIn').fill(q); await pg.locator('#popIn').press('Enter')
    await pg.wait_for_timeout(wait)


def save_gif(frames, path, width=1120):
    if os.environ.get('PILLOW_PATH'): sys.path.insert(0, os.environ['PILLOW_PATH'])  # Pillow installed somewhere else
    from PIL import Image
    imgs, durs = [], []
    for i, (t, png) in enumerate(frames):
        im = Image.open(io.BytesIO(png)).convert('RGB')
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        imgs.append(im)
        nxt = frames[i + 1][0] if i + 1 < len(frames) else t + 2.5  # hold the last frame
        durs.append(max(40, round((nxt - t) * 1000 / 10) * 10))
    # one shared palette keeps the colours steady from frame to frame
    pal = imgs[len(imgs) // 2].quantize(colors=255, method=Image.MEDIANCUT)
    q = [im.quantize(palette=pal, dither=Image.NONE) for im in imgs]
    q[0].save(path, save_all=True, append_images=q[1:], duration=durs, loop=0, optimize=True, disposal=1)


async def main():
    tmp = tempfile.mkdtemp(prefix='digress-media-')
    proc, url = start_server(tmp)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(args=['--no-sandbox'], **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
            # print the lecture notes to a PDF
            np_ = await b.new_page(); await np_.set_content(NOTES); pdf = os.path.join(tmp, 'attention-notes.pdf')
            await np_.pdf(path=pdf, format='A5', print_background=True); await np_.close()

            ctx = await b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=1, color_scheme='light')
            pg = await ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            async def route(r):
                u = r.request.url
                for k, v in MAP.items():
                    if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
                if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                await r.continue_()
            await pg.route('**/*', route)
            await pg.goto(url); await pg.wait_for_timeout(1500)

            # 1. the document conversation (made first so the sidebar lists both)
            await pg.locator('#newDoc').click(); await pg.wait_for_timeout(300)
            await pg.set_input_files('#docFile', pdf)
            await pg.locator('#docGo').click(); await pg.wait_for_timeout(3000)
            await ask_main(pg, Q_DOC, 4000)
            await branch(pg, '.pane[data-tid=doc] .dpage[data-page="2"] .textLayer', 'a positional encoding is added', Q_POS, 4500)
            await pg.locator('#tSide').click(); await pg.wait_for_timeout(600)
            await pg.evaluate(FIND, ['.pane[data-tid=doc] .dpage[data-page="2"] .textLayer', 'Where is word order', True])
            await pg.evaluate("[...document.querySelectorAll('.pane:not([data-tid=doc]) .pb')].forEach(e=>e.scrollTop=0)")
            await pg.mouse.move(W - 5, H - 5); await pg.wait_for_timeout(1200)
            await pg.screenshot(path=os.path.join(HERE, 'document.png'))
            await pg.locator('#tSide').click(); await pg.wait_for_timeout(400)

            # 2. a plain conversation: ask, then record a branch being made
            await pg.locator('#newConv').click(); await pg.wait_for_timeout(500)
            await ask_main(pg, Q_MAIN, 5500)
            await pg.evaluate(CURSOR)
            await pg.evaluate(FIND, ['.pane[data-tid=main] .msg.assistant .body', 'Score every query', True])
            await pg.mouse.move(W - 150, H - 150); await pg.wait_for_timeout(600)
            rec = Recorder(pg); await rec.start()
            await rec.hold(0.7)
            await drag_select(pg, '.pane[data-tid=main] .msg.assistant .body', 'the square root of the key dimension', steps=16)
            await pg.wait_for_selector('#pop.show', timeout=3000); await rec.hold(0.5)
            await pg.locator('#popIn').click()
            await pg.keyboard.type(Q_SQRT, delay=45); await rec.hold(0.4)
            await pg.keyboard.press('Enter')
            await pg.mouse.move(150, H - 60, steps=10)
            await rec.hold(3.2)
            await rec.stop()
            save_gif(rec.frames, os.path.join(HERE, 'branching.gif'))

            # 3. a second branch and a takeaway carried back, for the Columns screenshot
            await branch(pg, '.pane[data-tid=main] .msg.assistant .body', 'multi-head attention', Q_HEADS, 4500)
            pane = pg.locator('.pane', has_text=Q_SQRT).last
            await pane.locator('[data-act=take]').first.click(); await pg.wait_for_timeout(300)
            await pane.locator('.tk .go').click(); await pg.wait_for_timeout(3000)
            await pg.evaluate("document.getElementById('__cur')?.remove()")
            await pg.evaluate("[...document.querySelectorAll('.pane:not([data-tid=main]) .pb')].forEach(e=>e.scrollTop=0)")
            await pg.mouse.move(W - 5, H - 5); await pg.wait_for_timeout(600)
            await pg.screenshot(path=os.path.join(HERE, 'columns.png'))

            await pg.locator('[data-v=canvas]').click(); await pg.wait_for_timeout(1200)
            await pg.locator('#zFit').click(); await pg.wait_for_timeout(800)
            await pg.screenshot(path=os.path.join(HERE, 'canvas.png'))
            await pg.locator('[data-v=cols]').click()
            if errs: print('page errors:', *errs[:5], sep='\n  ')
            await b.close()
    finally:
        proc.terminate(); proc.wait(timeout=5); shutil.rmtree(tmp, ignore_errors=True)
    for f in ('columns.png', 'document.png', 'canvas.png', 'branching.gif'):
        fp = os.path.join(HERE, f)
        if os.path.exists(fp): print(f'{f}: {os.path.getsize(fp) / 1e6:.2f} MB')


if __name__ == '__main__':
    asyncio.run(main())
