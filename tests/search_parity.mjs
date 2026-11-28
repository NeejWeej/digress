// The server's search (server/db.mjs, SQLite FTS5) and the page's (web/js/searchrank.js, MiniSearch) are one set
// of rules written twice (agents/search.md, "Two search engines"). Both index the same conversations (entries from
// indexEntries) and must return the same results in the same TIERS: results grouped by consecutive (phrase, exact)
// pair, the rule both engines sort by first (exact phrase, then how many typed words match as typed). Within a tier
// the order is a BM25 tie-break, and the engines don't have the same BM25 (FTS5 bm25 with the server's
// boost*(1+bm25), MiniSearch BM25+ with other idf and prefix/fuzzy weights; the scores are on different scales),
// so order inside a tier is not compared. What is: the same keys, in the same sequence of tiers. The whole result
// list is compared (not only the top N), so a tier straddling a cutoff can't hide a difference; the failure
// message shows the top N of each side. Only the
// results are compared, not scores. Invoked by tests/test_search_parity.py.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MiniSearch from '../node_modules/minisearch/dist/es/index.js';
import { openDb } from '../server/db.mjs';
import { indexEntries } from '../web/js/text.js';
import { MS_OPTIONS, searchMini, KIND } from '../web/js/searchrank.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); }
  catch (e) { failed++; console.log('FAIL', name + '\n' + (e && e.message)); }
}

const TOP = 10;
const resultKey = (r) => r.cid + '|' + (r.mid || '') + '|' + r.k + '|' + (r.k === 'd' ? r.p : r.k === 'bt' || r.k === 'h' ? r.tid : '');

// --- corpus ---
const filler = (s, n) => Array.from({ length: n }, (_, i) => s + ' ' + ['alpha', 'bravo', 'delta', 'echo', 'foxtrot', 'gamma'][i % 6] + ' notes about unrelated matters.').join(' ');
const para = (s) => s + '\n\n' + filler('Background', 14) + '\n\n' + 'Closing remark about the 1680s and attention to detail.';
const msg = (id, thread, role, content) => ({ id, thread, role, content });
function mkConv(id, title, threads, msgs, extra) {
  const conv = { id, title, created: 1000, updated: 2000, threads: { main: { id: 'main', parent: null, title }, ...threads }, msgs: {}, order: { main: [] }, ...extra };
  for (const m of msgs) { conv.msgs[m.id] = m; (conv.order[m.thread] ||= []).push(m.id); }
  for (const t of Object.keys(conv.threads)) conv.order[t] ||= [];
  return conv;
}
const convs = [
  mkConv('c1', 'Attention mechanisms', {
    b1: { id: 'b1', parent: 'main', title: 'Self-attention explained', anchorText: 'multi-head attention' },
    b2: { id: 'b2', parent: 'main', title: 'Softmax temperature', anchorText: 'the softmax function' },
  }, [
    msg('m1', 'main', 'user', 'How does attention work in a transformer?'),
    msg('m2', 'main', 'assistant', para('Attention lets each token weigh the others. Self-attention compares queries and keys; the vitamin c of the model is its softmax.')),
    msg('m3', 'b1', 'user', 'Why is self-attention quadratic in sequence length?'),
    msg('m4', 'b1', 'assistant', 'Every token attends to every other token, so the cost grows with the square of the length. Attention heads run in parallel.'),
    msg('m5', 'b2', 'assistant', 'Temperature rescales logits before softmax, sharpening or flattening the attention distribution.'),
    msg('m6', 'main', 'note', 'Takeaway: attention is a weighted average; softmax makes the weights sum to one.'),
  ]),
  mkConv('c2', 'Paris trip notes', {
    b1: { id: 'b1', parent: 'main', title: 'Cafe etiquette', anchorText: 'a quiet café near the river' },
  }, [
    msg('m1', 'main', 'user', 'Where can I find a good café in Paris?'),
    msg('m2', 'main', 'assistant', para('Try a small café in the Marais. Order a cafe au lait and do not rush; attention to the staff goes a long way.')),
    msg('m3', 'b1', 'user', 'Is it naïve to expect English menus?'),
    msg('m4', 'b1', 'assistant', 'It is not naive, but a few French words help. The cafe culture rewards patience and a polite greeting.'),
    msg('m5', 'main', 'note', 'Takeaway: say bonjour first, then ask for a table.'),
  ]),
  mkConv('c3', 'Nutrition and vitamins', {
    b1: { id: 'b1', parent: 'main', title: 'Vitamin C sources', anchorText: 'vitamin c and iron absorption' },
  }, [
    msg('m1', 'main', 'user', 'Does vitamin c really help with colds?'),
    msg('m2', 'main', 'assistant', 'Evidence is mixed. Vitamin D is another story; iron absorption does improve with vitamin C. ' + filler('Diet', 12)),
    msg('m3', 'b1', 'assistant', 'Citrus, peppers and kiwi are rich in it. Scurvy was documented in sailors through the 1680s and again in 2024 reports of poor diets.'),
    msg('m4', 'main', 'note', 'Takeaway: eat fruit, do not rely on supplements.'),
  ]),
  mkConv('c4', 'Old attention trash', {}, [
    msg('m1', 'main', 'user', 'Self-attention and café vitamin c in the trash.'),
    msg('m2', 'main', 'assistant', 'Attention attention attention; the 1680s; a naive café.'),
  ], { trashed: Date.now() }),
  mkConv('c5', 'Reading the Transformer paper', {
    b1: { id: 'b1', parent: 'main', title: 'Positional encodings', anchorText: 'sinusoidal encodings' },
  }, [
    msg('m1', 'main', 'user', 'Summarise the paper for me.'),
    msg('m2', 'main', 'assistant', 'The paper introduces a model built only on attention, without recurrence.'),
    msg('m3', 'b1', 'assistant', 'Positional encodings inject order, since attention alone ignores position.'),
  ], { doc: { name: 'paper.pdf' } }),
];
// Unrelated conversations, so that word frequencies look like a real library (in a handful of passages BM25's
// idf is near zero and both engines are just breaking ties).
const TOPICS = ['gardening', 'sailing', 'baking', 'chess', 'volcanoes', 'jazz', 'astronomy', 'carpentry', 'marathon', 'origami', 'beekeeping', 'pottery'];
TOPICS.forEach((t, i) => convs.push(mkConv('f' + i, 'About ' + t, {}, [
  msg('m1', 'main', 'user', 'Tell me about ' + t + ' for a beginner.'),
  msg('m2', 'main', 'assistant', `A beginner in ${t} should start small. ${filler(t, 3 + (i % 5))} Patience matters more than tools in ${t}.`),
  msg('m3', 'main', 'assistant', `Common mistakes in ${t} include rushing, skipping the basics and buying too much. ${filler('Mistakes', 4)}`),
])));
const pages = {
  c5: [
    'Abstract. We propose the Transformer, based solely on attention mechanisms. ' + filler('Intro', 8),
    'Section 2. Self-attention, sometimes called intra-attention, relates positions of a single sequence. The vitamin c of this paper is its softmax. ' + filler('Model', 8),
    'Section 3. Results on translation were reported in 2024 and compared with systems from the 1680s of machine translation (a joke). The naive baseline and the café benchmark.',
  ],
};
const ENT = (c) => indexEntries(c, pages[c.id]);

