#!/usr/bin/env node
// Builds the demo site: the real page (web/) with demo/demo.js in front of it answering /api/* in the browser.
//   node demo/build.mjs [out-dir]      (default: _site)
// The page's own code isn't changed, only two <script> tags added at the top of <head>, so the demo is
// whatever web/ is now. .github/workflows/demo.yml runs this on every push to main and publishes it to GitHub
// Pages; tests/test_demo.py builds it into a temp folder and drives it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE_DOCS } from '../server/guide.mjs';

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

// the rest of web/, except the service worker: the demo keeps nothing to work offline for
for (const f of fs.readdirSync(from('web'))) if (f !== 'index.html' && f !== 'sw.js') fs.copyFileSync(from('web', f), path.join(OUT, f));
for (const f of ['demo.js', 'replies.js', 'sample.pdf', 'seed.json']) fs.copyFileSync(from('demo', f), path.join(OUT, 'demo', f));

// what "Ask about Digress" reads (GET /api/guide on the real server)
const docs = GUIDE_DOCS.filter(([f]) => fs.existsSync(from(f))).map(([file, name]) => ({ name, file, text: fs.readFileSync(from(file), 'utf8') }));
fs.writeFileSync(path.join(OUT, 'demo', 'guide.json'), JSON.stringify({ docs }));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log('demo site built in', OUT);
