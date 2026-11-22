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
  const prefixKey = (t) => JSON.stringify([t.anchorMsg, t.anchorText || '', t.anchorPage ?? null, t.anchorRegion || null, t.regionText || '', ...(t.anchorImg ? [t.anchorImg] : []), ...(t.anchorShot ? [t.anchorShot.asset || (t.anchorShot.data || '').length] : [])]);
  function signature(c, mid, o = {}) {
    const m = c.msgs[mid], out = [];
    let stop = false;
    walk(c, m.thread, (x, pre) => {
      if (stop) return;
      if (x.id === mid) { stop = true; if (pre) out.push('P' + prefixKey(pre)); return; }
      if (x.role === 'note' && o.notes === false) return;
      out.push(x.id + (pre ? '|P' + prefixKey(pre) : '') + (x.role === 'note' ? '|N' + (o.titles === false ? x.fromThread : noteTitle(c, x)) : ''));
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

  // Delete a takeaway. Another version that started right after it now starts where it did (the takeaway was
  // the only thing between). A branch about a passage of it would lose its passage, so that refuses.
  function removeNote(c, mid) {
    const m = c.msgs[mid]; if (!m || m.role !== 'note') throw new Error('removeNote: not a takeaway');
    const ord = c.order[m.thread], i = ord.indexOf(mid), prev = i > 0 ? ord[i - 1] : 'START';
    const on = Object.values(c.threads).filter((t) => t.anchorMsg === mid);
    if (on.some((t) => !t.alt)) throw new Error('a branch starts from a passage of this takeaway');
    if (prev === 'START' && prefixed(T(c, m.thread)) && on.length) throw new Error('another version starts right after it');
    for (const t of on) t.anchorMsg = prev;
    c.order[m.thread] = ord.filter((x) => x !== mid); delete c.msgs[mid];
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


  // ---- merging two devices' changes ------------------------------------------------------------
  // A page saves the whole conversation, saying which version it started from. If another device saved in
  // between, the server refuses and sends its copy, and the page merges: base (what it started from), mine
  // (its copy now) and theirs (the server's). Layout isn't part of this: it's per device.
  //
  //  - Anything changed on one side only: that side's change. Changed on both: mine (my save comes later).
  //    Deleted on one side: deleted. Counters and times: the larger.
  //  - A reply the server finished while no page was watching (runs.mjs) beats the waiting copy of it.
  //  - Both sides went on from the same point in a thread: theirs stays, mine becomes another version
  //    starting there (an alt thread; for a side branch's first question, a sibling branch on the same passage).
  //  - A reply or question changed in place (Redo/Edit) on one side while the other built on the old one
  //    (went on after it, or branched from it), or changed differently on both: the one built on stays,
  //    the other becomes another version.
  // Then the result must pass check() and every message must see exactly what it saw on the side it came
  // from (signature). If not, merge throws {conflict}, and the page keeps both instead (a copy).
  // keep: ids of messages being written right now on this page, which mustn't get new ids: throws {later}.
  const sortKeys = (x) => (Array.isArray(x) ? x.map(sortKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x);
  const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  function merge3(b, m, t) {
    if (same(m, b)) return copy(t);
    if (same(t, b) || same(m, t)) return copy(m);
    if (isObj(m) && isObj(t)) {
      const bb = isObj(b) ? b : {}, out = {};
      for (const k of new Set([...Object.keys(bb), ...Object.keys(m), ...Object.keys(t)])) {
        if (has(bb, k) && (!has(m, k) || !has(t, k))) continue;   // deleted on one side
        if (!has(m, k)) { out[k] = copy(t[k]); continue; }
        if (!has(t, k)) { out[k] = copy(m[k]); continue; }
        out[k] = merge3(bb[k], m[k], t[k]);
      }
      return out;
    }
    return copy(m);
  }
  const CONTENT = ['content', 'images'];
  const contentOf = (x) => x && CONTENT.map((k) => x[k]);

  function merge(base, mine, theirs, o = {}) {
    const newId = o.newId || (() => 'x' + Math.random().toString(36).slice(2, 10));
    const keep = new Set(o.keep || []);
    const conflict = (why) => { throw { conflict: true, message: why }; };
    const B = base, M = mine, Th = theirs;
    const out = {};
    // everything but messages, threads and orders
    for (const k of new Set([...Object.keys(B), ...Object.keys(M), ...Object.keys(Th)])) {
      if (['msgs', 'threads', 'order', 'rev'].includes(k)) continue;
      if (k === 'updated' || k === 'nextColor') { out[k] = Math.max(M[k] || 0, Th[k] || 0); continue; }
      if (has(B, k) && (!has(M, k) || !has(Th, k))) continue;
      out[k] = !has(M, k) ? copy(Th[k]) : !has(Th, k) ? copy(M[k]) : merge3(B[k], M[k], Th[k]);
    }
    if (has(Th, 'rev')) out.rev = Th.rev;
    out.threads = merge3(B.threads || {}, M.threads || {}, Th.threads || {});
    // a branch one side deleted while it was still empty, which the other side went on to ask in: keep it
    for (const [side, other] of [[M, Th], [Th, M]]) for (const tid of Object.keys(B.threads || {})) {
      if (!out.threads[tid] && side.threads[tid] && !other.threads[tid] && !((B.order || {})[tid] || []).length && ((side.order || {})[tid] || []).length) out.threads[tid] = copy(side.threads[tid]);
    }
    out.msgs = {};
    const bm = B.msgs || {}, mm = M.msgs || {}, tm = Th.msgs || {};
    for (const id of new Set([...Object.keys(bm), ...Object.keys(mm), ...Object.keys(tm)])) {
      if (has(bm, id) && (!has(mm, id) || !has(tm, id))) continue;
      if (!has(mm, id)) { out.msgs[id] = copy(tm[id]); continue; }
      if (!has(tm, id)) { out.msgs[id] = copy(mm[id]); continue; }
      const b = bm[id], m = mm[id], t = tm[id];
      if (b && b.run && !t.run && m.run) { out.msgs[id] = copy(t); continue; }   // the server finished it meanwhile
      if (b && b.run && !m.run && t.run) { out.msgs[id] = copy(m); continue; }
      out.msgs[id] = merge3(b, m, t);
    }

    // orders. First the skeleton: each thread as one side has it (the side that changed it; theirs if both
    // did). Messages only one side has that aren't placed by that are attached after the message they came
    // after, wherever it is now (a swap may have moved it): at the end of its thread, or as another version
    // starting there when something else already follows it.
    const bo = B.order || {}, mo = M.order || {}, to = Th.order || {};
    const skeleton = (smart) => {
      const o = {};
      for (const tid of Object.keys(out.threads)) {
        const b = bo[tid], m = mo[tid], t = to[tid];
        if (!b || !m || !t) o[tid] = [...(t || m || [])];
        else if (smart && same(t, b)) o[tid] = [...m];
        else o[tid] = [...t];
        o[tid] = o[tid].filter((id) => out.msgs[id]);
      }
      const seen = new Set();
      for (const ids of Object.values(o)) for (const id of ids) { if (seen.has(id)) return null; seen.add(id); }
      return o;
    };
    out.order = skeleton(true) || skeleton(false);
    if (!out.order) conflict('both devices moved the same messages between threads');
    for (const tid of Object.keys(out.order)) if (!out.order[tid]) delete out.order[tid];
    const where = new Map();
    const relist = () => { where.clear(); for (const [tid, ids] of Object.entries(out.order)) for (const id of ids) where.set(id, tid); };
    relist();
    const placed = new Map();   // message -> the thread it was attached to
    const versionThread = (tid, anchor) => {
      const t = out.threads[tid], id = newId('t');
      if (anchor === 'START' && prefixed(t)) {   // a side branch's first question: a sibling branch on the same passage
        out.threads[id] = { ...copy(t), id };
        delete out.threads[id].pinned; delete out.threads[id].hidden; delete out.threads[id].resolved;
      } else out.threads[id] = { id, parent: tid, anchorMsg: anchor, anchorText: '', title: t.title, colorIdx: t.colorIdx, alt: true };
      out.order[id] = [];
      return id;
    };
    const attach = (ids, anchor, tid) => {   // anchor: a message now in out, or 'START' of thread tid
      let to2;
      if (anchor === 'START') { if (!out.threads[tid]) return false; to2 = out.order[tid] && !out.order[tid].length ? tid : versionThread(tid, 'START'); }
      else { const r = where.get(anchor); if (!r) return false; const ord = out.order[r]; to2 = ord[ord.length - 1] === anchor ? r : versionThread(r, anchor); }
      for (const id of ids) { out.order[to2].push(id); where.set(id, to2); placed.set(id, to2); }
      return true;
    };
    // Repeated until nothing more fits: one side's run can come after a message the other side places first.
    // A run whose predecessor was deleted (not just a takeaway) was in a deleted branch: it's dropped.
    for (let progress = true; progress;) {
      progress = false;
      for (const side of [Th, M]) {
        for (const [tid, ord] of Object.entries(side.order || {})) {
          for (let i = 0; i < ord.length;) {
            if (where.has(ord[i]) || !out.msgs[ord[i]]) { i++; continue; }
            let j = i; while (j < ord.length && !where.has(ord[j]) && out.msgs[ord[j]]) j++;
            const run = ord.slice(i, j);
            let k = i - 1; while (k >= 0 && !out.msgs[ord[k]] && side.msgs[ord[k]].role === 'note') k--;   // past deleted takeaways
            if (k >= 0) { if (where.has(ord[k])) progress = attach(run, ord[k], tid) || progress; }
            else {
              const t = side.threads[tid];
              const fresh = t && t.anchorMsg !== 'START' && t.anchorMsg !== 'DOC' && t.parent && !(B.threads || {})[tid];
              if (!(fresh && !out.threads[tid])) progress = attach(run, 'START', tid) || progress;
            }
            i = j;
          }
        }
      }
    }
    // a branch starts in whichever thread its starting message is in now
    for (const t of Object.values(out.threads)) if (t.id !== 'main' && t.anchorMsg !== 'START' && t.anchorMsg !== 'DOC' && where.has(t.anchorMsg)) t.parent = where.get(t.anchorMsg);
    for (const [id, tid] of where) out.msgs[id].thread = tid;

    // changed in place on one side while the other built on it (or changed it too): fork the question and reply
    const builtOn = (side, id) => {
      const x = side.msgs[id]; if (!x) return false;
      const ord = (side.order || {})[x.thread] || [], bord = (B.order || {})[x.thread] || [];
      const after = ord.slice(ord.indexOf(id) + 1).some((y) => !bord.includes(y));
      return after || Object.values(side.threads || {}).some((t) => t.anchorMsg === id && !(B.threads || {})[t.id]);
    };
    const copies = new Map();   // new id -> [side, original id]
    const done = new Set();
    for (const id of Object.keys(bm)) {
      if (done.has(id) || !mm[id] || !tm[id] || !out.msgs[id] || bm[id].run) continue;
      const cm = !same(contentOf(mm[id]), contentOf(bm[id])) || (!!mm[id].run && !bm[id].run);
      const ct = !same(contentOf(tm[id]), contentOf(bm[id])) || (!!tm[id].run && !bm[id].run);
      let lose = null;
      if (cm && ct && !same(contentOf(mm[id]), contentOf(tm[id]))) lose = M;
      else if (cm && builtOn(Th, id)) lose = M;
      else if (ct && builtOn(M, id)) lose = Th;
      if (!lose) continue;
      const win = lose === M ? Th : M, x = lose.msgs[id], tid = x.thread, ord = lose.order[tid] || [];
      // the question and its reply, in the side that loses
      let q = x.role === 'user' ? id : null;
      if (!q) for (let k = ord.indexOf(id) - 1; k >= 0; k--) { const y = lose.msgs[ord[k]]; if (y && y.role === 'user') { q = ord[k]; break; } if (y && y.role === 'assistant') break; }
      if (!q) conflict('a reply changed in place has no question before it');
      const qi = ord.indexOf(q), r = lose.msgs[ord[qi + 1]] && lose.msgs[ord[qi + 1]].role === 'assistant' ? ord[qi + 1] : null;
      const pair = [q, ...(r ? [r] : [])];
      if (pair.some((p) => keep.has(p) && lose === M)) throw { later: true, message: 'a reply here is still being written' };
      for (const p of pair) { done.add(p); if (win.msgs[p]) out.msgs[p] = copy(win.msgs[p]); else delete out.msgs[p]; }
      // the other version starts where the question is now (the other side may have moved it)
      const home = where.get(q); if (!home || !out.threads[home]) continue;
      const hi = out.order[home].indexOf(q), before = hi > 0 ? out.order[home][hi - 1] : 'START';
      const vt = versionThread(home, before);
      for (const p of pair) {
        const nid = newId('m');
        out.msgs[nid] = { ...copy(lose.msgs[p]), id: nid, thread: vt };
        delete out.msgs[nid].run;
        out.order[vt].push(nid); copies.set(nid, [lose, p]);
      }
      if (r && !win.msgs[r]) for (const k of Object.keys(out.order)) out.order[k] = out.order[k].filter((y) => y !== r);
    }

    // tidy: whatever lost its thread or its place goes with it
    const listedNow = () => { const l = new Set(); for (const ids of Object.values(out.order)) for (const id of ids) if (out.msgs[id]) l.add(id); return l; };
    for (let again = true; again;) {
      again = false; const l = listedNow();
      for (const t of Object.values(out.threads)) {
        if (t.id === 'main') continue;
        let anchorGone = t.anchorMsg !== 'START' && t.anchorMsg !== 'DOC' && !l.has(t.anchorMsg);
        if (anchorGone && t.alt) {   // another version that started right after a takeaway that was deleted: it starts where that did
          for (const side of [M, Th, B]) {
            const n = (side.msgs || {})[t.anchorMsg]; if (!n || n.role !== 'note') continue;
            const ord = (side.order || {})[n.thread] || []; let k = ord.indexOf(t.anchorMsg) - 1;
            while (k >= 0 && !l.has(ord[k])) k--;
            if (k >= 0) { t.anchorMsg = ord[k]; anchorGone = false; } else if (!prefixed(out.threads[t.parent] || {})) { t.anchorMsg = 'START'; anchorGone = false; }
            break;
          }
        }
        // another version from the start of a version that was deleted (the other side's swap put other messages
        // in it first): it's a version from wherever that one started
        for (let p; t.alt && t.anchorMsg === 'START' && !out.threads[t.parent] && (p = [M, Th, B].map((x) => (x.threads || {})[t.parent]).find(Boolean)) && p.alt;) { t.parent = p.parent; t.anchorMsg = p.anchorMsg; }
        if (t.anchorMsg !== 'START' && t.anchorMsg !== 'DOC' && l.has(t.anchorMsg) && where.has(t.anchorMsg)) t.parent = where.get(t.anchorMsg);
        // otherwise the branch it came from was deleted
        if (!out.threads[t.parent] || anchorGone) { delete out.threads[t.id]; delete out.order[t.id]; again = true; }
      }
    }
    for (const tid of Object.keys(out.order)) if (!out.threads[tid]) delete out.order[tid];
    for (const tid of Object.keys(out.threads)) out.order[tid] = (out.order[tid] || []).filter((id) => out.msgs[id]);
    const listed = new Map();
    for (const [tid, ids] of Object.entries(out.order)) for (const id of ids) listed.set(id, tid);
    for (const [id, x] of Object.entries(out.msgs)) { if (!listed.has(id)) delete out.msgs[id]; else x.thread = listed.get(id); }

    const bad = check(out);
    if (bad.length) conflict(bad[0]);
    // every message sees what it saw where it came from (a copy: with the copies' new ids read as the originals)
    // (takeaways left out: deleting one changes what later messages see, on one device as much as on two)
    const sig = (c, id) => signature(c, id, { titles: false, notes: false });
    const asOriginal = (text) => text.split('\n').map((l) => { for (const [n, [, orig]] of copies) if (l.startsWith(n)) return orig + l.slice(n.length); return l; }).join('\n');
    for (const id of Object.keys(out.msgs)) {
      const now = sig(out, id);
      if (copies.has(id)) { const [side, orig] = copies.get(id); if (asOriginal(now) === sig(side, orig)) continue; }
      else if ((Th.msgs[id] && sig(Th, id) === now) || (M.msgs[id] && sig(M, id) === now)) continue;
      conflict(`message ${id} would see something different`);
    }
    return { conv: out, moved: [...placed.keys()].filter((id) => !(Th.msgs || {})[id]), copies: [...copies.keys()] };
  }

  return { ancestors, walk, signature, check, split, join, swap, versionsAt, prefixed, merge, removeNote };
})();
if (typeof module !== 'undefined') module.exports = ThreadOps;