// --- both engines ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digress-parity-'));
const db = openDb(dir);
try {
  const ms = new MiniSearch(MS_OPTIONS);
  let uid = 0;
  for (const c of convs) {
    db.saveConv(c.id, c);
    db.putDoc('index', c.id, { e: ENT(c) });
    if (!c.trashed) ms.addAll(ENT(c).map((e) => ({ ...e, cid: c.id, id: ++uid })));   // the page leaves the trash out
  }

  const dedupe = (rs) => { const seen = new Set(); return rs.filter((r) => { const k = resultKey(r); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const scopeFilter = (rs, scope, cid, tid) => scope === 'all' ? rs : rs.filter((r) => r.cid === cid && (scope === 'conv' || (tid === 'doc' ? r.k === 'd' : r.k !== 'd' && r.tid === tid)));
  const rows = (rs) => dedupe(rs);
  const server = (q, o = {}) => db.searchPassages(q, { limit: 300, ...o });
  const page = (q, o = {}) => rows(scopeFilter(searchMini(ms, q), o.scope || 'all', o.cid, o.tid));
  // consecutive results with the same (phrase, exact), as sorted lists of keys
  const tiers = (rs) => {
    const out = [];
    for (const r of rs) {
      const t = r.phrase + ',' + r.exact;
      if (!out.length || out[out.length - 1].t !== t) out.push({ t, keys: [] });
      out[out.length - 1].keys.push(resultKey(r));
    }
    return out.map((x) => x.t + ' [' + x.keys.sort().join(' ') + ']');
  };
  const show = (rs) => rs.slice(0, TOP).map((r) => `${r.phrase},${r.exact}  ${resultKey(r)}`).join('\n    ') || '(none)';

  // Queries where the engines are known to return different results (or tiers). Each is checked to still differ,
  // so fixing one fails the test until it comes off this list. Key: query|scope|cid|tid.
  const KNOWN_DIFFERENT = {};

  const same = (q, o = {}) => {
    const sr = server(q, o), pr = page(q, o), s = tiers(sr), p = tiers(pr), id = [q, o.scope || 'all', o.cid || '', o.tid || ''].join('|');
    if (id in KNOWN_DIFFERENT) {
      assert.notDeepEqual(s, p, `"${id}" is listed in KNOWN_DIFFERENT (${KNOWN_DIFFERENT[id]}) but now agrees: remove it`);
      return;
    }
    assert.deepEqual(p, s, `Results differ for ${JSON.stringify(q)} ${JSON.stringify(o)} (phrase,exact  key; top ${TOP})\n  server (FTS5):\n    ${show(sr)}\n  page (MiniSearch):\n    ${show(pr)}\n  tiers differ:\n    server ${s.join('\n           ')}\n    page   ${p.join('\n           ')}`);
    return sr;
  };

  const Q = {
    'phrase verbatim': 'self-attention compares',
    'two-word phrase': 'vitamin d',
    'words reversed': 'attention self',
    'loose co-occurrence': 'softmax quadratic',
    'typo in 5+ letter word': 'transfomer',
    'typo, second word': 'attention mecanisms',
    '4-letter typo (no fuzzy)': 'cafw',
    '4-letter typo 2': 'iron absorpton',
    'prefix of last word': 'atten',
    'prefix after words': 'positional enco',
    'accent: café -> cafe': 'cafe',
    'accent: cafe -> café': 'café',
    'accent: naïve': 'naïve',
    'accent: naive': 'naive',
    'one-letter word': 'vitamin c',
    'one-letter word only': 'c',
    'every kind': 'attention',
    'every kind (softmax)': 'softmax',
    'every kind (vitamin)': 'vitamin',
    'no matches': 'zzyzzyx qqqq',
    'hyphenated': 'self-attention',
    'hyphen split': 'self attention',
    'digits 1680s': '1680s',
    'digits 2024': '2024',
    'digits prefix': '168',
    'mixed case': 'ATTENTION Mechanisms',
    'title phrase': 'positional encodings',
    'takeaway': 'takeaway weights',
  };
  for (const [name, q] of Object.entries(Q)) test(`parity: ${name}: ${JSON.stringify(q)}`, () => { same(q); });

  test('parity: broad queries return something (the corpus is exercised)', () => {
    for (const q of ['attention', 'cafe', 'vitamin c', '2024', 'self-attention']) assert.ok(server(q).length >= 2 && page(q).length >= 2, q);
    assert.equal(server('zzyzzyx qqqq').length + page('zzyzzyx qqqq').length, 0);
  });

  test('parity: the trashed conversation is in neither', () => {
    for (const q of ['attention', 'naive', 'café']) assert.ok(!server(q).some((r) => r.cid === 'c4') && !page(q).some((r) => r.cid === 'c4'), q);
  });

  const SC = [
    ['conv', 'c1', undefined, 'attention'], ['conv', 'c2', undefined, 'cafe'], ['conv', 'c3', undefined, 'vitamin c'],
    ['conv', 'c1', undefined, 'self-attention'], ['conv', 'c5', undefined, 'attention'],
    ['thread', 'c1', 'main', 'attention'], ['thread', 'c1', 'b1', 'attention'], ['thread', 'c1', 'b2', 'softmax'],
    ['thread', 'c2', 'b1', 'naive'], ['thread', 'c5', 'b1', 'attention'],
    ['thread', 'c5', 'doc', 'attention'], ['thread', 'c5', 'doc', 'vitamin c'], ['thread', 'c5', 'doc', '2024'],
  ];
  for (const [scope, cid, tid, q] of SC) test(`parity: scope ${scope} ${cid}${tid ? '/' + tid : ''}: ${JSON.stringify(q)}`, () => { same(q, { scope, cid, tid }); });

  test('KIND_BOOST in server/db.mjs matches KIND in web/js/searchrank.js', () => {
    const src = fs.readFileSync(new URL('../server/db.mjs', import.meta.url), 'utf8');
    const m = src.match(/const KIND_BOOST\s*=\s*(\{[^}]*\})/);
    assert.ok(m, 'could not find `const KIND_BOOST = {...}` in server/db.mjs');
    const boost = Function('return (' + m[1] + ')')();
    const kinds = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [k, v[1]]));
    assert.deepEqual(boost, kinds);
  });
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
