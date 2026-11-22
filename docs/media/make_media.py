"""Make the screenshots and the GIF used in the README.

    .venv/bin/python docs/media/make_media.py

Needs what the tests need (`npm install`, Playwright with Chromium) plus Pillow for the GIF
(`pip install pillow`). It starts its own Digress server on a free port with a throwaway data folder
and a stand-in for the Claude Code CLI that streams the canned replies below, so no model is called
and your own conversations are never touched. The page's libraries come from node_modules; its fonts
come from Google Fonts as in the real app (offline, the shots fall back to system fonts).
Output: docs/media/columns.png, document.png, canvas.png (2x, for sharp text on high-density
screens) and docs/media/branching.gif.

What each shows:
- document.png  a PDF of lecture notes, a summary with page links, and a branch about one highlighted
                sentence (light theme)
- branching.gif selecting a phrase, asking about it, and the branch opening beside it
- columns.png   the main thread, two branches beside it, a takeaway carried back; the sidebar lists a few
                conversations (one with flashcards due) and the branch tree
- canvas.png    the same conversation, with a branch of a branch, as cards on the canvas (dark theme)
"""
import asyncio, base64, json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request, io
CORS = {'access-control-allow-origin': '*'}   # the page loads libraries with integrity hashes, which need CORS

from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
NM = os.path.join(REPO, 'node_modules') + '/'
W, H = 1400, 860
SCALE = 2          # device pixels per CSS pixel for the PNGs
GIF_W, GIF_H = 1120, 700   # the window while recording the GIF, which is kept at this size
SIDE_EXTRA = 50    # widen the sidebar by this much for the canvas shot

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
# Each reply opens with a full paragraph of plain prose: canvas cards show the first ~180 characters.
Q_SKY = 'Why is the sky blue, but sunsets red?'
Q_PVAL = 'What does a p-value actually tell me?'
Q_MAIN = 'How does attention work in a transformer?'
Q_SQRT = 'Why the square root, exactly?'
Q_HEADS = 'Why several heads instead of one big one?'
Q_GRAD = 'Why does the gradient vanish there?'
Q_DOC = 'Give me the big picture of these notes.'
Q_POS = 'Why sines and cosines, and not just the position number?'

