#!/usr/bin/env node
// Builds the demo site: the real page (web/) with demo/demo.js in front of it answering /api/* in the browser.
//   node demo/build.mjs [out-dir]      (default: _site)
// The page's own code isn't changed, only two <script> tags added at the top of <head>, so the demo is
// whatever web/ is now. .github/workflows/demo.yml runs this on every push to main and publishes it to GitHub
// Pages; tests/test_demo.py builds it into a temp folder and drives it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guideDocs } from '../server/guide.mjs';
import { libPaths, libFile } from '../server/libs.mjs';
import { ALL_TOOLS, MAX_TOOL_CALLS, MAX_CARD_CALLS } from '../server/doctools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '_site'));
const from = (...p) => path.join(ROOT, ...p);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'demo'), { recursive: true });

let html = fs.readFileSync(from('web', 'index.html'), 'utf8');
const at = html.indexOf('<head>');
if (at < 0) throw new Error('web/index.html has no <head> to put the demo scripts in');
html = html.slice(0, at + 6) + '\n<script src="demo/replies.js"></script>\n<script src="demo/demo.js"></script>' + html.slice(at + 6);
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// the rest of web/, except the service worker: the demo has its own (demo/sw.js), which keeps nothing offline and
// only makes a visit after a deploy get the new page
for (const f of fs.readdirSync(from('web'))) if (f !== 'index.html' && f !== 'sw.js') fs.copyFileSync(from('web', f), path.join(OUT, f));
fs.copyFileSync(from('demo', 'sw.js'), path.join(OUT, 'sw.js'));
for (const f of ['demo.js', 'replies.js', 'sample.pdf', 'seed.json']) fs.copyFileSync(from('demo', f), path.join(OUT, 'demo', f));

// the libraries and fonts, from node_modules when installed (lib/, as the server serves them); the page uses a CDN for any missing
for (const l of libPaths()) {
  const f = libFile(l);
  if (f) { fs.mkdirSync(path.dirname(path.join(OUT, 'lib', l)), { recursive: true }); fs.copyFileSync(f, path.join(OUT, 'lib', l)); }
}

// what "Ask about Digress" reads (GET /api/guide on the real server)
const docs = guideDocs().filter(([f]) => fs.existsSync(from(f))).map(([file, name]) => ({ name, file, text: fs.readFileSync(from(file), 'utf8') }));
fs.writeFileSync(path.join(OUT, 'demo', 'guide.json'), JSON.stringify({ docs }));
// the tools the model can be given, for the Prompts page (GET /api/tools on the real server)
fs.writeFileSync(path.join(OUT, 'demo', 'tools.json'), JSON.stringify({ tools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, schema: t.schema })), maxCalls: MAX_TOOL_CALLS, maxCards: MAX_CARD_CALLS }));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
// Cloudflare Workers static-asset headers: strict CSP (connect-src allows only self + Anthropic/Gemini for BYOK),
// no-cache revalidation on app files, and immutable caching on versioned /lib/* files.
fs.writeFileSync(path.join(OUT, '_headers'), [
  '/*',
  "  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' https://api.anthropic.com https://generativelanguage.googleapis.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  X-Frame-Options: DENY',
  '  Cache-Control: no-cache',
  '',
  '/lib/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
].join('\n'));
console.log('demo site built in', OUT);
