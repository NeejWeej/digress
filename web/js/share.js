// Pure client-side shareable link helpers (#share=<base64url(gzip(json))>).
// The entire conversation lives in the URL #fragment, which browsers never send to any server.
// Works identically in the browser and in Node unit tests (zero DOM dependencies).

export const PUBLIC_DEMO_URL = 'https://digress.neejweej.workers.dev/';
export const SHARE_PREFIX = '#share=';
export const SHARE_GOOD_LEN = 8000;          // comfortable in almost every chat/email app
export const SHARE_MAX_LEN = 65536;          // 64 KB URL cap; larger conversations use .digress files
export const SHARE_MAX_DECODED = 2 * 1024 * 1024;   // 2 MiB uncompressed cap for links (gzip-bomb protection)
export const FILE_MAX_DECODED = 100 * 1024 * 1024;  // 100 MiB uncompressed cap for .digress files (allows PDFs/images)
export const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;  // 16 MiB cap for inline data:image/*;base64,… payloads
const INLINE_IMG_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i;

// Decode and validate a supported inline raster image data URL locally (never via fetch()).
export function parseInlineImageDataUrl(dataUrl, maxBytes = MAX_INLINE_IMAGE_BYTES) {
  if (typeof dataUrl !== 'string') throw new Error('Invalid inline image data.');
  const m = INLINE_IMG_RE.exec(dataUrl);
  if (!m) throw new Error('Unsupported or invalid inline image data.');
  const b64 = m[2];
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > maxBytes) throw new Error('Inline image is too large.');
  let bin;
  try { bin = atob(b64); } catch { throw new Error('Invalid inline image encoding.'); }
  if (bin.length > maxBytes) throw new Error('Inline image is too large.');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { type: m[1].toLowerCase(), bytes };
}

// Validate a 0-based document page index as a bounded non-negative integer.
export function normalizePageIndex(v, max = 100000) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) {
    bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  if (typeof str !== 'string' || !str || !/^[A-Za-z0-9_-]+$/.test(str)) {
    throw new Error('Invalid share link encoding.');
  }
  const pad = (4 - (str.length % 4)) % 4;
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gzipBytes(text) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('This browser does not support CompressionStream.');
  }
  const stream = new Blob([enc.encode(text)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decompress gzip bytes while enforcing a hard upper bound on output size (gzip-bomb defense).
export async function gunzipBytesCapped(bytes, maxBytes = SHARE_MAX_DECODED) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u.length < 2 || u[0] !== 0x1f || u[1] !== 0x8b) {
    throw new Error('Not a gzipped share link.');
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not support DecompressionStream.');
  }
  const stream = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('This share link is too large to open safely.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) { out.set(ch, off); off += ch.byteLength; }
  return out;
}

export async function encodeSharePayload(fileObj) {
  const gz = await gzipBytes(JSON.stringify(fileObj));
  const token = toBase64Url(gz);
  return { token, gzBytes: gz.byteLength };
}

export async function decodeSharePayload(token, maxBytes = SHARE_MAX_DECODED) {
  if (typeof token !== 'string' || !token) throw new Error('Empty share link.');
  if (token.length > SHARE_MAX_LEN * 2) throw new Error('This share link is too large to open.');
  const gz = fromBase64Url(token);
  const raw = await gunzipBytesCapped(gz, maxBytes);
  return JSON.parse(dec.decode(raw));
}

export function buildShareUrl(token, baseUrl) {
  const clean = String(baseUrl || PUBLIC_DEMO_URL).split('#')[0];
  return clean + SHARE_PREFIX + token;
}

export function parseShareHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(SHARE_PREFIX)) return null;
  const rest = hash.slice(SHARE_PREFIX.length);
  const amp = rest.indexOf('&');
  const token = (amp >= 0 ? rest.slice(0, amp) : rest).trim();
  return token || null;
}

export function formatBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function shareSizeStatus(urlLen) {
  const size = formatBytes(urlLen);
  if (urlLen <= SHARE_GOOD_LEN) {
    return { ok: true, level: 'good', size, text: `${size} link — works in most chat apps.` };
  }
  if (urlLen <= SHARE_MAX_LEN) {
    return { ok: true, level: 'warn', size, text: `${size} link — long URL; some chat apps may truncate it.` };
  }
  return { ok: false, level: 'over', size, text: `${size} — too large for a link. Uncheck items above, or export as a .digress file.` };
}

