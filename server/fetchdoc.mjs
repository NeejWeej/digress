// Open a document from a link: the server downloads it for you, because most sites don't let a web
// page fetch their files directly. The aim is that this is no riskier than downloading the file
// yourself and uploading it.
//
// The risk with a server that fetches links ("SSRF") is that it can reach things an outside site
// can't: this machine (127.0.0.1, including Digress's own API), your router and local network,
// your tailnet, cloud metadata addresses. So:
//
//  - Only you can start a download: it is a POST from Digress's own page (the Host/Origin check in
//    server.mjs refuses other websites), and the model has no way to call it.
//  - Never fetched: anything but http(s), links with a username/password in them, and any address
//    that isn't on the public internet (private, loopback, link-local, carrier-grade NAT/Tailscale,
//    multicast, reserved, IPv6 equivalents). The check runs on the address we actually connect to,
//    inside the DNS lookup, so a name can't pass the check and then point somewhere else (DNS
//    rebinding), and it runs again for every redirect.
//  - Fetched only after you confirm: plain http (unencrypted, so the file could be swapped on the
//    way), a raw IP address instead of a name, or an unusual port. A redirect that leads to one of
//    these stops and asks too, before connecting to it. A redirect from https to http is refused.
//  - Kept: only real PDFs (checked by their first bytes, not by what the site claims), UTF-8
//    Markdown/plain text, and web pages (articles), up to the upload size limit. A web page is handed to
//    Digress's page as plain text: it is never served or shown as a page, nothing in it runs, and the
//    browser pulls the article out of it (Readability) and turns it into Markdown.
//  - Images (want:'image', for an article's pictures, only when you load them): only real PNG, JPEG,
//    WebP or GIF files, checked by their bytes. SVG and everything else are refused.
//  - Sent: a plain GET with no cookies, no referrer and no credentials. The site sees this server's
//    IP address, as it would see yours if you downloaded the file.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { isImage, IMAGE_TYPES } from './content.mjs';

// Two separate lists on purpose: a BlockList checks IPv4 addresses against its IPv6 rules too (as
// ::ffff:a.b.c.d), so one list holding the IPv4-mapped range would block every IPv4 address.
const BLOCKED4 = new net.BlockList(), BLOCKED6 = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED4.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCKED6.addSubnet(a, p, 'ipv6');
// IPv4-mapped (::ffff:a.b.c.d), NAT64, 6to4 and Teredo can all wrap a private IPv4 address, so they're blocked as a whole.
export const publicAddress = (ip) => { const v = net.isIP(ip); return v === 4 ? !BLOCKED4.check(ip, 'ipv4') : v === 6 && !BLOCKED6.check(ip, 'ipv6'); };

class LinkError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|ts\.net)$/i;

// Hard rules first (throw), then the warnings this hop would need you to confirm.
function inspect(u, testAllow) {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new LinkError('Only http and https links can be opened.');
  if (u.username || u.password) throw new LinkError('Links with a username or password in them are not opened.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ip = net.isIP(host);
  // tests only: DOC_FETCH_TEST_ALLOW=127.0.0.1:<port> lets the test suite's fake site through, that exact port alone
  if (ip && !publicAddress(host) && !(testAllow && u.host === testAllow)) throw new LinkError('That link points to a private or local address, which Digress won’t fetch.');
  if (!ip && (!host.includes('.') || LOCAL_NAMES.test(host))) throw new LinkError('That link points to a local network name, which Digress won’t fetch.');
  const warn = [];
  if (u.protocol === 'http:') warn.push('http');
  if (ip) warn.push('ip');
  if (u.port && u.port !== (u.protocol === 'https:' ? '443' : '80')) warn.push('port');
  return warn;
}
export const WARNINGS = {
  http: 'it isn’t encrypted (http), so the file could be altered on the way',
  ip: 'it uses a bare IP address instead of a site name',
  port: 'it uses an unusual port',
};

// DNS lookup that only ever hands back public addresses; the connection uses exactly what this returns.
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true, family: opts && opts.family, hints: opts && opts.hints }, (err, list) => {
    if (err) return cb(err);
    if (!list.length || !list.every((a) => publicAddress(a.address))) {
      return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    }
    if (opts && opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function get(u, signal, accept) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', lookup: safeLookup, signal, agent: false, // fresh connection: never reuse one opened for another host
      headers: { 'user-agent': 'Digress (document import)', accept, 'accept-encoding': 'identity' },
    }, resolve);
    req.setTimeout(20000, () => req.destroy(new LinkError('The site took too long to answer.', 504)));
    req.on('error', reject);
    req.end();
  });
}

// -> {kind:'pdf'|'text'|'html'|'image', type, body:Buffer, name, url}  or throws LinkError (with .warnings to confirm)
// Does this start like a web page (<!doctype html> or <html>, perhaps after comments)? A loop, not one regex with a
// repeated group around the comments: that regex backtracked exponentially on a page that opens with many comments,
// and the server would hang on such a link.
export function looksLikeHtml(head) {
  let s = head.trimStart();
  while (s.startsWith('<!--')) { const end = s.indexOf('-->', 4); if (end < 0) return false; s = s.slice(end + 3).trimStart(); }
  return /^<(!doctype html|html)/i.test(s);
}

