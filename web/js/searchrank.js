// How the browser's search engine (MiniSearch) finds and orders results: pure, so tests/search_parity.mjs can run
// it in Node beside the server's engine (server/db.mjs, searchPassages), which follows the same rules on SQLite
// FTS5. The page uses this only when the server has no search of its own (the demo, the tests' page fake); with
// the real server, its results come back already in order. A change to the rules here goes there too, and the
// parity test says when the two stop agreeing (agents/search.md, "Two search engines").

// each kind of entry: its label in the results and how much a match in it counts (server: KIND_BOOST)
export const KIND = { ct: ['Conversation', 3], bt: ['Branch', 2.4], h: ['Highlight', 2.2], n: ['Takeaway', 2], q: ['Question', 1.6], a: ['Answer', 1], d: ['Document', 0.9] };

export const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const WB = '(?<![\\p{L}\\p{N}])';   // a word starts here
// the words of a query that count for ranking and for placing a match (one-letter words don't)
export const qWords = (q) => (q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

// a word as the index keeps it: lower case, accents off (café = cafe), as FTS5's `remove_diacritics` does on the
// server. Only the combining accents (U+0300–036F), so the vowel signs of other scripts stay part of their words.
export const foldTerm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase();

// MiniSearch's options: typo-tolerant for words of 5+ letters, the last word a prefix (it's still being typed)
export const MS_OPTIONS = {
  fields: ['x'],
  storeFields: ['cid', 'k', 'tid', 'mid', 'p', 'n', 'o', 'x'],
  processTerm: foldTerm,
  searchOptions: {
    fuzzy: (t) => (t.length >= 5 ? 0.2 : false),
    prefix: (t, i, ts) => i === ts.length - 1 && t.length > 1,
    boostDocument: (id, term, st) => (KIND[st && st.k] || [0, 1])[1],
  },
};

// the exact phrase first, then more of the typed words as typed (not just typo matches), then BM25
export function rankHits(res, q) {
  const qw = qWords(q);
  const ph = qw.length > 1 && new RegExp(WB + qw.map(reEsc).join('[^\\p{L}\\p{N}]+'), 'u');
  const wr = qw.map((w) => new RegExp(WB + reEsc(w), 'u'));
  for (const r of res) {
    const low = (r.x || '').toLowerCase();
    r.phrase = ph && ph.test(low) ? 1 : 0;
    r.exact = wr.filter((x) => x.test(low)).length;
  }
  res.sort((a, b) => (b.phrase - a.phrase) || (b.exact - a.exact) || (b.score - a.score));
  return res;
}

// a query against a MiniSearch index: every word if anything has them all, else any of them
export function searchMini(ms, q) {
  let res = ms.search(q, { combineWith: 'AND' });
  if (!res.length) res = ms.search(q);
  return rankHits(res, q);
}