// Prune a conversation down to one branch (tid), its descendants, and the ancestor path leading up to it
// (each ancestor truncated at the fork message; empty for CLIP/DOC/START branches). Always preserves a valid tree.
export function sliceBranch(c, tid) {
  if (!c || !tid || tid === 'main' || !c.threads || !c.threads[tid]) return c;
  const anc = [], seen = new Set();
  let cur = c.threads[tid];
  while (cur) {
    if (seen.has(cur.id)) return c;
    seen.add(cur.id);
    anc.unshift(cur.id);
    cur = cur.parent ? c.threads[cur.parent] : null;
  }
  if (anc[0] !== 'main') return c;
  const subtree = new Set([tid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of Object.values(c.threads)) {
      if (t && !subtree.has(t.id) && t.parent && subtree.has(t.parent)) { subtree.add(t.id); grew = true; }
    }
  }
  const keep = new Set([...anc, ...subtree]);
  const threads = {}, order = {}, msgs = {};
  for (const id of keep) threads[id] = JSON.parse(JSON.stringify(c.threads[id]));
  for (let i = 0; i < anc.length - 1; i++) {
    const a = anc[i], child = c.threads[anc[i + 1]], ids = c.order[a] || [];
    if (!child || !child.anchorMsg || child.anchorMsg === 'DOC' || child.anchorMsg === 'CLIP' || child.anchorMsg === 'START') {
      order[a] = [];
    } else {
      const idx = ids.indexOf(child.anchorMsg);
      order[a] = idx >= 0 ? ids.slice(0, idx + 1) : [];
    }
  }
  for (const id of subtree) order[id] = [...(c.order[id] || [])];
  for (const ids of Object.values(order)) {
    for (const mid of ids) {
      if (!c.msgs[mid]) continue;
      const m = JSON.parse(JSON.stringify(c.msgs[mid]));
      if (m.role === 'note' && m.fromThread && !keep.has(m.fromThread)) {
        m.fromTitle = (c.threads[m.fromThread] && c.threads[m.fromThread].title) || m.fromTitle || 'a branch';
      }
      msgs[mid] = m;
    }
  }
  const out = { ...JSON.parse(JSON.stringify(c)), threads, order, msgs };
  out.title = c.threads[tid].title || c.title || 'Shared branch';
  return out;
}

// Replace all non-'main' thread IDs and all message IDs in an imported conversation with fresh safe IDs,
// updating every internal reference so sender-supplied IDs never enter local storage or the DOM.
export function remapConvIds(c, makeId) {
  let seq = 0;
  const gen = typeof makeId === 'function' ? makeId : (p) => p + (++seq).toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const tMap = new Map([['main', 'main']]);
  const mMap = new Map();
  for (const tid of Object.keys(c.threads || {})) {
    if (tid !== 'main') tMap.set(tid, gen('t'));
  }
  for (const mid of Object.keys(c.msgs || {})) {
    mMap.set(mid, gen('m'));
  }
  const threads = {}, order = {}, msgs = {};
  for (const [oldTid, t] of Object.entries(c.threads || {})) {
    const newTid = tMap.get(oldTid);
    const nt = { ...t, id: newTid };
    if (nt.parent != null) nt.parent = tMap.get(nt.parent) || null;
    if (nt.anchorMsg && mMap.has(nt.anchorMsg)) nt.anchorMsg = mMap.get(nt.anchorMsg);
    threads[newTid] = nt;
  }
  for (const [oldTid, ids] of Object.entries(c.order || {})) {
    const newTid = tMap.get(oldTid);
    if (!newTid) continue;
    order[newTid] = (ids || []).map((id) => mMap.get(id)).filter(Boolean);
  }
  for (const [oldMid, m] of Object.entries(c.msgs || {})) {
    const newMid = mMap.get(oldMid);
    const nm = { ...m, id: newMid, thread: tMap.get(m.thread) || 'main' };
    if (nm.fromThread != null) {
      if (tMap.has(nm.fromThread)) nm.fromThread = tMap.get(nm.fromThread);
      else delete nm.fromThread;
    }
    if (nm.upTo != null) {
      if (mMap.has(nm.upTo)) nm.upTo = mMap.get(nm.upTo);
      else delete nm.upTo;
    }
    msgs[newMid] = nm;
  }
  c.threads = threads;
  c.order = order;
  c.msgs = msgs;
  return { tMap, mMap };
}
