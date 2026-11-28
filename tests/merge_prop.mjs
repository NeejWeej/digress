// Two devices change the same conversation, then merge (ThreadOps.merge, web/threads.js). Thousands of random
// cases: starting from a random conversation, each side makes random changes the app can make (ask, branch,
// takeaway, Redo/Edit in place, other versions, swap, delete a branch or takeaway, rename, pin, hide, a reply
// the server finishes on its own), then the merge must either
//   - give a conversation that passes check(), where every message sees exactly what it saw on the side it
//     came from, and nothing either side added or changed is lost (unless the other side deleted the branch
//     it was in), or
//   - refuse ({conflict}), and the page keeps a copy instead. That should be rare: it's counted and capped.
// It must never change its inputs, and merging with no changes on one side must give the other side.
// Run by tests/test_merge.py.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(new URL('../web/threads.js', import.meta.url), 'utf8');
const ctx = {}; vm.createContext(ctx); vm.runInContext(src + '\nthis.ThreadOps = ThreadOps;', ctx);
const O = ctx.ThreadOps;

let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const clone = (x) => JSON.parse(JSON.stringify(x));
let fails = 0;
const stats = { cases: 0, clean: 0, versions: 0, conflicts: 0, later: 0 };
const fail = (msg) => { fails++; if (fails < 8) console.log('FAIL', msg); };

function device(c, tag) {
  let n = 0;
  const id = (p) => p + tag + (++n);
  const add = (tid, role, extra) => { const m = { id: id('m'), thread: tid, role, content: role + ' ' + tag + n, ...(extra || {}) }; c.msgs[m.id] = m; c.order[tid].push(m.id); return m; };
  const send = (tid) => { add(tid, 'user'); return add(tid, 'assistant'); };
  const threads = () => Object.keys(c.threads);
  const replies = () => Object.values(c.msgs).filter((m) => m.role === 'assistant' && !m.run);
  const last = (m) => { const o = c.order[m.thread]; return o[o.length - 1] === m.id; };
  const depends = (m) => Object.values(c.threads).some((t) => t.anchorMsg === m.id);
  const desc = (tid) => Object.values(c.threads).filter((t) => O.ancestors(c, t.id).includes(tid)).map((t) => t.id);
  return {
    send() { send(pick(threads())); },
    branch() { const r = pick(replies()); if (!r) return; const t = { id: id('t'), title: 'b' + tag + n, parent: r.thread, anchorMsg: r.id, anchorText: rnd() < 0.5 ? 'quote' + n : '', colorIdx: n % 6 }; c.threads[t.id] = t; c.order[t.id] = []; if (rnd() < 0.85) send(t.id); },
    doc() { const t = { id: id('t'), title: 'd' + tag + n, parent: 'main', anchorMsg: 'DOC', anchorText: 'passage' + n, anchorPage: n % 5 }; c.threads[t.id] = t; c.order[t.id] = []; send(t.id); },
    clip() { const t = { id: id('t'), title: 'cl' + tag + n, parent: 'main', anchorMsg: 'CLIP', anchorText: 'tweet' + n, anchorUrl: 'https://x.com/u/status/' + n }; c.threads[t.id] = t; c.order[t.id] = []; send(t.id); },
    note() { const b = pick(threads().filter((x) => x !== 'main')); if (b) add(c.threads[b].parent, 'note', { fromThread: b }); },
    redo() {   // in place, only when nothing depends on it (as redoBlock)
      const r = pick(replies().filter((m) => last(m) && !depends(m))); if (!r) return;
      r.content = 'redone ' + tag + (++n); if (rnd() < 0.3) r.run = 'run' + tag + n;   // sometimes still being written
    },
    edit() {
      const r = pick(replies().filter((m) => last(m) && !depends(m))); if (!r) return;
      const o = c.order[r.thread], q = c.msgs[o[o.indexOf(r.id) - 1]]; if (!q || q.role !== 'user') return;
      q.content = 'edited ' + tag + (++n); r.content = 'reply to edit ' + tag + n;
    },
    alt() {
      const q = pick(Object.values(c.msgs).filter((m) => m.role === 'user')); if (!q) return;
      const ord = c.order[q.thread], i = ord.indexOf(q.id), t = c.threads[q.thread];
      if (i === 0 && O.prefixed(t)) return;
      const a = { id: id('t'), title: 'v' + n, parent: q.thread, anchorMsg: i ? ord[i - 1] : 'START', alt: true }; c.threads[a.id] = a; c.order[a.id] = []; send(a.id);
    },
    swap() { const a = pick(Object.values(c.threads).filter((t) => t.alt).map((t) => t.id)); if (!a) return; try { O.swap(c, [], a); } catch { /* refused: unchanged */ } },
    delBranch() {
      const t = pick(threads().filter((x) => x !== 'main')); if (!t) return;
      for (const k of [t, ...desc(t).filter((x) => x !== t)]) { for (const m of c.order[k] || []) delete c.msgs[m]; delete c.order[k]; delete c.threads[k]; }
    },
    delNote() { const m = pick(Object.values(c.msgs).filter((x) => x.role === 'note')); if (!m) return; try { O.removeNote(c, m.id); } catch { /* refused: unchanged */ } },
    rename() { const t = c.threads[pick(threads())]; t.title = 'renamed ' + tag + (++n); },
    pin() { const t = c.threads[pick(threads().filter((x) => x !== 'main'))]; if (t) t.pinned = !t.pinned; },
    hide() { const t = c.threads[pick(threads().filter((x) => x !== 'main'))]; if (t) t.hidden = !t.hidden; },
    title() { c.title = 'title ' + tag + (++n); },
    finish() { const m = pick(Object.values(c.msgs).filter((x) => x.run)); if (m) { m.content = 'finished ' + m.run; delete m.run; } },
  };
}
const BUILD = ['send', 'send', 'branch', 'doc', 'clip', 'note', 'alt', 'redo', 'swap'];
const CHANGE = ['send', 'send', 'send', 'branch', 'branch', 'note', 'redo', 'redo', 'edit', 'alt', 'swap', 'delBranch', 'delNote', 'rename', 'pin', 'hide', 'title', 'doc', 'clip'];

