// The rules search ranks by, shared by both engines: the server's (server/db.mjs, searchPassages, SQLite FTS5)
// imports KIND and rankHits from here, and the page's (MiniSearch, used when the server has no search: the demo,
// the tests' page fake) uses all of it. Pure, so tests/search_parity.mjs runs both in Node and checks they agree;
// what can't be shared (how words are split, typo matching) is in agents/search.md, "Two search engines".

// each kind of entry: its label in the results and how much a match in it counts
export const KIND = { ct: ['Conversation', 3], bt: ['Branch', 2.4], h: ['Highlight', 2.2], n: ['Takeaway', 2], q: ['Question', 1.6], a: ['Answer', 1], d: ['Document', 0.9] };

export const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const WB = '(?<![\\p{L}\\p{N}])';   // a word starts here

// a word as the index keeps it: lower case, accents off (café = cafe), as FTS5's `remove_diacritics` does on the
// server. Only the combining accents (U+0300 to U+036F), so the vowel signs of other scripts stay part of their words.
const ACCENTS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
export const foldTerm = (t) => String(t || '').normalize('NFD').replace(ACCENTS, '').normalize('NFC').toLowerCase();
// the same fold for text a match is placed in, keeping every character's position (é → e; a character whose fold
// would change the length, like İ or a loose combining accent, stays as it is), so an offset found in the folded
// text is the same offset in the original, for highlighting it
export function foldKeep(s) {
  let out = '';
  for (const ch of String(s || '')) {
    const f = foldTerm(ch), low = ch.toLowerCase();
    out += f.length === ch.length ? f : low.length === ch.length ? low : ch;
  }
  return out;
}
// the words of a query that count for ranking and for placing a match (one-letter words don't), folded: compare
// them with foldTerm or foldKeep of the text, never with the text as it is
export const qWords = (q) => foldTerm(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

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

// the exact phrase first, then more of the typed words as typed (not just typo matches), then BM25. Both engines
// sort with this; `score` is each engine's own BM25, so only the order inside a tier can differ between them.
export function rankHits(res, q) {
  const qw = qWords(q);
  const ph = qw.length > 1 && new RegExp(WB + qw.map(reEsc).join('[^\\p{L}\\p{N}]+'), 'u');
  const wr = qw.map((w) => new RegExp(WB + reEsc(w), 'u'));
  for (const r of res) {
    const low = foldTerm(r.x);
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
