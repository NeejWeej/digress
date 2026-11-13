// How a conversation's messages hang together, and the operations that rearrange its threads.
//
// The truth is a tree of messages: each message comes after the one before it in its thread, and a
// branch's first message comes after its anchor (anchorMsg) in the parent thread ('START': before the
// parent's first message; 'DOC': off the document, so nothing of the parent). What a message saw when it
// was written is everything on that path. Threads (each with a title, color and pane) are only a way of
// cutting that tree into straight runs.
//
// split, join and swap change how the tree is cut into threads, never the tree itself, so every message
// keeps exactly the context it had. check() lists anything that breaks the shape, and signature() says what
// a message sees, so tests/test_threads.py can run thousands of random operations and compare.
//
// Pure functions on a conversation object (and the flashcards list); no page globals. Loaded by index.html.

const ThreadOps = (() => {
  const T = (c, id) => c.threads[id];

  // the thread ids from main down to tid
  function ancestors(c, tid) { const p = []; let t = T(c, tid); while (t) { p.unshift(t.id); t = t.parent ? T(c, t.parent) : null; } return p; }

  // A side question's first message gets a prefix saying what it's about (index.html: branchParts). Another
  // version of a reply ('alt') doesn't: it's the same conversation going another way.
  const prefixed = (t) => !!t.parent && !t.alt;

  // Calls fn(message, prefixThread) for each message on tid's path, in order: prefixThread is the thread
  // whose prefix goes before this message, or null. buildContext uses this, so what it sends and what
  // signature() checks are the same thing.
  function walk(c, tid, fn) {
    const path = ancestors(c, tid);
    path.forEach((id, i) => {
      const t = T(c, id); let mids = c.order[id] || [];
      if (i < path.length - 1) { const k = mids.indexOf(T(c, path[i + 1]).anchorMsg); mids = mids.slice(0, k + 1); }
      let firstUser = true;
      for (const mid of mids) {
        const m = c.msgs[mid]; if (!m) continue;
        let pre = null;
        if (m.role === 'user') { if (firstUser && prefixed(t)) pre = t; firstUser = false; }
        fn(m, pre);
      }
    });
  }

  // what a message sees: the messages before it, with each prefix and takeaway label as it would be sent
  const noteTitle = (c, m) => (T(c, m.fromThread) ? T(c, m.fromThread).title : m.fromTitle || '(deleted)');
  const prefixKey = (t) => JSON.stringify([t.anchorMsg, t.anchorText || '', t.anchorPage ?? null, t.anchorRegion || null, t.regionText || '']);
  function signature(c, mid) {
    const m = c.msgs[mid], out = [];
    let stop = false;
    walk(c, m.thread, (x, pre) => {
      if (stop) return;
      if (x.id === mid) { stop = true; if (pre) out.push('P' + prefixKey(pre)); return; }
      out.push(x.id + (pre ? '|P' + prefixKey(pre) : '') + (x.role === 'note' ? '|N' + noteTitle(c, x) : ''));
    });
    return out.join('\n');
  }

  // Everything that must hold; returns a list of problems (empty when all is well).
  function check(c, cards) {
    const bad = [], seen = new Map();
    if (!T(c, 'main') || T(c, 'main').parent) bad.push('no root thread "main"');
    for (const [tid, ids] of Object.entries(c.order)) {
      if (!T(c, tid)) bad.push(`order lists a missing thread ${tid}`);
      for (const id of ids) {
        if (seen.has(id)) bad.push(`message ${id} is in ${seen.get(id)} and ${tid}`); seen.set(id, tid);
        const m = c.msgs[id]; if (!m) bad.push(`order of ${tid} lists a missing message ${id}`); else if (m.thread !== tid) bad.push(`message ${id} says ${m.thread} but is in ${tid}`);
      }
    }
    for (const id of Object.keys(c.msgs)) if (!seen.has(id)) bad.push(`message ${id} is in no thread`);
    for (const t of Object.values(c.threads)) {
      if (!c.order[t.id]) bad.push(`thread ${t.id} has no order`);
      if (t.id === 'main') continue;
      const p = T(c, t.parent);
      if (!p) { bad.push(`thread ${t.id}: missing parent ${t.parent}`); continue; }
      if (t.anchorMsg === 'DOC') { if (t.parent !== 'main') bad.push(`thread ${t.id}: a document branch off ${t.parent}`); }
      else if (t.anchorMsg === 'START') { if (!t.alt || prefixed(p)) bad.push(`thread ${t.id}: starts before its parent's first message, which only another version of an unprefixed thread can`); }
      else if (!(c.order[t.parent] || []).includes(t.anchorMsg)) bad.push(`thread ${t.id}: anchor ${t.anchorMsg} isn't in its parent ${t.parent}`);
      if (ancestors(c, t.id)[0] !== 'main') bad.push(`thread ${t.id}: not under main (a cycle?)`);
    }
    for (const k of (c.ui && c.ui.open) || []) if (k !== 'doc' && !T(c, k)) bad.push(`an open pane for missing thread ${k}`);
    for (const card of cards || []) {
      if (card.conv !== c.id || !card.at) continue;
      const m = c.msgs[card.at.msg];
      if (m && card.at.thread !== m.thread) bad.push(`card ${card.id} points at ${card.at.thread} but its message is in ${m.thread}`);
    }
    return bad;
  }

  // ---- the operations. Each checks what it needs first and throws without changing anything if it can't.
  // They return the cards they changed, for the caller to save.

  // these messages now belong to thread `to`: so do the branches that start from them, and the cards made from them
  function relabel(c, cards, ids, to) {
    const set = new Set(ids), changed = [];
    for (const id of ids) c.msgs[id].thread = to;
    for (const t of Object.values(c.threads)) if (set.has(t.anchorMsg)) t.parent = to;
    for (const card of cards || []) {
      if (card.conv !== c.id || !card.at || !set.has(card.at.msg)) continue;
      if (card.thread === card.at.thread) card.thread = to;
      card.at.thread = to; changed.push(card);
    }
    return changed;
  }
  const tidyDone = (c) => { const d = c.cards && c.cards.done; if (d) for (const k of Object.keys(d)) if (!T(c, k) || !(c.order[k] || []).includes(d[k])) delete d[k]; };

  // Cut thread tid just before message mid: mid and everything after it move to a new thread (another
  // version, starting where mid did). In a side branch you can't cut before its first message: that
  // message carries the branch's prefix, which a version doesn't have.
  function split(c, cards, tid, mid, fresh) {
    const ord = c.order[tid], i = ord ? ord.indexOf(mid) : -1;
    if (i < 0) throw new Error('split: that message isn’t in this thread');
    if (i === 0 && T(c, tid).parent) throw new Error('split: can’t cut a side branch before its first message');
    if (T(c, fresh.id) || c.order[fresh.id]) throw new Error('split: that thread id is taken');
    const tail = ord.slice(i);
    c.threads[fresh.id] = { ...fresh, parent: tid, anchorMsg: i ? ord[i - 1] : 'START', alt: true };
    c.order[tid] = ord.slice(0, i); c.order[fresh.id] = tail;
    const changed = relabel(c, cards, tail, fresh.id); tidyDone(c);
    return changed;
  }

  // Add version `alt` onto the end of its parent, when the parent ends right where alt starts. alt is gone
  // afterwards; whatever pointed at it points at the parent.
  function join(c, cards, alt) {
    const a = T(c, alt); if (!a || !a.alt) throw new Error('join: not another version');
    const tid = a.parent, ord = c.order[tid];
    if (a.anchorMsg !== (ord.length ? ord[ord.length - 1] : 'START')) throw new Error('join: its parent goes on past where it starts');
    const ids = c.order[alt];
    for (const m of Object.values(c.msgs)) if (m.role === 'note' && m.fromThread === alt) { m.fromTitle = a.title; }
    const changed = relabel(c, cards, ids, tid);
    c.order[tid] = ord.concat(ids); delete c.order[alt]; delete c.threads[alt];
    // versions that started before alt's first message now start where alt did; nothing else hangs off alt now
    for (const t of Object.values(c.threads)) if (t.parent === alt) { t.parent = tid; if (t.anchorMsg === 'START') t.anchorMsg = a.anchorMsg; }
    const ui = c.ui || {};
    for (const k of ['open', 'collapsed']) if (ui[k]) ui[k] = ui[k].filter((x) => x !== alt);
    if (ui.pz) delete ui.pz[alt];
    if (ui.cv) { for (const k of ['open', 'fold', 'z', 'dock']) if (Array.isArray(ui.cv[k])) ui.cv[k] = ui.cv[k].filter((x) => x !== alt); for (const k of ['pos', 'size', 'cz']) if (ui.cv[k]) delete ui.cv[k][alt]; }
    for (const card of cards || []) if (card.conv === c.id && card.thread === alt) { card.thread = tid; if (!changed.includes(card)) changed.push(card); }
    tidyDone(c);
    return changed;
  }

  // Make version `alt` the one its parent goes on with: the parent's messages after alt's starting point and
  // alt's messages trade places. Both threads keep their ids, titles and panes; only what's in them changes.
  function swap(c, cards, alt) {
    const a = T(c, alt); if (!a || !a.alt) throw new Error('swap: not another version');
    const tid = a.parent, ord = c.order[tid];
    const i = a.anchorMsg === 'START' ? 0 : ord.indexOf(a.anchorMsg) + 1;
    if (a.anchorMsg !== 'START' && i === 0) throw new Error('swap: its starting point isn’t in its parent');
    const mine = ord.slice(i), theirs = c.order[alt];
    if (!theirs.length) throw new Error('swap: that version is empty');
    c.order[tid] = ord.slice(0, i).concat(theirs); c.order[alt] = mine;
    const changed = [...relabel(c, cards, theirs, tid), ...relabel(c, cards, mine, alt)];
    tidyDone(c);
    return changed;
  }

  // the other versions that start where message mid (in its thread) starts: threads marked alt, with the
  // same parent and starting point. Includes the thread itself when mid is the first message of a version.
  function versionsAt(c, mid) {
    const m = c.msgs[mid]; if (!m) return [];
    const ord = c.order[m.thread], i = ord.indexOf(mid), t = T(c, m.thread);
    const out = [];
    const at = (parent, anchor) => { for (const x of Object.values(c.threads)) if (x.alt && x.parent === parent && x.anchorMsg === anchor) out.push(x.id); };
    at(m.thread, i ? ord[i - 1] : 'START');
    if (i === 0 && t.alt) { out.push(t.id); at(t.parent, t.anchorMsg); }
    return [...new Set(out)].filter((x) => x !== m.thread || i === 0);
  }

  return { ancestors, walk, signature, check, split, join, swap, versionsAt, prefixed };
})();
if (typeof module !== 'undefined') module.exports = ThreadOps;
