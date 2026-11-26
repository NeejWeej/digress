// Pure client-side shareable link helpers (#share=<base64url(gzip(json))>).
// The entire conversation lives in the URL #fragment, which browsers never send to any server.
// Works identically in the browser and in Node unit tests (zero DOM dependencies).

export const PUBLIC_DEMO_URL = 'https://digress.neejweej.workers.dev/';
export const SHARE_PREFIX = '#share=';
export const SHARE_GOOD_LEN = 8000;          // comfortable in almost every chat/email app
export const SHARE_MAX_LEN = 32768;          // 32 KB URL cap; larger conversations use .digress files
export const SHARE_MAX_DECODED = 2 * 1024 * 1024;   // 2 MiB uncompressed cap (gzip-bomb protection)

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