export async function fetchDocument(link, { confirmed = [], maxBytes, signal, testAllow = '', want = 'doc' }) {
  const accept = want === 'image' ? 'image/png, image/jpeg, image/webp, image/gif;q=0.9' : 'application/pdf, text/markdown, text/html;q=0.9, text/plain;q=0.9, */*;q=0.1';
  let u;
  try { u = new URL(String(link).trim()); } catch { throw new LinkError('That doesn’t look like a link.'); }
  const ok = new Set(confirmed);
  for (let hop = 0; ; hop++) {
    const warn = inspect(u, testAllow).filter((w) => !ok.has(w));
    if (warn.length) throw Object.assign(new LinkError(hop ? 'The link redirects somewhere that needs your OK first.' : 'This link needs your OK first.', 409), { warnings: warn, url: u.href });
    let res;
    try { res = await get(u, signal, accept); } catch (e) {
      if (e instanceof LinkError) throw e;
      if (e.code === 'EBLOCKED') throw new LinkError('That link points to a private or local address, which Digress won’t fetch.');
      if (e.name === 'AbortError') throw e;
      throw new LinkError('Could not reach that site (' + (e.code || e.message) + ').', 502);
    }
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.resume();
      if (hop >= 5) throw new LinkError('That link redirects too many times.', 502);
      let next;
      try { next = new URL(res.headers.location || '', u); } catch { throw new LinkError('That link redirects somewhere invalid.', 502); }
      if (u.protocol === 'https:' && next.protocol === 'http:') throw new LinkError('That link redirects from https to unencrypted http, so it isn’t opened.', 502);
      u = next; continue;
    }
    if (res.statusCode !== 200) { res.resume(); throw new LinkError(`The site answered ${res.statusCode}${res.statusCode === 403 || res.statusCode === 401 ? ' (it may need a login, which Digress doesn’t use)' : ''}.`, 502); }
    if ((res.headers['content-encoding'] || 'identity').toLowerCase() !== 'identity') { res.resume(); throw new LinkError('The site sent a compressed file Digress doesn’t unpack.', 502); }
    const declared = Number(res.headers['content-length'] || 0);
    if (declared > maxBytes) { res.destroy(); throw new LinkError(`That file is over ${Math.round(maxBytes / 1048576)} MB.`, 413); }
    const chunks = []; let size = 0;
    for await (const c of res) {
      size += c.length;
      if (size > maxBytes) { res.destroy(); throw new LinkError(`That file is over ${Math.round(maxBytes / 1048576)} MB.`, 413); }
      chunks.push(c);
    }
    const body = Buffer.concat(chunks);
    const ctype = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const name = fileName(res.headers['content-disposition'], u);
    if (want === 'image') {
      const type = [...IMAGE_TYPES].find((t) => isImage(t, body));
      if (!type) throw new LinkError(`That isn’t an image Digress shows (PNG, JPEG, WebP or GIF)${ctype ? `; the site says ${ctype}` : ''}.`, 415);
      return { kind: 'image', type, body, name, url: u.href };
    }
    if (body.subarray(0, 1024).includes('%PDF-')) return { kind: 'pdf', type: 'application/pdf', body, name, url: u.href };
    if (/^text\/html|xhtml/.test(ctype) || looksLikeHtml(body.subarray(0, 2048).toString('latin1'))) {
      // a web page: decode it with the charset it declares (header, then <meta>), and hand it over as text
      const head = body.subarray(0, 4096).toString('latin1');
      const cs = (/charset=["']?([\w-]+)/i.exec(String(res.headers['content-type'] || '')) || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8';
      let html;
      try { html = new TextDecoder(cs.toLowerCase()).decode(body); } catch { html = new TextDecoder('utf-8').decode(body); }
      return { kind: 'html', type: 'text/plain; charset=utf-8', body: Buffer.from(html), name, url: u.href };
    }
    const textual = /^text\/(plain|markdown|x-markdown)$/.test(ctype) || (!ctype || ctype === 'application/octet-stream') && /\.(md|markdown|txt)$/i.test(u.pathname);
    if (!textual) throw new LinkError(`That link is a ${ctype || 'file'} file; Digress opens PDF, Markdown and text.`, 415);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { throw new LinkError('That text file isn’t valid UTF-8.', 415); }
    if (text.includes('\u0000')) throw new LinkError('That doesn’t look like a text file.', 415);
    return { kind: 'text', type: 'text/markdown', body: Buffer.from(text), name, url: u.href };
  }
}

function fileName(disposition, u) {
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition || '');
  let n = '';
  try { n = m ? decodeURIComponent(m[1] || m[2]) : decodeURIComponent(path.posix.basename(u.pathname)); } catch { n = path.posix.basename(u.pathname); }
  n = n.replace(/[\u0000-\u001f]/g, '').replace(/\.(pdf|md|markdown|txt)$/i, '').trim().slice(0, 120);
  return n || u.hostname;
}
