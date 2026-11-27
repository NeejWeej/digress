// SQLite + FTS5 storage backend for Digress using Node's built-in node:sqlite (zero external dependencies).
// Handles conversations, cards, search index + FTS5 passages, layouts, skills, and prompts.
// On first boot against a legacy JSON data directory, migrates all JSON collections non-destructively
// into data/digress.db and moves the original JSON folders to data/_legacy_json/ as a backup.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const KIND_BOOST = { ct: 3, bt: 2.4, h: 2.2, n: 2, q: 1.6, a: 1, d: 0.9 };
const RE_ESC = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WB = '(?<![\\p{L}\\p{N}])';

// Bounded Damerau-Levenshtein distance (returns > maxD early when strings can't match).
function editDistBounded(a, b, maxD) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > maxD) return maxD + 1;
  if (a === b) return 0;
  let prev2 = null;
  let prev = new Uint8Array(lb + 1);
  let cur = new Uint8Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      if (ins < v) v = ins;
      if (sub < v) v = sub;
      if (prev2 && i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        const tr = prev2[j - 2] + 1;
        if (tr < v) v = tr;
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxD) return maxD + 1;
    const tmp = prev2 || new Uint8Array(lb + 1);
    prev2 = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[lb];
}

function extractConvMeta(id, c) {
  return {
    title: String(c.title || ''),
    rev: Number(c.rev || 0),
    updated: Number(c.updated || 0),
    created: Number(c.created || 0),
    pinned: c.pinned ? 1 : 0,
    archived: c.archived ? 1 : 0,
    trashed: Number(c.trashed || 0),
    drop_cards: c.dropCards ? 1 : 0,
    folder: String(c.folder || ''),
    has_doc: c.doc ? 1 : 0,
    doc_name: c.doc ? String(c.doc.name || '') : '',
    asset: (c.doc && c.doc.assetId) ? String(c.doc.assetId) : '',
    system_text: typeof c.system === 'string' ? c.system : '',
    pins_json: JSON.stringify(
      Object.values(c.threads || {})
        .filter((t) => t && t.pinned)
        .map((t) => ({ tid: t.id, title: t.title, ci: t.colorIdx }))
    ),
  };
}