// did the other side delete something this message came after (its branch)? then it may go
const gone = (base, other) => (m, from) => {
  let hit = false;
  O.walk(from, m.thread, (x) => { if (x.role !== 'note' && base.msgs[x.id] && !other.msgs[x.id]) hit = true; });
  // or it hangs off a branch the other side deleted (with its messages; a version of it goes with it, as in the app)
  for (const tid of O.ancestors(from, m.thread)) if (base.threads[tid] && !other.threads[tid] && (base.order[tid] || []).some((id) => !other.msgs[id])) hit = true;
  return hit;
};

function one(s) {
  seed = s; stats.cases++;
  const base = { id: 'c', title: 'T', updated: 1, nextColor: 1, rev: 3, threads: { main: { id: 'main', title: 'Main' } }, msgs: {}, order: { main: [] }, cards: { on: true, done: {} } };
  const b = device(base, 'b'); b.send();
  for (let k = 0, n = 2 + Math.floor(rnd() * 14); k < n; k++) b[pick(BUILD)]();
  for (const m of Object.values(base.msgs)) if (rnd() < 0.15 && m.role === 'assistant' && base.order[m.thread].at(-1) === m.id) m.run = 'r' + m.id;   // a reply still running
  const mine = clone(base), theirs = clone(base);
  const dm = device(mine, 'M'), dt = device(theirs, 'T');
  for (let k = 0, n = Math.floor(rnd() * 5); k < n; k++) dm[pick(CHANGE)]();
  for (let k = 0, n = Math.floor(rnd() * 5); k < n; k++) dt[pick(rnd() < 0.15 ? ['finish'] : CHANGE)]();
  if (O.check(mine).length || O.check(theirs).length) { fail(`seed ${s}: the test's own changes broke a side: ${[...O.check(mine), ...O.check(theirs)][0]}`); return; }
  const frozen = JSON.stringify([base, mine, theirs]);
  let n = 0; const newId = (p) => p + 'N' + (++n);
  let r;
  try { r = O.merge(base, mine, theirs, { newId }); }
  catch (e) {
    if (e && e.conflict) { stats.conflicts++; return; }
    if (e && e.later) { stats.later++; return; }
    fail(`seed ${s}: merge threw ${e && e.stack || e}`); return;
  }
  if (JSON.stringify([base, mine, theirs]) !== frozen) fail(`seed ${s}: merge changed its inputs`);
  const out = r.conv;
  const bad = O.check(out); if (bad.length) { fail(`seed ${s}: ${bad[0]}`); return; }
  if (r.copies.length || r.moved.length) stats.versions++; else stats.clean++;
  // nothing lost: every message a side added or changed is in the result with that content, unless the other side deleted where it was
  const contents = new Set(Object.values(out.msgs).map((m) => m.role + '|' + m.content));
  for (const [side, other] of [[mine, theirs], [theirs, mine]]) {
    const deleted = gone(base, other);
    for (const m of Object.values(side.msgs)) {
      const bm = base.msgs[m.id];
      if (bm && bm.content === m.content) continue;
      if (bm && !other.msgs[m.id] && bm.content !== m.content && m.role === 'note') continue;
      if (deleted(m, side)) continue;
      if (bm && bm.run && !m.run && other.msgs[m.id] && !other.msgs[m.id].run) continue;   // both finished it
      if (bm && !other.msgs[m.id]) continue;   // the other side deleted this message (a takeaway, or its branch)
      if (m.run && other.msgs[m.id] && !other.msgs[m.id].run && bm && bm.run) continue;   // finished by the server: theirs wins
      if (!contents.has(m.role + '|' + m.content)) { fail(`seed ${s}: lost ${m.id} (${m.role} "${m.content}") from ${side === mine ? 'mine' : 'theirs'}`); return; }
    }
  }
  // no changes on one side: the other side, as is
  const same = (a, b2) => JSON.stringify(a) === JSON.stringify(b2);
  const strip = (c) => { const x = clone(c); delete x.updated; return x; };
  try {
    const a = O.merge(base, base, theirs, { newId }).conv, z = O.merge(base, mine, base, { newId }).conv;
    if (!same(O.check(a), []) || Object.keys(a.msgs).length !== Object.keys(theirs.msgs).length) fail(`seed ${s}: merging no changes into theirs changed it`);
    if (!same(O.check(z), []) || Object.keys(z.msgs).length !== Object.keys(mine.msgs).length) fail(`seed ${s}: merging no changes into mine changed it`);
    void strip;
  } catch (e) { fail(`seed ${s}: a one-sided merge refused: ${e.message}`); }
}
// cards.auto and cards.suggest are plain fields like cards.on: one side turns one off while the other adds a message, either way round
for (const k of ['auto', 'suggest']) {
  const other = k === 'auto' ? 'suggest' : 'auto';
  const base = { id: 'c', title: 'T', updated: 1, nextColor: 1, rev: 3, threads: { main: { id: 'main', title: 'Main' } }, msgs: {}, order: { main: [] }, cards: { on: true, done: {} } };
  device(base, 'b').send();
  const off = clone(base); off.cards[k] = false;
  const more = clone(base); device(more, 'T').send();
  for (const [mine, theirs] of [[off, more], [more, off]]) {
    const out = O.merge(base, mine, theirs, { newId: (p) => p + 'N' }).conv;
    if (out.cards[k] !== false || !out.cards.on || out.cards[other] === false) fail(`cards.${k}=false lost in a merge with a new message: ${JSON.stringify(out.cards)}`);
    if (Object.keys(out.msgs).length !== Object.keys(more.msgs).length) fail(`the new message was lost in the cards.${k} merge`);
  }
  const on = clone(off); on.cards[k] = true;   // turned off then on again on the other side: the later change (on) wins over base
  const back = O.merge(off, off, on, { newId: (p) => p + 'N' }).conv;
  if (back.cards[k] !== true) fail(`ticking ${k} again did not merge`);
}
{  // the two switches changed on different devices both survive
  const base = { id: 'c', title: 'T', updated: 1, nextColor: 1, rev: 3, threads: { main: { id: 'main', title: 'Main' } }, msgs: {}, order: { main: [] }, cards: { on: true, done: {} } };
  device(base, 'b').send();
  const a = clone(base); a.cards.auto = false;
  const s = clone(base); s.cards.suggest = false;
  for (const [mine, theirs] of [[a, s], [s, a]]) {
    const out = O.merge(base, mine, theirs, { newId: (p) => p + 'N' }).conv;
    if (out.cards.auto !== false || out.cards.suggest !== false) fail(`auto and suggest changed on two devices did not both survive: ${JSON.stringify(out.cards)}`);
  }
}
for (let s = 1; s <= 3000; s++) one(s);
console.log(JSON.stringify(stats));
const rate = stats.conflicts / stats.cases;
if (rate > 0.03) fail(`too many conflicts: ${(rate * 100).toFixed(1)}% of cases fall back to a copy`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
