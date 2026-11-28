// Direct Node unit tests for server storage (server/db.mjs) and SSRF/link validation (server/fetchdoc.mjs).
// Runs in milliseconds with no browser; invoked by tests/test_server_unit.py.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.mjs';
import { publicAddress, looksLikeHtml } from '../server/fetchdoc.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok  ', name);
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'digress-db-unit-'));
}

// --- server/db.mjs ---
test('db: conversation CRUD, metadata extraction, and optimistic concurrency (409/410)', () => {
  const dir = makeTempDir();
  try {
    const db = openDb(dir);
    const conv = {
      id: 'c1', title: 'Attention', created: 1000, updated: 2000, folder: 'ML', pinned: true,
      threads: {
        main: { id: 'main', parent: null, title: 'Main' },
        b1: { id: 'b1', parent: 'main', title: 'Softmax', colorIdx: 0, pinned: true },
      },
      msgs: { m1: { id: 'm1', role: 'user', content: 'hi' } },
      order: { main: ['m1'], b1: [] },
      doc: { name: 'paper.pdf', assetId: 'a'.repeat(32) },
    };

    const r1 = db.saveConv('c1', conv, '0');
    assert.equal(r1.status, 200);
    assert.equal(r1.rev, 1);

    // Metadata listing matches extracted columns
    const metas = db.listConvMeta();
    assert.equal(metas.length, 1);
    assert.equal(metas[0].id, 'c1');
    assert.equal(metas[0].data.title, 'Attention');
    assert.equal(metas[0].data.folder, 'ML');
    assert.equal(metas[0].data.pinned, true);
    assert.equal(metas[0].data.doc, true);
    assert.equal(metas[0].data.docName, 'paper.pdf');
    assert.equal(metas[0].data.pins.length, 1);
    assert.equal(metas[0].data.pins[0].tid, 'b1');

    // Stale base rev -> 409 Conflict with current snapshot
    const rConflict = db.saveConv('c1', { ...conv, title: 'Stale' }, '0');
    assert.equal(rConflict.status, 409);
    assert.equal(rConflict.current.title, 'Attention');

    // Matching base rev -> 200 and rev increments
    const r2 = db.saveConv('c1', { ...conv, title: 'Attention v2' }, '1');
    assert.equal(r2.status, 200);
    assert.equal(r2.rev, 2);
    assert.equal(db.getRev('convs', 'c1'), 2);

    // Delete then attempt save with non-zero base rev -> 410 Gone
    db.deleteDoc('convs', 'c1');
    const rGone = db.saveConv('c1', conv, '2');
    assert.equal(rGone.status, 410);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db: FTS5 search ranking, scope filtering, trashed exclusion, and typo fallback', () => {
  const dir = makeTempDir();
  try {
    const db = openDb(dir);
    db.saveConv('c1', { id: 'c1', title: 'Transformers', threads: {}, msgs: {} });
    db.saveConv('c2', { id: 'c2', title: 'Trashed Conv', trashed: Date.now(), threads: {}, msgs: {} });

    db.putDoc('index', 'c1', {
      e: [
        { k: 'ct', x: 'Transformers' },
        { k: 'bt', tid: 'b1', x: 'Scaled dot product' },
        { k: 'a', tid: 'main', mid: 'm1', x: 'Self-attention computes weighted sums over value vectors.' },
        { k: 'a', tid: 'b1', mid: 'm2', x: 'Dividing by square root of dimension stabilizes softmax gradients.' },
        { k: 'd', p: 3, n: 0, o: 0, x: 'Multi-head attention projects queries keys and values linearly.' },
      ],
    });
    db.putDoc('index', 'c2', {
      e: [{ k: 'a', tid: 'main', mid: 'm9', x: 'Stabilizes softmax gradients in trashed conversation.' }],
    });

    // Trashed conversation must never appear in results
    const res1 = db.searchPassages('stabilizes softmax');
    assert.equal(res1.length, 1);
    assert.equal(res1[0].cid, 'c1');
    assert.equal(res1[0].tid, 'b1');
    assert.equal(res1[0].bt, 'Scaled dot product');

    // Thread scope: doc vs specific branch
    const docHits = db.searchPassages('attention', { scope: 'thread', cid: 'c1', tid: 'doc' });
    assert.equal(docHits.length, 1);
    assert.equal(docHits[0].k, 'd');
    assert.equal(docHits[0].p, 3);

    const branchHits = db.searchPassages('attention', { scope: 'thread', cid: 'c1', tid: 'main' });
    assert.equal(branchHits.length, 1);
    assert.equal(branchHits[0].mid, 'm1');

    // Typo-tolerant fallback via fts5vocab (edit distance 1 on >=5 char word)
    const typoHits = db.searchPassages('stabllizes');
    assert.equal(typoHits.length, 1);
    assert.equal(typoHits[0].mid, 'm2');

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db: a typo in a multi-word query still needs every word (fuzzy terms are ANDed, not a syntax error)', () => {
  const dir = makeTempDir();
  try {
    const db = openDb(dir);
    const conv = {
      id: 'c1', title: 'Notes', created: 1, updated: 2,
      threads: { main: { id: 'main', parent: null, title: 'Notes' } },
      msgs: {
        m1: { id: 'm1', thread: 'main', role: 'assistant', content: 'attention mechanisms explained' },
        m2: { id: 'm2', thread: 'main', role: 'assistant', content: 'attention only here' },
        m3: { id: 'm3', thread: 'main', role: 'assistant', content: 'mechanisms only here' },
      },
      order: { main: ['m1', 'm2', 'm3'] },
    };
    db.saveConv('c1', conv, '0');
    db.putDoc('index', 'c1', { e: [
      { k: 'a', x: 'attention mechanisms explained', tid: 'main', mid: 'm1' },
      { k: 'a', x: 'attention only here', tid: 'main', mid: 'm2' },
      { k: 'a', x: 'mechanisms only here', tid: 'main', mid: 'm3' },
    ] });
    const hits = db.searchPassages('attention mecanisms');
    assert.deepEqual(hits.map((r) => r.mid), ['m1']);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db: purgeTrash removes expired convs, layouts, index, and dropCards', () => {
  const dir = makeTempDir();
  try {
    const db = openDb(dir);
    const oldTs = Date.now() - 10 * 864e5;
    db.saveConv('old1', { id: 'old1', title: 'Old', trashed: oldTs, dropCards: true, threads: {}, msgs: {} });
    db.saveConv('keep1', { id: 'keep1', title: 'Fresh', trashed: Date.now() - 864e5, dropCards: true, threads: {}, msgs: {} });
    db.putLayout('old1', 'dev1', { view: 'panes' }, 90);
    db.putDoc('index', 'old1', { e: [{ k: 'a', tid: 'main', mid: 'm1', x: 'old text' }] });
    db.putDoc('cards', 'card1', { id: 'card1', conv: 'old1', front: 'Q', back: 'A' });
    db.putDoc('cards', 'card2', { id: 'card2', conv: 'keep1', front: 'Q2', back: 'A2' });

    const gone = db.purgeTrash(7);
    assert.equal(gone, 1);
    assert.equal(db.hasConv('old1'), false);
    assert.equal(db.hasConv('keep1'), true);
    assert.equal(db.readDoc('cards', 'card1'), null);
    assert.ok(db.readDoc('cards', 'card2'));
    assert.deepEqual(db.getLayout('old1'), { devices: {} });
    assert.equal(db.searchPassages('old text').length, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db: legacy JSON folder migration moves backups into _legacy_json/', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'convs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'cards'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'convs', 'c1.json'), JSON.stringify({ id: 'c1', title: 'Legacy', rev: 3, threads: {}, msgs: {} }));
    fs.writeFileSync(path.join(dir, 'cards', 'k1.json'), JSON.stringify({ id: 'k1', conv: 'c1', front: 'F', back: 'B' }));

    const db = openDb(dir);
    assert.equal(db.migratedCount, 2);
    assert.equal(db.readDoc('convs', 'c1').title, 'Legacy');
    assert.equal(db.readDoc('cards', 'k1').front, 'F');
    assert.equal(fs.existsSync(path.join(dir, 'convs')), false);
    assert.equal(fs.existsSync(path.join(dir, '_legacy_json', 'convs', 'c1.json')), true);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db: allUsedAssets collects referenced 32-hex assets from convs and cards', () => {
  const dir = makeTempDir();
  try {
    const db = openDb(dir);
    const a1 = '1'.repeat(32), a2 = '2'.repeat(32), a3 = '3'.repeat(32);
    db.saveConv('c1', { id: 'c1', title: 'Docs', doc: { assetId: a1 }, msgs: { m1: { images: [{ asset: a2 }] } }, threads: {} });
    db.putDoc('cards', 'k1', { id: 'k1', conv: 'c1', image: { asset: a3 } });
    const used = db.allUsedAssets();
    assert.equal(used.has(a1), true);
    assert.equal(used.has(a2), true);
    assert.equal(used.has(a3), true);
    assert.equal(used.size, 3);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- server/fetchdoc.mjs ---
test('fetchdoc: publicAddress blocks loopback, private, Tailscale CGNAT, metadata, and IPv4-mapped IPv6', () => {
  for (const ip of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::1',
  ]) {
    assert.equal(publicAddress(ip), false, `should block ${ip}`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(publicAddress(ip), true, `should allow ${ip}`);
  }
});

test('fetchdoc: looksLikeHtml handles comments without catastrophic backtracking', () => {
  assert.equal(looksLikeHtml('<!doctype html><html>'), true);
  assert.equal(looksLikeHtml('  <!-- a --><!-- b --><html>'), true);
  assert.equal(looksLikeHtml('<!-- unclosed comment'), false);
  assert.equal(looksLikeHtml('# Markdown heading'), false);
  assert.equal(looksLikeHtml('<!-- x -->'.repeat(5000) + '<html>'), true);
});

test('db: putDoc index preserves doc passages on keepDoc and ignores stale lower-rev writes', () => {
  const dir = makeTempDir();
  try {
    const db = openDb(dir);
    db.saveConv('c1', { id: 'c1', title: 'Doc', threads: {}, msgs: {} });
    db.putDoc('index', 'c1', {
      id: 'c1', v: 2, rev: 2,
      e: [
        { k: 'd', p: 1, n: 0, o: 0, x: 'quantum entanglement document passage' },
        { k: 'a', tid: 'main', mid: 'm1', n: 0, o: 0, x: 'first answer text' },
      ],
    });
    // keepDoc update replaces only non-doc passages while preserving existing 'd' passages
    db.putDoc('index', 'c1', {
      id: 'c1', v: 2, rev: 3, keepDoc: true,
      e: [{ k: 'a', tid: 'main', mid: 'm1', n: 0, o: 0, x: 'revised answer text' }],
    });
    assert.ok(db.searchPassages('entanglement').some((r) => r.cid === 'c1' && r.k === 'd'), 'doc passage preserved');
    assert.ok(db.searchPassages('revised').some((r) => r.cid === 'c1' && r.k === 'a'), 'new answer indexed');
    assert.equal(db.searchPassages('first').length, 0, 'old answer removed');
    // Stale lower-rev index write must be ignored
    db.putDoc('index', 'c1', {
      id: 'c1', v: 2, rev: 1,
      e: [{ k: 'a', tid: 'main', mid: 'm1', n: 0, o: 0, x: 'stale overwritten answer' }],
    });
    assert.equal(db.searchPassages('stale').length, 0, 'stale rev ignored');
    assert.ok(db.searchPassages('revised').some((r) => r.cid === 'c1'), 'newer rev preserved');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db: putDoc index changes only the passages that changed', () => {
  const dir = makeTempDir();
  try {
    const db = openDb(dir);
    db.saveConv('c2', { id: 'c2', title: 'Clips', threads: {}, msgs: {} });
    const raw = new DatabaseSync(path.join(dir, 'digress.db'));
    const rows = () => raw.prepare("SELECT rowid, k, mid, x FROM passages WHERE cid = 'c2' ORDER BY rowid").all().map((r) => ({ ...r }));
    const a = { k: 'a', tid: 'b1', mid: 'm1', n: 0, o: 0, x: 'walrus answer' };
    const twice = { k: 'q', tid: 'b2', mid: 'm2', n: 0, o: 0, x: 'repeated narwhal' };
    db.putDoc('index', 'c2', { id: 'c2', v: 2, rev: 1, e: [a, twice, { ...twice }, { k: 'd', p: 1, n: 0, o: 0, x: 'page one manatee' }] });
    const first = rows();
    assert.equal(first.length, 4);
    // one message added, one copy of a repeated passage gone, the document dropped (no keepDoc)
    const added = { k: 'q', tid: 'b3', mid: 'm3', n: 0, o: 0, x: 'new dugong question' };
    db.putDoc('index', 'c2', { id: 'c2', v: 2, rev: 2, e: [a, twice, added] });
    const second = rows();
    assert.equal(second.length, 3);
    assert.equal(second.find((r) => r.mid === 'm1').rowid, first.find((r) => r.mid === 'm1').rowid, 'unchanged row kept, not re-added');
    assert.equal(second.filter((r) => r.mid === 'm2').length, 1, 'one copy of the repeated passage left');
    assert.ok(db.searchPassages('dugong').some((r) => r.mid === 'm3'), 'added passage searchable');
    assert.equal(db.searchPassages('manatee').length, 0, 'removed document passage gone from search');
    assert.ok(db.searchPassages('narwhal').some((r) => r.mid === 'm2'), 'kept passage still searchable');
    // an edited message: its old text leaves search, its new text enters
    db.putDoc('index', 'c2', { id: 'c2', v: 2, rev: 3, e: [{ ...a, x: 'walrus edited' }, twice, added] });
    assert.equal(db.searchPassages('answer').length, 0);
    assert.ok(db.searchPassages('edited').some((r) => r.mid === 'm1'));
    raw.close();
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`server_unit: ${passed} passed`);
