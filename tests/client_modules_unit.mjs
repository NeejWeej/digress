// Direct Node unit tests for pure client ES modules (web/js/fsrs.js, web/js/text.js).
// Runs in milliseconds with no browser; invoked by tests/test_client_modules.py.
import assert from 'node:assert/strict';
import { DAY, MIN, fsrsNext, ivlText } from '../web/js/fsrs.js';
import { esc, trunc, texText, stripCiteQuotes, plain, pdfTitleOk, passages, indexEntries, idxPages, sigOf } from '../web/js/text.js';

let passed = 0;
function test(name, fn) {
  fn();
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

console.log(`\nall passed (${passed} tests)`);
