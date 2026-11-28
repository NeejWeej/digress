// The client's modules call each other through one registry, `app` (web/js/state.js), filled in one place:
// `Object.assign(app, {...})` near the end of web/js/app.js. A name looked up there is invisible to lint (`app.layotu`
// is not an undefined variable), so this checks every `app.X` the modules use is registered, and every
// `invalidate('key')` (web/js/redraw.js) has a redraw registered for it with `onRedraw('key', fn)`.
// Run with --map for the dependency map: which module uses which registered names, and whose they are.
// Runs in milliseconds with no browser; invoked by tests/test_app_registry.py. agents/layout.md, "The app registry".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = new URL('../web/js/', import.meta.url).pathname;
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]));
const ID = '[A-Za-z_$][\\w$]*';
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');   // every regex special character, backslash included
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');   // comments out (good enough for names)

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n     ' + String(e.message).split('\n').join('\n     ')); }
}

// ---- what's registered ----
const appSrc = strip(src['app.js']);
const block = appSrc.match(/Object\.assign\(app,\s*\{([\s\S]*?)\}\);/);
const registered = new Set();
if (block) for (const part of block[1].split(',')) { const m = part.trim().match(new RegExp(`^(${ID})`)); if (m) registered.add(m[1]); }
for (const m of appSrc.matchAll(new RegExp(`Object\\.defineProperty\\(app,\\s*'(${ID})'`, 'g'))) registered.add(m[1]);

// ---- who uses what ----
const uses = {};   // file -> Map(name -> count)
// app.js itself is left out: it fills the registry and calls its functions directly, and it has a local
// `const app = $('#app')` (the page's root element) whose .classList isn't a registry name
for (const f of files) {
  if (f === 'app.js') { uses[f] = new Map(); continue; }
  const s = strip(src[f]), u = new Map();
  for (const m of s.matchAll(new RegExp(`\\bapp\\.(${ID})`, 'g'))) u.set(m[1], (u.get(m[1]) || 0) + 1);
  uses[f] = u;
}

// ---- whose each name is: the module that defines it (a delegate stub `x=(...a)=>app.x(...a)` isn't a definition) ----
const owner = new Map();
for (const f of files) {
  const s = strip(src[f]);
  for (const name of registered) {
    if (owner.has(name) && owner.get(name) !== 'app.js') continue;
    const n = reEsc(name);
    const def = new RegExp(`(?:\\bfunction\\s*\\*?\\s+${n}\\s*\\(|\\b(?:const|let|var)\\s+${n}\\s*=(?!\\s*\\(\\.\\.\\.a\\)\\s*=>\\s*app\\.))`);
    if (def.test(s)) owner.set(name, f);
  }
}
// names app.js takes out of a module's factory (`const { a, b } = PANES_MOD;`) belong to that module
const MODS = {};
for (const m of appSrc.matchAll(new RegExp(`const\\s+(${ID})\\s*=\\s*(create${ID})\\(`, 'g'))) {
  const file = files.find((f) => new RegExp(`export\\s+function\\s+${m[2]}\\b`).test(src[f]));
  if (file) MODS[m[1]] = file;
}
for (const m of appSrc.matchAll(new RegExp(`const\\s*\\{([^}]*)\\}\\s*=\\s*(${ID})\\s*(\\(\\))?\\s*;`, 'g'))) {
  // `const {a, b} = PANES_MOD;` or straight from the factory, `const {a, b} = createGeneration();`
  const file = m[3] ? files.find((f) => new RegExp(`export\\s+function\\s+${m[2]}\\b`).test(src[f])) : MODS[m[2]];
  if (!file) continue;
  for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) if (registered.has(n)) owner.set(n, file);
}

// ---- redraw keys (web/js/redraw.js) ----
const redrawKeys = { used: new Map(), handled: new Map() };
for (const f of files) {
  const s = strip(src[f]);
  for (const m of s.matchAll(/\binvalidate\(\s*'([\w-]+)'/g)) redrawKeys.used.set(m[1], [...(redrawKeys.used.get(m[1]) || []), f]);
  for (const m of s.matchAll(/\bonRedraw\(\s*'([\w-]+)'/g)) redrawKeys.handled.set(m[1], [...(redrawKeys.handled.get(m[1]) || []), f]);
}

test('the registry block in web/js/app.js was found', () => {
  assert.ok(block, 'could not find `Object.assign(app, {...});` in web/js/app.js');
  assert.ok(registered.size > 50, `only ${registered.size} names parsed from the registry block`);
});

test('every app.X a module uses is registered', () => {
  const missing = [];
  for (const f of files) for (const [n] of uses[f]) if (!registered.has(n)) missing.push(`${f}: app.${n}`);
  assert.deepEqual(missing, [], `used but never registered in Object.assign(app, {...}) in web/js/app.js:\n${missing.join('\n')}`);
});

test("every invalidate('key') has a redraw registered with onRedraw('key', fn), exactly once", () => {
  const bad = [];
  for (const [k, where] of redrawKeys.used) if (!redrawKeys.handled.has(k)) bad.push(`invalidate('${k}') in ${[...new Set(where)].join(', ')} has no onRedraw('${k}', …)`);
  for (const [k, where] of redrawKeys.handled) if (where.length > 1) bad.push(`onRedraw('${k}', …) is registered ${where.length} times (${where.join(', ')})`);
  assert.deepEqual(bad, [], bad.join('\n'));
});

const unused = [...registered].filter((n) => !files.some((f) => uses[f].has(n))).sort();
const edges = new Map();   // "user -> owner" -> Set(names)
for (const f of files) for (const [n] of uses[f]) {
  const o = owner.get(n) || '?';
  if (o === f) continue;
  const k = `${f} -> ${o}`; if (!edges.has(k)) edges.set(k, new Set()); edges.get(k).add(n);
}
const total = [...edges.values()].reduce((a, s) => a + s.size, 0);
const stubs = files.reduce((a, f) => a + (strip(src[f]).match(/=\s*\(\.\.\.a\)\s*=>\s*app\.[\w$]+\(\.\.\.a\)/g) || []).length, 0);
console.log(`      ${registered.size} names registered, ${unused.length} never used through app; ${total} module-to-module name links; ${stubs} delegate stubs; ${redrawKeys.handled.size} redraw keys`);

if (process.argv.includes('--map')) {
  console.log('\n## Who calls whom through `app` (user -> owner: distinct names)\n');
  const rows = [...edges.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [k, s] of rows) console.log(`${String(s.size).padStart(3)}  ${k.padEnd(32)} ${[...s].sort().join(', ')}`);
  const into = {}, out = {};
  for (const [k, s] of edges) { const [u, o] = k.split(' -> '); out[u] = (out[u] || 0) + s.size; into[o] = (into[o] || 0) + s.size; }
  console.log('\n## Per module: names it uses from others / names of its that others use\n');
  for (const f of files) if (out[f] || into[f]) console.log(`${f.padEnd(16)} uses ${String(out[f] || 0).padStart(3)}   used ${String(into[f] || 0).padStart(3)}`);
  console.log(`\n## Registered but never used through app (${unused.length})\n\n${unused.join(', ')}`);
  const orphans = [...registered].filter((n) => !owner.has(n)).sort();
  if (orphans.length) console.log(`\n## Registered names with no definition found (${orphans.length})\n\n${orphans.join(', ')}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
