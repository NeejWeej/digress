// Docs-drift checks: settings, defaults, test file names and API routes mentioned in the docs must match the code.
// Text only (no browser, no server); invoked by tests/test_docs_drift.py.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(ext)).sort().map((f) => `${dir}/${f}`);

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok  ', name);
  } catch (e) {
    failed++;
    console.log('FAIL', name);
    console.log('      ' + String(e.message).split('\n')[0]);
  }
}

// Settings the server reads that are deliberately not in the settings table of docs/setup.md.
const UNDOCUMENTED = {
  DEV: "npm run dev's live reload; documented in docs/development.md",
  DOC_FETCH_TEST_ALLOW: 'lets tests fetch from a local fake; not for users',
  CHATGPT_API_BASE: 'points the ChatGPT provider at a test fake',
  CHATGPT_AUTH_BASE: 'points the ChatGPT sign-in at a test fake',
  GEMINI_WAIT_MS: 'timing knob the tests shorten',
  GEMINI_RETRY_MS: 'timing knob the tests shorten',
  RUN_KEEP_MS: 'timing knob the tests shorten',
  RUN_HEARTBEAT_MS: 'timing knob the tests shorten',
  RUN_SAVE_GRACE_MS: 'timing knob the tests shorten',
  GOOGLE_API_KEY: 'alias of GEMINI_API_KEY, mentioned in that row',
};
// Rows in the settings table that the server does not read itself.
const READ_ELSEWHERE = {
  CLAUDE_CODE_OAUTH_TOKEN: 'read by the Claude Code CLI the server spawns, not by our code',
};

const serverFiles = list('server', '.mjs');
const serverSrc = Object.fromEntries(serverFiles.map((f) => [f, read(f)]));
const setupMd = read('docs/setup.md');

// ---- settings table ----
function settingsTable() {
  const i = setupMd.indexOf('## All settings');
  assert.ok(i >= 0, 'docs/setup.md has no "## All settings" section');
  const rows = {};
  for (const line of setupMd.slice(i).split('\n').slice(1)) {
    if (/^## /.test(line)) break;
    const m = line.match(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|(.*)$/);
    if (!m) continue;
    const cells = m[2].split(/(?<!\\)\|/).map((c) => c.trim());
    rows[m[1]] = cells[0] || '';
  }
  return rows;
}
const table = settingsTable();
const envRead = {}; // NAME -> [files]
for (const [f, src] of Object.entries(serverSrc)) {
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) (envRead[m[1]] ||= new Set()).add(f);
}

test('settings: every variable the server reads is in the settings table or UNDOCUMENTED', () => {
  const missing = Object.keys(envRead).filter((n) => !(n in table) && !(n in UNDOCUMENTED));
  assert.deepEqual(missing, [], `read in ${missing.map((n) => `${n} (${[...envRead[n]].join(', ')})`).join('; ')} but has no row in the "All settings" table of docs/setup.md (add a row, or an UNDOCUMENTED entry with a reason)`);
  for (const n of Object.keys(UNDOCUMENTED)) assert.ok(!(n in table), `${n} is in UNDOCUMENTED but docs/setup.md documents it: remove it from UNDOCUMENTED`);
  console.log(`      ${Object.keys(envRead).length} variables read: ${Object.keys(table).filter((n) => n in envRead).length} documented, ${Object.keys(UNDOCUMENTED).length} listed as undocumented`);
});

test('settings: the exception lists have not gone stale', () => {
  for (const n of Object.keys(UNDOCUMENTED)) assert.ok(n in envRead, `UNDOCUMENTED lists ${n} but nothing in server/ reads it any more`);
  for (const n of Object.keys(READ_ELSEWHERE)) assert.ok(n in table, `READ_ELSEWHERE lists ${n} but docs/setup.md has no row for it`);
  for (const n of Object.keys(READ_ELSEWHERE)) assert.ok(!(n in envRead), `READ_ELSEWHERE lists ${n} but the server now reads it: move it out`);
  console.log(`      ${Object.keys(UNDOCUMENTED).length + Object.keys(READ_ELSEWHERE).length} exceptions still valid`);
});

test('settings: every row in the settings table names a variable the server still reads', () => {
  const stale = Object.keys(table).filter((n) => !(n in envRead) && !(n in READ_ELSEWHERE));
  assert.deepEqual(stale, [], `docs/setup.md documents ${stale.join(', ')} but nothing in server/*.mjs reads process.env.<it>`);
  console.log(`      ${Object.keys(table).length} rows`);
});