REPLIES = [
    ('takeaway', r"""- Softmax's derivative, $p_i(\delta_{ij} - p_j)$, is near 0 everywhere once the weights are nearly one-hot.
- A saturated head gets almost no gradient, so it can't learn to look elsewhere.
- Scaling scores by $1/\sqrt{d_k}$ keeps softmax out of that regime."""),
    (Q_GRAD.lower(), r"""Because a saturated softmax hardly responds to its inputs. Once one weight is close to 1 and the rest are close to 0, nudging any score changes the weights by almost nothing, so almost no gradient flows back to the queries and keys that produced the scores.

You can see it in the derivative. With $p = \operatorname{softmax}(z)$,

$$\frac{\partial p_i}{\partial z_j} = p_i\,(\delta_{ij} - p_j)$$

Every entry has a factor $p_i$ and either $(1 - p_i)$ or $p_j$:

- for the winning token, $p_i \approx 1$, so $p_i(1 - p_i) \approx 0$
- for every other token, $p_i \approx 0$, so the whole row is $\approx 0$

Take scores $(8, 0, 0)$: the weights are about $(0.9993, 0.0003, 0.0003)$, and the largest entry of the Jacobian is about $0.0007$. Scale the same scores down to $(1, 0, 0)$ and the weights become $(0.58, 0.21, 0.21)$, with entries around $0.24$, a few hundred times larger.

So the head is stuck: it can't learn to look somewhere else, because the signal telling it to is nearly zero."""),
    (Q_SQRT.lower(), r"""Because a dot product gets larger as the vectors get longer. Without the scaling, attention scores would grow with the size of each head and push softmax into a regime where it barely learns; the square root is exactly the factor that undoes that growth.

Suppose the components of $q$ and $k$ are independent, with mean 0 and variance 1. Then

$$q \cdot k = \sum_{i=1}^{d_k} q_i k_i$$

is a sum of $d_k$ terms that each have variance 1, so it has mean 0 and **variance $d_k$**: its typical size is $\sqrt{d_k}$, not 1.

With $d_k = 64$ the scores have a standard deviation of 8, so gaps of 10 or 15 between two scores are routine. Softmax turns gaps like that into nearly one-hot weights: one close to 1, the rest close to 0. There the gradient through softmax almost vanishes, and learning stalls.

Dividing by $\sqrt{d_k}$ brings the variance back to 1 whatever the head size, so softmax stays in its soft, trainable range.

> Dividing by $d_k$ instead would overcorrect: bigger heads would get ever flatter, nearly uniform attention."""),
    (Q_HEADS.lower(), r"""One head gives each token **one** set of weights over the sequence. If a token needs to look at its subject *and* at the word right before it, a single head has to blend the two into one average, and both signals get diluted.

Multi-head attention splits $d_{\text{model}}$ into $h$ smaller subspaces and runs attention in each:

| | 1 head | 8 heads |
|---|---|---|
| dimensions per head | 512 | 64 |
| weightings per token | 1 | 8 |
| compute | about the same | about the same |

Each head learns its own $W^Q, W^K, W^V$, so each can specialise. Studies of trained models find heads that attend to the previous token, heads that link a pronoun to what it refers to, and heads that follow grammatical relations such as verb to object. Their outputs are concatenated and mixed by $W^O$.

Same cost, many more kinds of relationship at once."""),
    (Q_POS.lower(), r"""Because a raw position number is a poor signal to add to an embedding: it grows without bound, so late positions would swamp the word's meaning, and a model trained on sequences of 512 tokens has never seen a value like 3000.

Sines and cosines avoid both problems:

- **Bounded.** Every component stays in $[-1, 1]$, at any position.
- **Many scales at once.** The first dimensions oscillate quickly (fine position), the last ones slowly (coarse position), like the hands of a clock.
- **Offsets are linear.** Each sine and cosine pair at frequency $\omega$ is a point on a circle, and moving $k$ positions rotates it by the angle $k\omega$. So $PE_{pos+k}$ is a fixed linear function of $PE_{pos}$, the same at every position.

That last property is the deep one: it is what the notes mean by "a fixed offset between two positions always corresponds to the same transformation" [p. 2], and it lets attention learn "three tokens back" once instead of separately for every position. Rotary embeddings (RoPE), used in many recent models, build the same idea directly into the queries and keys."""),
    ('big picture', r"""These notes build attention up in four steps, from the problem it solves to the price it pays:

1. **The bottleneck.** An RNN squeezes a whole sentence into one fixed vector, and information about early words fades [p. 1].
2. **Attention as lookup.** Each token issues a *query*, compares it with every *key*, and takes a softmax-weighted average of the *values* [p. 1].
3. **Multi-head attention.** Several smaller heads run in parallel, so different heads can follow different relationships [p. 2].
4. **Position.** Attention ignores word order, so a sinusoidal encoding of each position is added to the embeddings [p. 2].

The thread running through it: every token can reach every other token in **one step**, and everything is a matrix multiply, so it trains fast on GPUs. The price, in the last section, is that cost grows with the square of the sequence length [p. 2]."""),
    ('attention work', r"""Attention lets every token in a sequence decide which other tokens matter to it, then build its new representation as a weighted blend of theirs. It is the one place in a transformer where information moves between positions.

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
    (Q_SKY.lower(), r"""Because air scatters short wavelengths far more than long ones. Molecules of nitrogen and oxygen are much smaller than the wavelength of light, and for such small scatterers the strength of scattering goes as $1/\lambda^4$ (Rayleigh scattering).

Blue light (about 450 nm) is therefore scattered roughly 4 to 5 times more strongly than red (about 700 nm). Look anywhere away from the sun and what reaches you is light scattered toward you on the way, which is mostly blue. (Violet scatters even more, but sunlight has less of it and our eyes are less sensitive to it.)

At sunset the sunlight crosses far more air before it reaches you, sometimes dozens of times more than at noon. Most of the blue is scattered out of the direct beam along the way, so what is left, and what lights the clouds, is orange and red."""),
    (Q_PVAL.lower(), r"""A p-value tells you how surprising your data would be **if the null hypothesis were true**: the probability of a result at least as extreme as the one you got, assuming there is no real effect.

So $p = 0.03$ means: if there were really no effect, data this extreme would turn up about 3% of the time.

What it does **not** tell you:
- the probability that the null hypothesis is true
- the probability that your result is a fluke
- how large or important the effect is

A tiny effect measured on a huge sample can have a very small p-value, and a large effect in a small study can miss $0.05$. Report the effect size with a confidence interval alongside it."""),
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  emit({ type: 'system', subtype: 'init', model });
  emit({ type: 'stream_event', event: { type: 'message_start', message: { model } } });
  // pacing, read on every run so the script can slow down just the reply it records
  const pace = JSON.parse(fs.readFileSync(process.env.MEDIA_PACE, 'utf8'));
  await wait(pace.first);   // a moment of "Thinking" before the first words
  const delay = pace.delay;
  const parts = text.match(/[\s\S]{1,9}/g);
  for (const p of parts) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } } });
    await wait(delay);
  }
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
  emit({ type: 'assistant', message: { model, content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text });
});
"""

# ---- a small PDF of lecture notes, printed by Chromium (its <title> becomes the PDF's Title) ------
NOTES = """<!doctype html><html><head><meta charset="utf-8"><title>Attention from first principles</title><style>
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

# flashcards "drafted earlier" from the document conversation, now due, so its sidebar row shows the badge
CARDS = [
    ('Why do recurrent encoders struggle with long sentences?',
     'Everything is squeezed into one fixed hidden vector, and information about early words fades over many updates.'),
    ('Why are sinusoidal position encodings better than adding the raw position number?',
     'They stay in [-1, 1] at any position, cover many scales at once, and a fixed offset is the same linear map (a rotation) everywhere.'),
    ('How does the cost of attention grow with sequence length n?',
     'With n squared, in time and memory: every token attends to every other.'),
]


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def pace(tmp, first=0, delay=5):
    """How the fake CLI streams: ms before the first words, then ms between 9-character pieces."""
    json.dump({'first': first, 'delay': delay}, open(os.path.join(tmp, 'pace.json'), 'w'))


def start_server(tmp):
    cli = os.path.join(tmp, 'claude'); open(cli, 'w').write(FAKE_CLI); os.chmod(cli, 0o755)
    rep = os.path.join(tmp, 'replies.json'); json.dump(REPLIES, open(rep, 'w'))
    port = free_port()
    env = {**os.environ, 'PORT': str(port), 'HOST': '127.0.0.1', 'DATA_DIR': os.path.join(tmp, 'data'),
           'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': cli, 'ANTHROPIC_API_KEY': '', 'GEMINI_API_KEY': '', 'GOOGLE_API_KEY': '', 'DEFAULT_MODEL': 'claude-opus-5-5',
           'CHATGPT_AUTH_FILE': os.path.join(tmp, 'no-chatgpt.json'), 'DEV': '0', 'MEDIA_REPLIES': rep, 'MEDIA_PACE': os.path.join(tmp, 'pace.json')}
    pace(tmp)
    proc = subprocess.Popen(['node', os.path.join(REPO, 'server', 'server.mjs')], env=env, cwd=tmp,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}/'
    for _ in range(100):
        try:
            if json.load(urllib.request.urlopen(url + 'api/health')).get('app') == 'digress': return proc, url, env
        except Exception: time.sleep(0.1)
    proc.kill(); sys.exit('server did not start')


# a visible mouse pointer for the GIF (headless screenshots don't draw one)
CURSOR = """(() => { if (document.getElementById('__cur')) return; const c=document.createElement('div'); c.id='__cur';
  c.innerHTML='<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  c.style.cssText='position:fixed;left:-40px;top:0;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px)';
  document.body.appendChild(c);
  addEventListener('mousemove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px'},true); })()"""

FIND = """([root, phrase, scroll]) => { const el=document.querySelector(root); if(!el) return null;
  const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); const nodes=[]; let n, all='';
  while((n=w.nextNode())){ nodes.push([n, all.length]); all+=n.nodeValue; }
  const i=all.indexOf(phrase); if(i<0) return null; const j=i+phrase.length;
  const at=(k,end)=>{ for(let x=nodes.length-1;x>=0;x--){ const [nd,o]=nodes[x]; if(end?o<k:o<=k) return [nd,k-o]; } };
  const [a,ao]=at(i,false), [b,bo]=at(j,true);
  if(scroll){ a.parentElement.scrollIntoView({block: scroll === true ? 'center' : scroll}); return 'scrolled'; }
  const r=document.createRange(); r.setStart(a,ao); r.setEnd(b,bo);
  const rs=[...r.getClientRects()].filter(q=>q.width>0); const f=rs[0], l=rs[rs.length-1];
  return [f.left+1, f.top+f.height/2, l.right-1, l.top+l.height/2]; }"""

# no reply being written anywhere (the page's code is private to it, so this reads the DOM)
SETTLED = """() => document.querySelector('.citem.cur') && !document.querySelector('.live, .thinking, button[title="Stop"]')"""

# flashcards on for the open conversation, with CARDS drafted a few days ago and due now: through the
# server's store, as another device would have saved them (the page picks them up when it reloads)
SEED_CARDS = """async (cards) => {
  const id = document.querySelector('.citem.cur').dataset.conv;
  const c = await (await fetch('api/store/convs/' + id)).json();
  const last = (tid) => c.order[tid].filter((m) => c.msgs[m].role === 'assistant').pop();
  const br = Object.keys(c.threads).find((t) => t !== 'main');
  const done = {main: last('main'), [br]: last(br)};
  const put = (u, m, d) => fetch(u, {method: m, headers: {'content-type': 'application/json'}, body: JSON.stringify(d)});
  await put('api/store/convs/' + id, 'PATCH', {cards: {on: true, done}});
  const now = Date.now(), day = 864e5, hex = () => Math.random().toString(16).slice(2, 10);
  for (const [i, [front, back]] of cards.entries()) {
    const tid = i === 1 ? br : 'main';
    const kid = 'k' + hex() + hex();
    await put('api/store/cards/' + kid, 'PUT', {id: kid, conv: id, convTitle: c.title, thread: tid,
      at: {thread: tid, msg: done[tid]}, where: tid === 'main' ? 'Main thread' : c.threads[tid].title,
      src: tid === 'main' ? 'made' : 'highlight', front, back, status: 'active', created: now - 4 * day,
      due: now - (i + 1) * 3600e3, fsrs: {S: 3.7, D: 5.2, state: 2, last: now - 4 * day, reps: 1, lapses: 0},
      reviews: [{at: now - 4 * day, g: 3}]});
  }
}"""


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
        await self.cdp.send('Page.startScreencast', {'format': 'png', 'maxWidth': GIF_W, 'maxHeight': GIF_H, 'everyNthFrame': 1})
    async def stop(self):
        await self.cdp.send('Page.stopScreencast'); await asyncio.sleep(0.2)
    async def hold(self, s): await asyncio.sleep(s)


async def settle(pg, extra=700):
    await pg.wait_for_function(SETTLED, timeout=30000)
    await pg.wait_for_timeout(extra)


async def drag_select(pg, root, phrase, steps=14, glide=12, scroll=True):
    if scroll:
        assert await pg.evaluate(FIND, [root, phrase, True]), f'{phrase!r} not found in {root}'
        await pg.wait_for_timeout(900)
    box = await pg.evaluate(FIND, [root, phrase, False])
    assert box, f'{phrase!r} not found in {root}'
    x0, y0, x1, y1 = box
    await pg.mouse.move(x0, y0, steps=glide); await pg.wait_for_timeout(250)
    await pg.mouse.down()
    await pg.mouse.move(x1, y1, steps=steps)
    await pg.wait_for_timeout(120)
    await pg.mouse.up()


async def ask_main(pg, q):
    ta = pg.locator('.pane[data-tid=main] textarea')
    await ta.fill(q); await ta.press('Enter')
    await pg.wait_for_timeout(500); await settle(pg)


async def branch(pg, root, phrase, q):
    await drag_select(pg, root, phrase)
    await pg.wait_for_selector('#pop.show', timeout=3000)
    await pg.locator('#popIn').fill(q); await pg.locator('#popIn').press('Enter')
    await pg.wait_for_timeout(500); await settle(pg)


async def new_chat(pg, q):
    await pg.locator('#newConv').click(); await pg.wait_for_timeout(500)
    await ask_main(pg, q)


async def set_theme(pg, theme):
    """Through the palette menu, as a reader would."""
    await pg.locator('#themeB').click(); await pg.wait_for_timeout(300)
    await pg.evaluate("document.querySelectorAll('.thmenu.open .thgrp[aria-expanded=false]').forEach(b=>b.click())")   # open its sections
    await pg.locator(f'.thmenu button[data-theme="{theme}"]').click(); await pg.wait_for_timeout(300)
    if await pg.locator('.thmenu.open').count(): await pg.keyboard.press('Escape')
    await pg.mouse.move(W - 5, H - 5); await pg.wait_for_timeout(800)


async def tops(pg, sel='.pane .pb'):
    await pg.evaluate(f"document.querySelectorAll({sel!r}).forEach(e=>e.scrollTop=0)")


async def shot(pg, name):
    await pg.mouse.move(W - 5, H - 5)   # nothing hovered
    await pg.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur(); getSelection().removeAllRanges()")
    await pg.wait_for_timeout(900)
    await pg.screenshot(path=os.path.join(HERE, name))


def save_gif(frames, path, width=GIF_W, tail=2.8):
    if os.environ.get('PILLOW_PATH'): sys.path.insert(0, os.environ['PILLOW_PATH'])  # Pillow installed somewhere else
    from PIL import Image
    imgs, durs = [], []
    for i, (t, png) in enumerate(frames):
        im = Image.open(io.BytesIO(png)).convert('RGB')
        if im.width != width: im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        imgs.append(im)
        nxt = frames[i + 1][0] if i + 1 < len(frames) else t + tail  # hold the last frame
        durs.append(max(40, round((nxt - t) * 1000 / 10) * 10))
    # drop frames identical to the one before (adding their time to it): smaller file, same motion
    out, od = [imgs[0]], [durs[0]]
    for im, d in zip(imgs[1:], durs[1:]):
        if im.tobytes() == out[-1].tobytes(): od[-1] += d
        else: out.append(im); od.append(d)
    # one shared palette keeps the colours steady from frame to frame
    pal = out[-1].quantize(colors=255, method=Image.MEDIANCUT)
    q = [im.quantize(palette=pal, dither=Image.NONE) for im in out]
    q[0].save(path, save_all=True, append_images=q[1:], duration=od, loop=0, optimize=True, disposal=1)


async def main():
    tmp = tempfile.mkdtemp(prefix='digress-media-')
    proc, url, _ = start_server(tmp)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(args=['--no-sandbox'], **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
            # print the lecture notes to a PDF
            np_ = await b.new_page(); await np_.set_content(NOTES); pdf = os.path.join(tmp, 'attention-notes.pdf')
            await np_.pdf(path=pdf, format='A5', print_background=True); await np_.close()

            ctx = await b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=SCALE,
                                      color_scheme='light', service_workers='block')
            pg = await ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            async def route(r):
                u = r.request.url
                for k, v in MAP.items():
                    if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
                await r.continue_()
            await pg.route('**/*', route)
            await pg.goto(url); await pg.wait_for_timeout(1500)
            await pg.evaluate("document.fonts.ready")
            await set_theme(pg, 'light')

            # 0. a couple of older conversations, so the sidebar looks lived in
            await new_chat(pg, Q_SKY)
            await new_chat(pg, Q_PVAL)

            # 1. the document conversation
            await pg.locator('#newDoc').click(); await pg.wait_for_timeout(300)
            await pg.set_input_files('#docFile', pdf)
            await pg.locator('#docGo').click(); await pg.wait_for_timeout(3000)
            await ask_main(pg, Q_DOC)
            await branch(pg, '.pane[data-tid=doc] .dpage[data-page="2"] .textLayer', 'a positional encoding is added', Q_POS)
            await pg.wait_for_timeout(1500)   # saved
            await pg.evaluate(SEED_CARDS, CARDS)
            await pg.reload(); await pg.wait_for_timeout(2500); await settle(pg)
            await pg.locator('#tSide').click(); await pg.wait_for_timeout(600)
            await pg.evaluate(FIND, ['.pane[data-tid=doc] .dpage[data-page="2"] .textLayer', 'Where is word order', True])
            await tops(pg, '.pane:not([data-tid=doc]) .pb')
            await shot(pg, 'document.png')

            # 2. a plain conversation: ask, then record a branch being made (a smaller window, so the GIF
            #    is shown near its real size; the sidebar stays hidden from here to the Columns shot)
            await pg.locator('#tSide').click(); await pg.wait_for_timeout(400)
            await new_chat(pg, Q_MAIN)
            await pg.locator('#tSide').click()
            await pg.set_viewport_size({'width': GIF_W, 'height': GIF_H}); await pg.wait_for_timeout(600)
            await pg.evaluate(CURSOR)
            main_body = '.pane[data-tid=main] .msg.assistant .body'
            await pg.evaluate(FIND, [main_body, 'Score every query', 'start'])
            await pg.mouse.move(GIF_W - 220, GIF_H - 130); await pg.wait_for_timeout(800)
            pace(tmp, first=1100, delay=9)
            rec = Recorder(pg); await rec.start()
            await rec.hold(0.8)
            await drag_select(pg, main_body, 'the square root of the key dimension', steps=18, glide=24, scroll=False)
            await pg.wait_for_selector('#pop.show', timeout=3000); await rec.hold(0.6)
            await pg.locator('#popIn').click()
            await pg.keyboard.type(Q_SQRT, delay=55); await rec.hold(0.4)
            await pg.keyboard.press('Enter')
            await pg.mouse.move(GIF_W - 200, GIF_H // 2 + 60, steps=16)
            await pg.wait_for_timeout(500); await settle(pg, 500)
            for _ in range(12):   # scroll the new branch back up to its question
                await pg.mouse.wheel(0, -160); await pg.wait_for_timeout(45)
            await pg.wait_for_timeout(400)
            await pg.mouse.move(GIF_W - 330, GIF_H - 40, steps=10)
            await rec.hold(0.3)
            await rec.stop()
            save_gif(rec.frames, os.path.join(HERE, 'branching.gif'))
            pace(tmp)
            await pg.evaluate("document.getElementById('__cur')?.remove()")
            await pg.set_viewport_size({'width': W, 'height': H}); await pg.wait_for_timeout(600)

            # 3. Columns: the main thread, its branch, and a branch of that branch, which carried a takeaway
            #    back into its parent. A sibling branch exists (it shows in the canvas) but its pane is closed.
            await branch(pg, main_body, 'multi-head attention', Q_HEADS)
            await pg.locator('.pane', has_text=Q_HEADS).last.locator('[data-act=close]').click(); await pg.wait_for_timeout(600)
            sqrt_body = '.pane:not([data-tid=main]) .msg.assistant .body'
            await branch(pg, sqrt_body, 'the gradient through softmax almost vanishes', Q_GRAD)
            pane = pg.locator('.pane', has_text=Q_GRAD).last
            await pane.locator('[data-act=take]').first.click(); await pg.wait_for_timeout(300)
            await pane.locator('.tk .go').click(); await pg.wait_for_timeout(500); await settle(pg)
            await pg.evaluate(FIND, [main_body, 'Score every query', 'start'])
            await tops(pg, '.pane:not([data-tid=main]) .pb')
            # the branch's own branch and the takeaway it sent back, ending on a whole line at the top
            await pg.evaluate("""() => { const pb = [...document.querySelectorAll('.pane:not([data-tid=main]) .pb')][0];
              pb.scrollTop = pb.scrollHeight; const top = pb.getBoundingClientRect().top;
              const w = document.createTreeWalker(pb, NodeFilter.SHOW_TEXT); let n;
              while ((n = w.nextNode())) { const r = document.createRange(); r.selectNodeContents(n);
                for (const q of r.getClientRects()) if (q.bottom > top && q.top < top + 4) { pb.scrollTop -= top - q.top + 10; return } } }""")
            await shot(pg, 'columns.png')

            # 4. the whole tree on the canvas, in a dark theme, with the sidebar (a little wider) back
            await pg.locator('#tSide').click(); await pg.wait_for_timeout(500)
            g = await pg.locator('#sgrip').bounding_box()
            await pg.mouse.move(g['x'] + 3, g['y'] + 300); await pg.mouse.down()
            await pg.mouse.move(g['x'] + 3 + SIDE_EXTRA, g['y'] + 300, steps=6); await pg.mouse.up()
            await set_theme(pg, 'dark')
            await pg.locator('[data-v=canvas]').click(); await pg.wait_for_timeout(1500)
            await pg.locator('.cnode', has_text=Q_SQRT).first.locator('[data-cact=exp]').click(); await pg.wait_for_timeout(800)
            await pg.locator('#zFit').click(); await pg.wait_for_timeout(900)
            await shot(pg, 'canvas.png')
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