function rowToMeta(r) {
  let pins = [];
  try { pins = JSON.parse(r.pins_json || '[]'); } catch { /* ignore */ }
  return {
    _meta: true,
    dropCards: !!r.drop_cards,
    id: r.id,
    title: r.title,
    updated: r.updated,
    created: r.created,
    pinned: !!r.pinned,
    archived: !!r.archived,
    trashed: r.trashed || 0,
    folder: r.folder || '',
    system: r.system_text || '',
    doc: !!r.has_doc,
    docName: r.doc_name || '',
    asset: r.asset || '',
    pins,
  };
}

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'digress.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS convs (
      id TEXT PRIMARY KEY,
      rev INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      trashed INTEGER NOT NULL DEFAULT 0,
      drop_cards INTEGER NOT NULL DEFAULT 0,
      folder TEXT NOT NULL DEFAULT '',
      has_doc INTEGER NOT NULL DEFAULT 0,
      doc_name TEXT NOT NULL DEFAULT '',
      asset TEXT NOT NULL DEFAULT '',
      system_text TEXT NOT NULL DEFAULT '',
      pins_json TEXT NOT NULL DEFAULT '[]',
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_convs_trashed ON convs(trashed) WHERE trashed > 0;

    CREATE TABLE IF NOT EXISTS docs (
      coll TEXT NOT NULL,
      id TEXT NOT NULL,
      conv_id TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL,
      PRIMARY KEY (coll, id)
    );
    CREATE INDEX IF NOT EXISTS idx_docs_coll ON docs(coll);
    CREATE INDEX IF NOT EXISTS idx_docs_conv ON docs(coll, conv_id) WHERE conv_id != '';

    CREATE TABLE IF NOT EXISTS layouts (
      conv_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS passages (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      cid TEXT NOT NULL,
      idx INTEGER NOT NULL,
      k TEXT NOT NULL,
      tid TEXT NOT NULL DEFAULT '',
      mid TEXT NOT NULL DEFAULT '',
      p INTEGER NOT NULL DEFAULT 0,
      n INTEGER NOT NULL DEFAULT 0,
      o INTEGER NOT NULL DEFAULT 0,
      x TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_passages_cid ON passages(cid);
    CREATE INDEX IF NOT EXISTS idx_passages_bt ON passages(cid, k, tid) WHERE k = 'bt';

    CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
      x,
      content='passages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS passages_vocab USING fts5vocab(passages_fts, row);

    CREATE TRIGGER IF NOT EXISTS passages_ai AFTER INSERT ON passages BEGIN
      INSERT INTO passages_fts(rowid, x) VALUES (new.rowid, new.x);
    END;
    CREATE TRIGGER IF NOT EXISTS passages_ad AFTER DELETE ON passages BEGIN
      INSERT INTO passages_fts(passages_fts, rowid, x) VALUES ('delete', old.rowid, old.x);
    END;
  `);

  // Prepared statements
  const stListMeta = db.prepare(`
    SELECT id, title, updated, created, pinned, archived, trashed, drop_cards,
           folder, has_doc, doc_name, asset, system_text, pins_json
    FROM convs
  `);
  const stListConvs = db.prepare('SELECT id, data FROM convs');
  const stGetConv = db.prepare('SELECT rev, data FROM convs WHERE id = ?');
  const stGetConvRev = db.prepare('SELECT rev FROM convs WHERE id = ?');
  const stHasConv = db.prepare('SELECT 1 AS ok FROM convs WHERE id = ?');
  const stUpsertConv = db.prepare(`
    INSERT INTO convs (id, rev, updated, created, title, pinned, archived, trashed, drop_cards,
                       folder, has_doc, doc_name, asset, system_text, pins_json, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      rev=excluded.rev, updated=excluded.updated, created=excluded.created, title=excluded.title,
      pinned=excluded.pinned, archived=excluded.archived, trashed=excluded.trashed,
      drop_cards=excluded.drop_cards, folder=excluded.folder, has_doc=excluded.has_doc,
      doc_name=excluded.doc_name, asset=excluded.asset, system_text=excluded.system_text,
      pins_json=excluded.pins_json, data=excluded.data
  `);
  const stDeleteConv = db.prepare('DELETE FROM convs WHERE id = ?');
  const stExpiredTrash = db.prepare('SELECT id, trashed, drop_cards FROM convs WHERE trashed > 0 AND trashed <= ?');

  const stListDocs = db.prepare('SELECT id, data FROM docs WHERE coll = ?');
  const stGetDoc = db.prepare('SELECT data FROM docs WHERE coll = ? AND id = ?');
  const stUpsertDoc = db.prepare(`
    INSERT INTO docs (coll, id, conv_id, data) VALUES (?, ?, ?, ?)
    ON CONFLICT(coll, id) DO UPDATE SET conv_id=excluded.conv_id, data=excluded.data
  `);
  const stDeleteDoc = db.prepare('DELETE FROM docs WHERE coll = ? AND id = ?');
  const stDeleteCardsOf = db.prepare("DELETE FROM docs WHERE coll = 'cards' AND conv_id = ?");

  const stGetLayout = db.prepare('SELECT data FROM layouts WHERE conv_id = ?');
  const stUpsertLayout = db.prepare(`
    INSERT INTO layouts (conv_id, data) VALUES (?, ?)
    ON CONFLICT(conv_id) DO UPDATE SET data=excluded.data
  `);
  const stDeleteLayout = db.prepare('DELETE FROM layouts WHERE conv_id = ?');

  const stDeletePassages = db.prepare('DELETE FROM passages WHERE cid = ?');
  const stDeleteNonDocPassages = db.prepare("DELETE FROM passages WHERE cid = ? AND k != 'd'");
  const stMaxDocPassageIdx = db.prepare("SELECT COALESCE(MAX(idx), -1) AS m FROM passages WHERE cid = ? AND k = 'd'");
  const stHasDocPassages = db.prepare("SELECT 1 AS ok FROM passages WHERE cid = ? AND k = 'd' LIMIT 1");
  const stInsertPassage = db.prepare(`
    INSERT INTO passages (cid, idx, k, tid, mid, p, n, o, x) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stGetBranchTitle = db.prepare("SELECT x FROM passages WHERE cid = ? AND k = 'bt' AND tid = ? LIMIT 1");
  const stVocabPrefix = db.prepare(
    'SELECT term, doc FROM passages_vocab WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?'
  );
  const searchSql = (extraWhere) => db.prepare(`
    SELECT p.cid, p.k, p.tid, p.mid, p.p, p.n, p.o, p.x, bm25(passages_fts) AS rank
    FROM passages_fts
    JOIN passages p ON p.rowid = passages_fts.rowid
    JOIN convs c ON c.id = p.cid
    WHERE passages_fts MATCH ? AND c.trashed = 0${extraWhere}
    ORDER BY rank
    LIMIT 400
  `);
  const stSearchAll = searchSql('');
  const stSearchConv = searchSql(' AND p.cid = ?');
  const stSearchThreadDoc = searchSql(" AND p.cid = ? AND p.k = 'd'");
  const stSearchThreadMsg = searchSql(" AND p.cid = ? AND p.k != 'd' AND p.tid = ?");

  const stAllAssetsConvs = db.prepare('SELECT data FROM convs');
  const stAllAssetsCards = db.prepare("SELECT data FROM docs WHERE coll = 'cards'");

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const res = fn();
      db.exec('COMMIT');
      return res;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  function writeConvRow(id, d) {
    const m = extractConvMeta(id, d);
    stUpsertConv.run(
      id, m.rev, m.updated, m.created, m.title, m.pinned, m.archived, m.trashed, m.drop_cards,
      m.folder, m.has_doc, m.doc_name, m.asset, m.system_text, m.pins_json, JSON.stringify(d)
    );
  }

  function syncPassages(cid, indexDoc) {
    const entries = Array.isArray(indexDoc && indexDoc.e) ? indexDoc.e : [];
    const preserveDoc = !!(indexDoc && indexDoc.keepDoc && stHasDocPassages.get(cid));
    let baseIdx = 0;
    if (preserveDoc) {
      stDeleteNonDocPassages.run(cid);
      baseIdx = Number((stMaxDocPassageIdx.get(cid) || {}).m ?? -1) + 1;
    } else {
      stDeletePassages.run(cid);
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || typeof e.x !== 'string') continue;
      if (preserveDoc && e.k === 'd') continue;
      stInsertPassage.run(
        cid, baseIdx + i, String(e.k || ''), String(e.tid || ''), String(e.mid || ''),
        Number(e.p || 0), Number(e.n || 0), Number(e.o || 0), e.x
      );
    }
  }

  // Non-destructive one-time migration from legacy JSON folders (convs, cards, index, skills, prompts, layouts).
  function migrateLegacyJson() {
    const legacyColls = ['convs', 'cards', 'index', 'skills', 'prompts', 'layouts'];
    const present = legacyColls.filter((c) => existsSync(path.join(dataDir, c)));
    if (!present.length) return 0;

    const already = db.prepare('SELECT (SELECT COUNT(*) FROM convs) + (SELECT COUNT(*) FROM docs) + (SELECT COUNT(*) FROM layouts) AS n').get();
    if (already && already.n > 0) return 0;

    let migrated = 0;
    tx(() => {
      for (const coll of present) {
        const dir = path.join(dataDir, coll);
        let names = [];
        try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { continue; }
        for (const n of names) {
          const id = n.slice(0, -5);
          let d;
          try { d = JSON.parse(readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
          if (!d || typeof d !== 'object') continue;
          if (coll === 'convs') {
            writeConvRow(id, d);
          } else if (coll === 'layouts') {
            stUpsertLayout.run(id, JSON.stringify(d));
          } else {
            const convId = coll === 'cards' ? String(d.conv || '') : '';
            stUpsertDoc.run(coll, id, convId, JSON.stringify(d));
            if (coll === 'index') syncPassages(id, d);
          }
          migrated++;
        }
      }
    });

    // Move migrated legacy directories into data/_legacy_json/ as a safe backup so they won't be re-imported.
    const backupDir = path.join(dataDir, '_legacy_json');
    try {
      mkdirSync(backupDir, { recursive: true });
      for (const coll of present) {
        const src = path.join(dataDir, coll);
        let dst = path.join(backupDir, coll);
        if (existsSync(dst)) dst = path.join(backupDir, `${coll}-${Date.now()}`);
        try { renameSync(src, dst); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    return migrated;
  }

  const migratedCount = migrateLegacyJson();

  function listConvMeta() {
    return stListMeta.all().map((r) => ({ id: r.id, data: rowToMeta(r) }));
  }

  function listDocs(coll) {
    const rows = coll === 'convs' ? stListConvs.all() : stListDocs.all(coll);
    const out = [];
    for (const r of rows) {
      try { out.push({ id: r.id, data: JSON.parse(r.data) }); } catch { /* skip corrupt */ }
    }
    return out;
  }

  function readDoc(coll, id) {
    const r = coll === 'convs' ? stGetConv.get(id) : stGetDoc.get(coll, id);
    if (!r) return null;
    try { return JSON.parse(r.data); } catch { return null; }
  }

  function getRev(coll, id) {
    if (coll === 'convs') {
      const r = stGetConvRev.get(id);
      return r ? Number(r.rev || 0) : null;
    }
    const d = readDoc(coll, id);
    return d === null ? null : Number(d.rev || 0);
  }

  function hasConv(id) {
    return !!stHasConv.get(id);
  }

  function putDoc(coll, id, d) {
    tx(() => {
      if (coll === 'index') {
        const cur = stGetDoc.get('index', id);
        if (cur) {
          try {
            const old = JSON.parse(cur.data);
            if (Number(old && old.rev) > 0 && Number(d && d.rev) > 0 && Number(d.rev) < Number(old.rev)) return;
          } catch { /* overwrite corrupt */ }
        }
      }
      const convId = coll === 'cards' ? String(d.conv || '') : '';
      stUpsertDoc.run(coll, id, convId, JSON.stringify(d));
      if (coll === 'index') syncPassages(id, d);
    });
  }

  function saveConv(id, d, baseRev) {
    return tx(() => {
      const cur = stGetConv.get(id);
      if (baseRev !== undefined) {
        if (!cur && Number(baseRev) > 0) return { status: 410, error: 'This conversation was deleted.' };
        if (cur && Number(cur.rev || 0) !== Number(baseRev)) {
          return { status: 409, error: 'Changed elsewhere', current: JSON.parse(cur.data) };
        }
      }
      d.rev = (cur ? Number(cur.rev || 0) : 0) + 1;
      writeConvRow(id, d);
      return { status: 200, rev: d.rev };
    });
  }

  function updateConv(id, fn) {
    return tx(() => {
      const cur = stGetConv.get(id);
      if (!cur) return false;
      const d = JSON.parse(cur.data);
      if (!fn(d)) return false;
      d.rev = Number(cur.rev || 0) + 1;
      d.updated = Date.now();
      writeConvRow(id, d);
      return true;
    });
  }

  function patchDoc(coll, id, patch) {
    return tx(() => {
      const d = readDoc(coll, id);
      if (d === null) return false;
      Object.assign(d, patch);
      if (coll === 'convs') {
        d.rev = Number(d.rev || 0) + 1;
        writeConvRow(id, d);
      } else {
        const convId = coll === 'cards' ? String(d.conv || '') : '';
        stUpsertDoc.run(coll, id, convId, JSON.stringify(d));
        if (coll === 'index') syncPassages(id, d);
      }
      return true;
    });
  }

  function deleteDoc(coll, id) {
    tx(() => {
      if (coll === 'convs') {
        stDeleteConv.run(id);
        stDeleteLayout.run(id);
        stDeleteDoc.run('index', id);
        stDeletePassages.run(id);
      } else {
        stDeleteDoc.run(coll, id);
        if (coll === 'index') stDeletePassages.run(id);
      }
    });
  }

  function getLayout(convId) {
    const r = stGetLayout.get(convId);
    if (!r) return { devices: {} };
    try {
      const d = JSON.parse(r.data);
      return d && d.devices ? d : { devices: {} };
    } catch { return { devices: {} }; }
  }

  function putLayout(convId, device, ui, layoutDays) {
    return tx(() => {
      if (!stHasConv.get(convId)) return false;
      const d = getLayout(convId);
      const now = Date.now();
      const devices = {};
      for (const [k, v] of Object.entries(d.devices || {})) {
        if (v && now - (v.at || 0) < layoutDays * 864e5) devices[k] = v;
      }
      devices[device] = { ui, at: now };
      stUpsertLayout.run(convId, JSON.stringify({ devices }));
      return true;
    });
  }

  function allUsedAssets() {
    const used = new Set();
    const scan = (rows) => {
      for (const r of rows) {
        if (typeof r.data !== 'string') continue;
        for (const m of r.data.matchAll(/"asset(?:Id)?":"([a-f0-9]{32})"/g)) used.add(m[1]);
      }
    };
    scan(stAllAssetsConvs.all());
    scan(stAllAssetsCards.all());
    return used;
  }

  function purgeTrash(trashDays) {
    const cutoff = Date.now() - trashDays * 864e5;
    return tx(() => {
      const rows = stExpiredTrash.all(cutoff);
      let gone = 0;
      for (const r of rows) {
        stDeleteConv.run(r.id);
        stDeleteLayout.run(r.id);
        stDeleteDoc.run('index', r.id);
        stDeletePassages.run(r.id);
        if (r.drop_cards) stDeleteCardsOf.run(r.id);
        gone++;
      }
      return gone;
    });
  }

  // Server-side FTS5 search with the same ranking rules as the client:
  // exact phrase first, then more typed words matched, then kind-boosted BM25.
  function searchPassages(q, opts = {}) {
    const raw = String(q || '').trim();
    if (!raw) return [];
    const words = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    if (!words.length) return [];

    const scope = opts.scope === 'conv' || opts.scope === 'thread' ? opts.scope : 'all';
    const cid = String(opts.cid || '');
    const tid = String(opts.tid || '');
    const limit = Math.min(Math.max(Number(opts.limit) || 120, 1), 300);

    const qTok = (w, prefix) => {
      const safe = w.replace(/"/g, '""');
      return prefix ? `"${safe}"*` : `"${safe}"`;
    };
    const ftsTokens = words.map((w, i) => qTok(w, i === words.length - 1 && w.length > 1));

    let stmt = stSearchAll;
    const baseParams = [];
    if (scope === 'conv' && cid) {
      stmt = stSearchConv;
      baseParams.push(cid);
    } else if (scope === 'thread' && cid) {
      if (tid === 'doc') {
        stmt = stSearchThreadDoc;
        baseParams.push(cid);
      } else {
        stmt = stSearchThreadMsg;
        baseParams.push(cid, tid);
      }
    }
    const runMatch = (expr) => {
      try { return stmt.all(expr, ...baseParams); } catch { return []; }
    };

    let matchedTerms = [...words];
    let rows = runMatch(ftsTokens.join(' '));

    // Typo-tolerant fallback via fts5vocab (matches MiniSearch's fuzzy: 0.2 for words >= 5 chars)
    if (!rows.length) {
      const fuzzyParts = [];
      const extraTerms = new Set(words);
      let expanded = false;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const base = qTok(w, i === words.length - 1 && w.length > 1);
        if (w.length < 5) {
          fuzzyParts.push(base);
          continue;
        }
        const maxD = Math.min(2, Math.floor(w.length * 0.2));
        const cands = [];
        const chars = [...w];
        const prefixes = chars.length > 1 && chars[1] !== chars[0] ? [chars[0], chars[1]] : [chars[0]];
        for (const ch of prefixes) {
          const nextCh = String.fromCodePoint(ch.codePointAt(0) + 1);
          for (const r of stVocabPrefix.all(ch, nextCh, w.length - maxD, w.length + maxD)) {
            const d = editDistBounded(w, r.term, maxD);
            if (d <= maxD) cands.push({ term: r.term, d, doc: r.doc });
          }
        }
        if (cands.length) {
          cands.sort((a, b) => (a.d - b.d) || (b.doc - a.doc));
          const top = cands.slice(0, 6).map((c) => c.term);
          for (const t of top) extraTerms.add(t);
          fuzzyParts.push('(' + [base, ...top.map((t) => qTok(t, false))].join(' OR ') + ')');
          expanded = true;
        } else {
          fuzzyParts.push(base);
        }
      }
      if (expanded) {
        rows = runMatch(fuzzyParts.join(' '));
        if (!rows.length && fuzzyParts.length > 1) rows = runMatch(fuzzyParts.join(' OR '));
        if (rows.length) matchedTerms = [...extraTerms];
      }
    }

    if (!rows.length && ftsTokens.length > 1) {
      rows = runMatch(ftsTokens.join(' OR '));
    }
    if (!rows.length) return [];

    const qw = words.filter((w) => w.length > 1);
    const phRe = qw.length > 1 ? new RegExp(WB + qw.map(RE_ESC).join('[^\\p{L}\\p{N}]+'), 'u') : null;
    const wRes = qw.map((w) => new RegExp(WB + RE_ESC(w), 'u'));

    const ranked = rows.map((r) => {
      const low = (r.x || '').toLowerCase();
      const phrase = phRe && phRe.test(low) ? 1 : 0;
      const exact = wRes.filter((re) => re.test(low)).length;
      const boost = KIND_BOOST[r.k] || 1;
      // SQLite bm25() is negative (more negative = better match)
      const score = boost * (1 + Math.max(0, -Number(r.rank || 0)));
      return {
        cid: r.cid,
        k: r.k,
        tid: r.tid || undefined,
        mid: r.mid || undefined,
        p: r.p || undefined,
        n: r.n || 0,
        o: r.o || 0,
        x: r.x,
        phrase,
        exact,
        score,
        terms: matchedTerms,
      };
    });

    ranked.sort((a, b) => (b.phrase - a.phrase) || (b.exact - a.exact) || (b.score - a.score));

    // One best passage per message/branch/page, and attach branch title (bt)
    const seen = new Set();
    const btCache = new Map();
    const out = [];
    for (const r of ranked) {
      const key = r.cid + '|' + (r.mid || '') + '|' + r.k + '|' + (r.k === 'd' ? r.p : (r.k === 'bt' || r.k === 'h') ? r.tid : '');
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.tid && r.tid !== 'main' && r.k !== 'd' && r.k !== 'ct') {
        const btk = r.cid + '|' + r.tid;
        if (!btCache.has(btk)) {
          const btRow = stGetBranchTitle.get(r.cid, r.tid);
          btCache.set(btk, btRow ? btRow.x : '');
        }
        const bt = btCache.get(btk);
        if (bt) r.bt = bt;
      }
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  return {
    db,
    dbPath,
    migratedCount,
    listConvMeta,
    listDocs,
    readDoc,
    getRev,
    hasConv,
    putDoc,
    saveConv,
    updateConv,
    patchDoc,
    deleteDoc,
    getLayout,
    putLayout,
    allUsedAssets,
    purgeTrash,
    searchPassages,
    close: () => db.close(),
  };
}