// ---- defaults ----
function evalNumber(expr) {
  const e = expr.replace(/_/g, '').trim();
  if (!/^[0-9 *]+$/.test(e)) return null;
  return e.split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1);
}
// the literal the code falls back to: Number(process.env.X || 50), process.env.X || 'str', process.env.X ?? 'str'
function codeDefaults(name) {
  const out = [];
  for (const [f, src] of Object.entries(serverSrc)) {
    const re = new RegExp(`(Number\\(\\s*)?process\\.env\\.${name}\\s*(?:\\|\\||\\?\\?)\\s*(?:'([^']*)'|"([^"]*)"|([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*))\\s*(?=[),;*])`, 'g');
    for (const m of src.matchAll(re)) {
      if (m[1] && m[4] !== undefined) out.push({ f, value: evalNumber(m[4]) });
      else if (!m[1] && m[4] === undefined && (m[2] || m[3])) out.push({ f, value: m[2] ?? m[3] });
    }
  }
  return out;
}
test('defaults: documented defaults match the literals in the code', () => {
  const checked = [], skipped = [];
  for (const [name, cell] of Object.entries(table)) {
    const found = codeDefaults(name).filter((d) => d.value !== null);
    if (!found.length) { skipped.push(name); continue; }
    const doc = cell.replace(/`/g, '');
    for (const { f, value } of found) {
      if (typeof value === 'number') {
        const n = Number((doc.match(/\d[\d_,]*/) || [''])[0].replace(/[_,]/g, ''));
        assert.equal(n, value, `${name}: docs/setup.md says default "${cell}" but ${f} defaults to ${value}`);
      } else {
        assert.equal(doc, value, `${name}: docs/setup.md says default "${cell}" but ${f} defaults to '${value}'`);
      }
    }
    checked.push(name);
  }
  assert.ok(checked.length >= 5, 'default parsing found too few settings; the extraction is broken');
  console.log(`      checked ${checked.length}: ${checked.join(', ')}`);
  console.log(`      skipped (not a simple literal, or no default): ${skipped.join(', ')}`);
});

// ---- test names mentioned in docs ----
test('test names: every tests/ file mentioned in the notes and docs exists', () => {
  const docs = ['AGENTS.md', ...list('agents', '.md'), ...list('docs', '.md')];
  let n = 0;
  for (const f of docs) {
    const text = read(f);
    const found = new Set();
    for (const m of text.matchAll(/(?<![\w./-])tests\/([\w./-]*[\w-]\.(?:py|mjs|js))(?![\w])/g)) found.add(m[1]);
    for (const m of text.matchAll(/(?<![\w/.-])(test_[\w-]+\.py)(?![\w])/g)) found.add(m[1]);
    for (const rel of found) {
      if (rel.startsWith('webkit/') || rel.startsWith('.artifacts')) continue;
      n++;
      assert.ok(fs.existsSync(path.join(ROOT, 'tests', rel)), `${f} mentions tests/${rel}, which does not exist`);
    }
  }
  console.log(`      ${n} mentions in ${docs.length} files`);
});

// ---- routes ----
test('routes: every API route is in the header comment of server.mjs and in agents/*.md', () => {
  const src = serverSrc['server/server.mjs'];
  const body = src.slice(src.indexOf('async function route('));
  const routes = new Set();
  for (const m of body.matchAll(/parts\[1\] === '([\w-]+)'/g)) routes.add(`/api/${m[1]}`);
  for (const m of body.matchAll(/parts\[1\] === 'chat'\s*&&\s*parts\[2\] === '([\w-]+)'/g)) routes.add(`/api/chat/${m[1]}`);
  assert.ok(routes.size >= 10, `route extraction found only ${routes.size} routes`);
  const header = src.slice(0, src.indexOf('\nimport '));
  const agentsText = list('agents', '.md').map((f) => read(f)).join('\n');
  const has = (text, r) => new RegExp(`${r.replace(/[/]/g, '\\/')}(?![\\w-])`).test(text);
  for (const r of [...routes].sort()) {
    assert.ok(has(header, r), `${r} is handled by route() but is missing from the comment block at the top of server/server.mjs`);
    assert.ok(has(agentsText, r), `${r} is handled by route() but is not mentioned in any agents/*.md`);
  }
  console.log(`      ${routes.size} routes: ${[...routes].sort().join(' ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
