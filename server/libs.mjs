// The page's libraries, from this server: GET /lib/<package>@<version>/<file> serves node_modules/<package>/<file>
// when it's one listed in libs.json and the installed package is that exact version. Otherwise 404, and the page
// fetches the CDN's copy instead (web/index.html: LIBS). Either way the page checks the file against its hash.
// Fonts work the same way: libs.json lists each font's stylesheet (from @fontsource), and the .woff2 files that
// stylesheet names (url(./files/…)) are served too, and no other file of the package.
// Nothing here is needed to run Digress: without `npm install` there is no node_modules and every answer is 404.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIBS = JSON.parse(readFileSync(path.join(ROOT, 'server', 'libs.json'), 'utf8'));

const versions = new Map();
function installed(pkg) {
  if (!versions.has(pkg)) {
    let v = null;
    try { v = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')).version; } catch { /* not installed */ }
    versions.set(pkg, v);
  }
  return versions.get(pkg);
}

const LIB = /^((?:@[^/@]+\/)?[^/@]+)@([^/]+)\/(.+)$/;
const FONT_FILE = /url\(\.\/(files\/[\w.-]+\.woff2)\)/g;

// every /lib/ path that may be served: libs.json's, plus the font files its stylesheets name (read once, from the
// installed copies)
let allowed = null;
export function libPaths() {
  if (!allowed) {
    allowed = new Set(LIBS);
    for (const l of LIBS) {
      if (!l.endsWith('.css')) continue;
      const m = l.match(LIB);
      let css = '';
      try { css = readFileSync(path.join(ROOT, 'node_modules', m[1], m[3]), 'utf8'); } catch { continue; }
      const dir = l.slice(0, l.lastIndexOf('/') + 1);
      for (const [, f] of css.matchAll(FONT_FILE)) allowed.add(dir + f);
    }
  }
  return [...allowed];
}

// the file on disk for a /lib/ path, or null. Only those paths, so nothing else under node_modules is reachable.
export function libFile(rest) {
  if (!libPaths().includes(rest)) return null;
  const m = rest.match(LIB);
  if (!m || installed(m[1]) !== m[2]) return null;
  const f = path.join(ROOT, 'node_modules', m[1], m[3]);
  return existsSync(f) ? f : null;
}

export const libType = (f) => f.endsWith('.css') ? 'text/css; charset=utf-8' : f.endsWith('.woff2') ? 'font/woff2' : 'text/javascript; charset=utf-8';
