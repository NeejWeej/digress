// Direct Node unit tests for pure client ES modules (web/js/fsrs.js, web/js/text.js, web/js/share.js).
// Runs in milliseconds with no browser; invoked by tests/test_client_modules.py.
import assert from 'node:assert/strict';
import { DAY, MIN, fsrsNext, ivlText } from '../web/js/fsrs.js';
import { esc, trunc, texText, stripCiteQuotes, plain, pdfTitleOk, passages, indexEntries, idxPages, sigOf } from '../web/js/text.js';
import {
  PUBLIC_DEMO_URL, SHARE_GOOD_LEN, SHARE_MAX_LEN,
  encodeSharePayload, decodeSharePayload, buildShareUrl, parseShareHash, shareSizeStatus, sliceBranch, cardInScope, remapConvIds,
  parseInlineImageDataUrl, normalizePageIndex,
} from '../web/js/share.js';
import { offlineCards } from '../web/js/connectors.js';
import fs from 'node:fs';
import vm from 'node:vm';

const ThreadOps = vm.runInNewContext(fs.readFileSync(new URL('../web/threads.js', import.meta.url), 'utf8') + '\nThreadOps;');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('ok  ', name);
}

// --- fsrs.js ---
test('fsrsNext: new card grades produce monotonic intervals and valid state', () => {
  const now = 1_700_000_000_000;
  const r1 = fsrsNext(null, 1, now);
  const r2 = fsrsNext(null, 2, now);
  const r3 = fsrsNext(null, 3, now);
  const r4 = fsrsNext(null, 4, now);
  assert.equal(r1.fsrs.state, 'learning');
  assert.equal(r1.due, now + MIN);
  assert.equal(r2.fsrs.state, 'learning');
  assert.equal(r2.due, now + 10 * MIN);
  assert.equal(r3.fsrs.state, 'review');
  assert.equal(r4.fsrs.state, 'review');
  assert.ok(r3.due > r2.due && r4.due > r3.due);
  assert.equal(r3.fsrs.reps, 1);
  assert.equal(r3.fsrs.lapses, 0);
});

test('fsrsNext: review card grows stability on Good and lapses on Again', () => {
  const t0 = 1_700_000_000_000;
  const first = fsrsNext(null, 3, t0);
  const t1 = first.due;
  const second = fsrsNext(first.fsrs, 3, t1);
  assert.ok(second.fsrs.S > first.fsrs.S, 'stability should increase after Good');
  assert.equal(second.fsrs.reps, 2);
  assert.equal(second.fsrs.lapses, 0);

  const lapsed = fsrsNext(second.fsrs, 1, second.due);
  assert.equal(lapsed.fsrs.state, 'learning');
  assert.equal(lapsed.fsrs.lapses, 1);
  assert.equal(lapsed.due, second.due + 10 * MIN);
  assert.ok(lapsed.fsrs.S <= second.fsrs.S);
});

test('ivlText formats minutes, hours, days, months, years', () => {
  assert.equal(ivlText(30_000), '1 min');
  assert.equal(ivlText(10 * MIN), '10 min');
  assert.equal(ivlText(3 * 36e5), '3 h');
  assert.equal(ivlText(5 * DAY), '5 d');
  assert.equal(ivlText(60 * DAY), '2 mo');
  assert.equal(ivlText(730 * DAY), '2 y');
});

// --- text.js ---
test('esc escapes HTML entities and trunc normalizes whitespace', () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(trunc('  hello   world  ', 20), 'hello world');
  assert.equal(trunc('abcdefghij', 5), 'abcd…');
});

test('texText turns common LaTeX into readable text', () => {
  assert.equal(texText('\\sqrt{d_k}'), '√d_k');
  assert.equal(texText('\\frac{q \\cdot k}{d}'), 'q · k/d');
  assert.equal(texText('\\mathrm{Var}(x) \\le \\infty'), 'Var(x) ≤ ∞');
});

test('stripCiteQuotes and plain clean markdown, math, and exact citations', () => {
  assert.equal(stripCiteQuotes('See [p. 4 "exact phrase"] and [earlier "prior reply"].'), 'See [p. 4] and [earlier].');
  assert.equal(stripCiteQuotes('[part 2 “smart quotes”] and [doc "intro"]'), '[part 2] and [doc]');
  const md = '# Heading\n\n- item one\n- item two.\n\nSee [p. 3 "variance"] with $\\sqrt{d}$ and [link](https://example.com).\n\n```js\nconst x = 1;\n```\n';
  const out = plain(md);
  assert.equal(out, 'Heading. item one; item two. See [p. 3] with √d and link. [code]');
});

