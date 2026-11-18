// The page's libraries, from this server: GET /lib/<package>@<version>/<file> serves node_modules/<package>/<file>
// when it's one listed in libs.json and the installed package is that exact version. Otherwise 404, and the page
// fetches the CDN's copy instead (web/index.html: LIBS). Either way the page checks the file against its hash.
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

// the file on disk for a /lib/ path, or null. Only names in libs.json, so nothing else under node_modules is reachable.
export function libFile(rest) {
  if (!LIBS.includes(rest)) return null;
  const m = rest.match(/^((?:@[^/@]+\/)?[^/@]+)@([^/]+)\/(.+)$/);
  if (!m || installed(m[1]) !== m[2]) return null;
  const f = path.join(ROOT, 'node_modules', m[1], m[3]);
  return existsSync(f) ? f : null;
}
