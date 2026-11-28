// The demo runs the server's own Gemini code (server/gemini.mjs, doctools.mjs, content.mjs) instead of a copy:
// these checks fail if those files take on a Node-only API (the demo couldn't load them), if demo/build.mjs stops
// copying them, or if demo/demo.js grows its own Gemini request, stream or tool-session code again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : '\n      ' + detail}`); };

const SHARED = ['gemini.mjs', 'doctools.mjs', 'content.mjs'];
for (const f of SHARED) {
  const src = read('server/' + f);
  const node = [/from 'node:/, /\bBuffer\b/, /(?<!globalThis\.)\bprocess\.env\b/, /\brequire\(/].filter((re) => re.test(src.replace(/\/\/.*$/gm, '')));
  check(`server/${f} uses no Node-only API (the demo runs it in the browser)`, !node.length, node.join(', '));
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  check(`server/${f} imports only the other shared files`, imports.every((i) => SHARED.includes(i.replace('./', ''))), imports.join(', '));
}

const build = read('demo/build.mjs');
check('demo/build.mjs copies the shared files into the site', SHARED.every((f) => build.includes(`'${f}'`)));

const demo = read('demo/demo.js');
// what only the Gemini code itself should spell: the request, its stream, its tools, its errors, its checks
const OWN = { streamGenerateContent: /streamGenerateContent/, functionDeclarations: /functionDeclarations/, thinkingConfig: /thinkingConfig/,
  groundingMetadata: /groundingMetadata/, 'functionResponse': /functionResponse/, 'the model-list filter': /supportedGenerationMethods/,
  "Google's error wording": /high demand|free tier’s request limit/, 'a tool-call budget': /reading tool calls? for one answer/,
  'a message check': /has no valid role|isn't text or an image/ };
for (const [what, re] of Object.entries(OWN)) check(`demo/demo.js has no copy of ${what} (it uses server/gemini.mjs)`, !re.test(demo));
check('demo/demo.js loads the shared files', SHARED.every((f) => demo.includes(f.replace('.mjs', ''))) && /import\(/.test(demo));

console.log(`demo_shared: ${passed} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
