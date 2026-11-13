// Random conversations, random thread operations: after every split, join and swap, every message must see
// exactly what it saw before (ThreadOps.signature) and nothing may break the shape (ThreadOps.check). An
// operation that refuses must leave everything untouched. Run by tests/test_threads.py.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(new URL('../web/threads.js', import.meta.url), 'utf8');
const ctx = {}; vm.createContext(ctx); vm.runInContext(src + '\nthis.ThreadOps = ThreadOps;', ctx);
const O = ctx.ThreadOps;

let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
let fails = 0, ops = { split: 0, join: 0, swap: 0, refused: 0 };
const fail = (msg) => { fails++; if (fails < 8) console.log('FAIL', msg); };

function run(s, steps) {
  seed = s; let n = 0;
  const id = (p) => p + (++n);
  const c = { id: 'c', threads: { main: { id: 'main', title: 'Main' } }, msgs: {}, order: { main: [] }, ui: { open: ['main'], collapsed: [], cv: { open: [], pos: {} } }, cards: { done: {} } };
  const cards = [];
  const add = (tid, role, extra) => { const m = { id: id('m'), thread: tid, role, content: role + n, ...(extra || {}) }; c.msgs[m.id] = m; c.order[tid].push(m.id); return m; };
  const send = (tid) => { add(tid, 'user'); const r = add(tid, 'assistant'); c.cards.done[tid] = r.id; };
  const threads = () => Object.keys(c.threads);
  const alts = () => Object.values(c.threads).filter((t) => t.alt).map((t) => t.id);
  send('main');
  for (let k = 0; k < steps; k++) {
    const before = JSON.stringify([c, cards]);
    const sig = Object.fromEntries(Object.keys(c.msgs).map((m) => [m, O.signature(c, m)]));
    const what = pick(['send', 'send', 'branch', 'doc', 'note', 'card', 'alt', 'split', 'split', 'join', 'swap', 'swap']);
    let rearranged = false;
    try {
      if (what === 'send') send(pick(threads()));
      else if (what === 'branch') {
        const replies = Object.values(c.msgs).filter((m) => m.role === 'assistant'); if (!replies.length) continue;
        const r = pick(replies), t = { id: id('t'), title: 'b' + n, parent: r.thread, anchorMsg: r.id, anchorText: rnd() < 0.5 ? 'quote' + n : '' };
        c.threads[t.id] = t; c.order[t.id] = []; send(t.id);
      } else if (what === 'doc') { const t = { id: id('t'), title: 'd' + n, parent: 'main', anchorMsg: 'DOC', anchorText: 'passage' + n, anchorPage: n % 5 }; c.threads[t.id] = t; c.order[t.id] = []; send(t.id); }
      else if (what === 'note') { const b = pick(threads().filter((x) => x !== 'main')); if (!b) continue; add(c.threads[b].parent, 'note', { fromThread: b }); }
      else if (what === 'card') { const r = pick(Object.values(c.msgs).filter((m) => m.role === 'assistant')); cards.push({ id: id('k'), conv: 'c', thread: r.thread, at: { thread: r.thread, msg: r.id } }); }
      else if (what === 'alt') {   // what Redo does when a reply can't be replaced: another version from its question
        const qs = Object.values(c.msgs).filter((m) => m.role === 'user'); const q = pick(qs);
        const ord = c.order[q.thread], i = ord.indexOf(q.id), t = c.threads[q.thread];
        if (i === 0 && O.prefixed(t)) continue;   // the first question of a side branch: not offered
        const a = { id: id('t'), title: 'v' + n, parent: q.thread, anchorMsg: i ? ord[i - 1] : 'START', alt: true };
        c.threads[a.id] = a; c.order[a.id] = []; send(a.id);
      } else if (what === 'split') {
        const tid = pick(threads()), ord = c.order[tid]; if (!ord.length) continue;
        O.split(c, cards, tid, pick(ord), { id: id('t'), title: 's' + n }); ops.split++; rearranged = true;
      } else if (what === 'join') { const a = pick(alts()); if (!a) continue; O.join(c, cards, a); ops.join++; rearranged = true; }
      else if (what === 'swap') { const a = pick(alts()); if (!a) continue; O.swap(c, cards, a); ops.swap++; rearranged = true; }
    } catch (e) {
      ops.refused++;
      if (JSON.stringify([c, cards]) !== before) fail(`seed ${s} step ${k}: ${what} refused (${e.message}) but changed things`);
      continue;
    }
    const bad = O.check(c, cards); if (bad.length) { fail(`seed ${s} step ${k} after ${what}: ${bad.slice(0, 3).join('; ')}`); return; }
    if (rearranged) for (const [m, g] of Object.entries(sig)) if (O.signature(c, m) !== g) { fail(`seed ${s} step ${k}: ${what} changed what ${m} sees\n before: ${g}\n after:  ${O.signature(c, m)}`); return; }
  }
}
for (let s = 1; s <= 400; s++) run(s, 80);
console.log(`ops: ${JSON.stringify(ops)}`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