test('pdfTitleOk rejects junk metadata and keeps real titles', () => {
  assert.equal(pdfTitleOk(''), '');
  assert.equal(pdfTitleOk('Untitled'), '');
  assert.equal(pdfTitleOk('Microsoft Word - paper_final_v2.docx'), '');
  assert.equal(pdfTitleOk('/Users/me/Downloads/report.pdf'), '');
  assert.equal(pdfTitleOk('2305.12345v1'), '');
  assert.equal(pdfTitleOk('Slide 1'), '');
  assert.equal(pdfTitleOk('Attention Is All You Need'), 'Attention Is All You Need');
  assert.equal(pdfTitleOk('Microsoft Word - Attention Is All You Need.docx'), 'Attention Is All You Need');
});

test('passages, indexEntries, idxPages, sigOf round-trip cleanly', () => {
  const longPara = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} explains scaled dot-product attention clearly.`).join(' ');
  const ps = passages(longPara);
  assert.ok(ps.length >= 2, 'long paragraph should split into multiple overlapping passages');
  assert.equal(ps[0].o, 0);
  assert.ok(ps[1].o > 0 && ps[1].x.length > ps[1].o);

  const conv = {
    title: 'Transformers',
    threads: { main: { id: 'main', parent: null }, b1: { id: 'b1', parent: 'main', title: 'Scaling', anchorText: 'sqrt(d)' } },
    msgs: { m1: { id: 'm1', thread: 'main', role: 'user', content: 'Why scale?' }, m2: { id: 'm2', thread: 'main', role: 'assistant', content: 'To keep variance at 1.' } },
  };
  const pages = ['Page one intro text.', longPara];
  const entries = indexEntries(conv, pages);
  assert.ok(entries.some(e => e.k === 'ct' && e.x === 'Transformers'));
  assert.ok(entries.some(e => e.k === 'h' && e.x === 'sqrt(d)'));
  assert.ok(entries.some(e => e.k === 'q' && e.x === 'Why scale?'));
  assert.ok(entries.some(e => e.k === 'a' && e.x === 'To keep variance at 1.'));
  const rebuilt = idxPages({ e: entries });
  assert.equal(rebuilt.length, 2);
  assert.equal(rebuilt[0], 'Page one intro text.');
  assert.equal(rebuilt[1], longPara);
  assert.equal(sigOf(entries), sigOf(entries));
});

test('sigOf notices a same-length one-character change at any position', () => {
  const base = Array.from({ length: 30 }, (_, i) => ({ k: 'a', x: `passage number ${i} about attention` }));
  const s0 = sigOf(base);
  for (let at = 0; at < 9; at++) {   // consecutive positions, so every residue mod 3 (the old signature sampled every third character)
    const e = base.map((x) => ({ ...x })); const x = e[7].x; e[7].x = x.slice(0, 5 + at) + (x[5 + at] === 'q' ? 'w' : 'q') + x.slice(6 + at);
    assert.equal(e[7].x.length, base[7].x.length);
    assert.notEqual(sigOf(e), s0, `value change ${at}`);
  }
});

// --- share.js ---
await test('share.js: encode/decode round-trips conversations and parses #share= hashes', async () => {
  const sample = { digress: 1, conversations: [{ id: 'c1', title: 'Hello 🌍', msgs: { m1: { role: 'user', content: 'Hi' } } }], cards: [], files: {} };
  const { token, gzBytes } = await encodeSharePayload(sample);
  assert.ok(token.length > 0 && /^[A-Za-z0-9_-]+$/.test(token) && gzBytes > 0);
  const url = buildShareUrl(token, 'https://box.ts.net/#old');
  assert.ok(url.startsWith('https://box.ts.net/#share='));
  assert.equal(parseShareHash(new URL(url).hash), token);
  assert.equal(parseShareHash('#c=abc123'), null);
  assert.equal(parseShareHash('#share=' + token + '&extra=1'), token);
  const decoded = await decodeSharePayload(token);
  assert.deepEqual(decoded, sample);
  assert.ok(buildShareUrl(token).startsWith(PUBLIC_DEMO_URL + '#share='));
});

await test('share.js: shareSizeStatus classifies good, warn, and over limits', () => {
  assert.equal(shareSizeStatus(1200).level, 'good');
  assert.equal(shareSizeStatus(1200).ok, true);
  assert.equal(shareSizeStatus(SHARE_GOOD_LEN + 500).level, 'warn');
  assert.equal(shareSizeStatus(SHARE_GOOD_LEN + 500).ok, true);
  assert.equal(shareSizeStatus(SHARE_MAX_LEN + 1).level, 'over');
  assert.equal(shareSizeStatus(SHARE_MAX_LEN + 1).ok, false);
});

await test('share.js: decodeSharePayload blocks gzip bombs and rejects invalid tokens', async () => {
  const big = { digress: 1, pad: 'A'.repeat(100_000) };
  const { token } = await encodeSharePayload(big);
  await assert.rejects(() => decodeSharePayload(token, 10_000), /too large/);
  await assert.rejects(() => decodeSharePayload('not valid base64!!!'), /Invalid/);
  await assert.rejects(() => decodeSharePayload('YWJjZA'), /Not a gzipped/);
});

await test('share.js: sliceBranch prunes sibling branches and truncates ancestors cleanly', () => {
  const conv = {
    id: 'c1', title: 'Big chat',
    threads: {
      main: { id: 'main', parent: null, title: 'Main thread', colorIdx: -1 },
      b1: { id: 'b1', parent: 'main', anchorMsg: 'a1', anchorText: 'alpha', title: 'Alpha branch', colorIdx: 0 },
      b1a: { id: 'b1a', parent: 'b1', anchorMsg: 'a2', anchorText: 'sub', title: 'Sub branch', colorIdx: 1 },
      b2: { id: 'b2', parent: 'main', anchorMsg: 'a3', anchorText: 'beta', title: 'Other branch', colorIdx: 2 },
      clip1: { id: 'clip1', parent: 'main', anchorMsg: 'CLIP', anchorText: 'A tweet', anchorUrl: 'https://x.com/1', title: 'Clip 1', colorIdx: 3 },
      clip2: { id: 'clip2', parent: 'main', anchorMsg: 'CLIP', anchorText: 'Another', anchorUrl: 'https://x.com/2', title: 'Clip 2', colorIdx: 4 },
    },
    msgs: {
      u1: { id: 'u1', thread: 'main', role: 'user', content: 'Q1' },
      a1: { id: 'a1', thread: 'main', role: 'assistant', content: 'A1 alpha' },
      u3: { id: 'u3', thread: 'main', role: 'user', content: 'Q2 after fork' },
      a3: { id: 'a3', thread: 'main', role: 'assistant', content: 'A2 beta' },
      u2: { id: 'u2', thread: 'b1', role: 'user', content: 'Why alpha?' },
      a2: { id: 'a2', thread: 'b1', role: 'assistant', content: 'Because sub.' },
      u4: { id: 'u4', thread: 'b1a', role: 'user', content: 'Sub Q' },
      u5: { id: 'u5', thread: 'b2', role: 'user', content: 'Sibling Q' },
      uc1: { id: 'uc1', thread: 'clip1', role: 'user', content: 'Thoughts on tweet' },
      uc2: { id: 'uc2', thread: 'clip2', role: 'user', content: 'Other clip' },
    },
    order: { main: ['u1', 'a1', 'u3', 'a3'], b1: ['u2', 'a2'], b1a: ['u4'], b2: ['u5'], clip1: ['uc1'], clip2: ['uc2'] },
  };
  // Reply branch: keeps main up to a1, b1 and its descendant b1a; drops u3/a3 and sibling branches
  const s1 = sliceBranch(conv, 'b1');
  assert.equal(s1.title, 'Alpha branch');
  assert.deepEqual(Object.keys(s1.threads).sort(), ['b1', 'b1a', 'main']);
  assert.deepEqual(s1.order.main, ['u1', 'a1']);
  assert.deepEqual(s1.order.b1, ['u2', 'a2']);
  assert.deepEqual(s1.order.b1a, ['u4']);
  assert.deepEqual(Object.keys(s1.msgs).sort(), ['a1', 'a2', 'u1', 'u2', 'u4']);

  // CLIP branch: leaves main completely empty and drops all other clips and main chatter
  const sc = sliceBranch(conv, 'clip1');
  assert.equal(sc.title, 'Clip 1');
  assert.deepEqual(Object.keys(sc.threads).sort(), ['clip1', 'main']);
  assert.deepEqual(sc.order.main, []);
  assert.deepEqual(sc.order.clip1, ['uc1']);
  assert.deepEqual(Object.keys(sc.msgs), ['uc1']);
});

await test('share.js: remapConvIds replaces untrusted thread/message IDs and keeps tree valid', () => {
  const evilTid = '"><img src=x onerror=alert(1)>';
  const evilMid = '" onmouseover="alert(2)';
  const c = {
    id: 'c1', title: 'Test',
    threads: {
      main: { id: 'main', parent: null, title: 'Main thread', colorIdx: -1 },
      [evilTid]: { id: evilTid, parent: 'main', anchorMsg: evilMid, anchorText: 'hi', title: 'Evil branch', colorIdx: 0 },
      clip1: { id: 'clip1', parent: 'main', anchorMsg: 'CLIP', anchorText: 'clip', title: 'Clip', colorIdx: 1 },
    },
    msgs: {
      [evilMid]: { id: evilMid, thread: 'main', role: 'assistant', content: 'hi there' },
      u2: { id: 'u2', thread: evilTid, role: 'user', content: 'q' },
      a2: { id: 'a2', thread: evilTid, role: 'assistant', content: 'a' },
      n1: { id: 'n1', thread: 'main', role: 'note', fromThread: evilTid, upTo: 'a2', content: 'takeaway' },
      uc: { id: 'uc', thread: 'clip1', role: 'user', content: 'clip q' },
    },
    order: { main: [evilMid, 'n1'], [evilTid]: ['u2', 'a2'], clip1: ['uc'] },
  };
  const { tMap, mMap } = remapConvIds(c);
  assert.equal(tMap.get('main'), 'main');
  assert.ok(!c.threads[evilTid], 'evil thread id removed');
  assert.ok(!c.msgs[evilMid], 'evil msg id removed');
  for (const tid of Object.keys(c.threads)) assert.match(tid, /^[A-Za-z0-9_-]+$/);
  for (const mid of Object.keys(c.msgs)) assert.match(mid, /^[A-Za-z0-9_-]+$/);
  const newEvilTid = tMap.get(evilTid);
  const newEvilMid = mMap.get(evilMid);
  assert.equal(c.threads[newEvilTid].anchorMsg, newEvilMid);
  assert.equal(c.threads[tMap.get('clip1')].anchorMsg, 'CLIP');
  assert.equal(c.msgs[mMap.get('n1')].fromThread, newEvilTid);
  assert.equal(c.msgs[mMap.get('n1')].upTo, mMap.get('a2'));
  assert.deepEqual([...ThreadOps.check(c)], []);
});

await test('threads.js & share.js: cyclic parent graphs terminate cleanly without hanging', () => {
  const cyc = {
    id: 'c1',
    threads: {
      main: { id: 'main', parent: null, title: 'Main' },
      a: { id: 'a', parent: 'b', anchorMsg: 'm1', title: 'A' },
      b: { id: 'b', parent: 'a', anchorMsg: 'm2', title: 'B' },
    },
    msgs: {
      m1: { id: 'm1', thread: 'b', role: 'assistant', content: 'x' },
      m2: { id: 'm2', thread: 'a', role: 'assistant', content: 'y' },
    },
    order: { main: [], a: ['m2'], b: ['m1'] },
  };
  const problems = ThreadOps.check(cyc);
  assert.ok(problems.some((p) => /cycle|not under main/.test(p)), `expected cycle error, got ${problems}`);
  assert.equal(sliceBranch(cyc, 'a'), cyc);
});

await test('share.js: parseInlineImageDataUrl decodes raster images locally and rejects URLs/SVG/oversized', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ok = parseInlineImageDataUrl(png);
  assert.equal(ok.type, 'image/png');
  assert.ok(ok.bytes instanceof Uint8Array && ok.bytes.length > 0);
  assert.throws(() => parseInlineImageDataUrl('/api/store/convs'), /Unsupported|Invalid/);
  assert.throws(() => parseInlineImageDataUrl('https://example.com/a.png'), /Unsupported|Invalid/);
  assert.throws(() => parseInlineImageDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), /Unsupported|Invalid/);
  assert.throws(() => parseInlineImageDataUrl('data:text/plain;base64,aGVsbG8='), /Unsupported|Invalid/);
  assert.throws(() => parseInlineImageDataUrl(png, 10), /too large/);
});

await test('share.js: normalizePageIndex accepts bounded non-negative integers and rejects strings/malformed', () => {
  assert.equal(normalizePageIndex(0), 0);
  assert.equal(normalizePageIndex(42), 42);
  assert.equal(normalizePageIndex(-1), null);
  assert.equal(normalizePageIndex(1.5), null);
  assert.equal(normalizePageIndex('0'), null);
  assert.equal(normalizePageIndex('<img src=x onerror=alert(1)>'), null);
  assert.equal(normalizePageIndex(99999999), null);
});

await test('share.js: sliceBranch returns null for missing branch and cardInScope excludes post-fork parent cards', () => {
  const conv = {
    id: 'c1', title: 'Parent',
    threads: {
      main: { id: 'main', parent: null, title: 'Main' },
      b1: { id: 'b1', parent: 'main', anchorMsg: 'm1', title: 'Branch 1' },
    },
    order: { main: ['m1', 'm2'], b1: ['m3'] },
    msgs: {
      m1: { id: 'm1', thread: 'main', role: 'assistant', content: 'Fork point' },
      m2: { id: 'm2', thread: 'main', role: 'assistant', content: 'Private after fork' },
      m3: { id: 'm3', thread: 'b1', role: 'assistant', content: 'Branch reply' },
    },
  };
  assert.equal(sliceBranch(conv, 'nonexistent'), null);
  const sliced = sliceBranch(conv, 'b1');
  assert.ok(sliced && sliced.msgs.m1 && !sliced.msgs.m2 && sliced.msgs.m3);
  assert.equal(cardInScope({ thread: 'main', at: { thread: 'main', msg: 'm1' } }, sliced), true);
  assert.equal(cardInScope({ thread: 'main', at: { thread: 'main', msg: 'm2' } }, sliced), false);
  assert.equal(cardInScope({ thread: 'main', quote: { msg: 'm2', text: 'Private after fork' } }, sliced), false);
  assert.equal(cardInScope({ thread: 'b1', at: { thread: 'b1', msg: 'm3' } }, sliced), true);
});

await test('connectors.js: offlineCards delivers directly when localStorage quota throws and fails loudly if server is also down', async () => {
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  try {
    const sent = [];
    const okStore = offlineCards({
      list: async () => [],
      put: async (id, card) => { sent.push({ id, card }); },
      remove: async () => {},
    });
    await okStore.put('k1', { id: 'k1', front: 'Q', back: 'A' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'k1');
    assert.equal(okStore.pending(), 0);

    const failStore = offlineCards({
      list: async () => [],
      put: async () => { throw new Error('network down'); },
      remove: async () => { throw new Error('network down'); },
    });
    await assert.rejects(() => failStore.put('k2', { id: 'k2', front: 'Q2', back: 'A2' }), /Could not save card/);
    assert.equal(failStore.pending(), 1);
    assert.equal(failStore.stuck, true);
  } finally {
    globalThis.localStorage = prevLS;
  }
});

await test('connectors.js: two offlineCards tabs sharing localStorage never roll back a newer synced card', async () => {
  const prevLS = globalThis.localStorage;
  const bag = new Map();
  globalThis.localStorage = {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => { bag.set(k, String(v)); },
    removeItem: (k) => { bag.delete(k); },
  };
  try {
    let online = false;
    const writes = [];
    const server = {
      list: async () => [],
      put: async (id, card) => {
        if (!online) throw new Error('offline');
        writes.push({ id, rev: card.rev });
      },
      remove: async () => { if (!online) throw new Error('offline'); },
    };
    const tabA = offlineCards(server);
    const tabB = offlineCards(server);
    // Tab A queues older version while offline
    await tabA.put('k1', { id: 'k1', rev: 1, front: 'Old' });
    await tabA.flush();
    assert.equal(writes.length, 0);
    // Server comes back; Tab B saves newer version and drains shared outbox
    online = true;
    await tabB.put('k1', { id: 'k1', rev: 2, front: 'New' });
    await tabB.flush();
    assert.deepEqual(writes, [{ id: 'k1', rev: 2 }]);
    // Tab A reconnects and flushes: must NOT revive rev 1
    await tabA.flush();
    assert.deepEqual(writes, [{ id: 'k1', rev: 2 }]);
    assert.equal(tabA.pending(), 0);
  } finally {
    globalThis.localStorage = prevLS;
  }
});

console.log(`\nall passed (${passed} tests)`);
