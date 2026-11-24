#!/usr/bin/env node
// Compare two versions of Digress's prompts on a fixed set of questions (evals/cases.mjs), against a REAL model.
// It costs real usage, so it is never run by tests/run_all.py or CI: only by hand.
//
//   node evals/prompt_eval.mjs --model gpt-6.2-astra            # HEAD's prompts vs the working copy's
//   node evals/prompt_eval.mjs --model X --before main --only quick-fact,unseen-branch
//   options: --base http://localhost:8788 (a running Digress server)  --before <git ref> (default HEAD)  --jobs 3
//
// Each case is sent as the page would send it with that version's web/prompts.js: the system prompt (system, plus
// howDigress where the version has it), a short document whole with [p. N] labels when the case has one, and the
// messages with that version's branch markers. No tools, no web. Writes evals/out/<time>-<model>.md side by side
// (and .json) for a person to read; nothing is scored.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './cases.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = arg('model'), BASE = arg('base', 'http://localhost:8788'), BEFORE = arg('before', 'HEAD');
const JOBS = Math.max(1, +arg('jobs', 3)), ONLY = arg('only') ? arg('only').split(',') : null;
if (!MODEL) { console.error('Give a model: --model <id> (see GET /api/models)'); process.exit(2); }

const load = (src) => new Function(src + '\nreturn PROMPTS;')();
const VERSIONS = {
  before: load(execFileSync('git', ['show', `${BEFORE}:web/prompts.js`], { cwd: ROOT, encoding: 'utf8' })),
  after: load(readFileSync(join(ROOT, 'web/prompts.js'), 'utf8')),
};

function systemFor(P, c) {
  let s = P.system + (P.howDigress ? '\n\n' + P.howDigress : '');
  if (c.doc) {
    const D = P.doc, n = c.doc.pages.length;
    s += '\n\n' + D.head(c.doc.name, n, 'pages') + (D.whole || '') + ' ' + D.cite(true) +
      '\n<document>\n' + c.doc.pages.map((t, i) => `[p. ${i + 1}]\n${t}`).join('\n\n') + '\n</document>';
  }
  return s;
}

async function ask(system, messages) {
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat: randomBytes(16).toString('hex'), system, messages, model: MODEL, web: false }) });
  if (!r.ok) return { error: `${r.status} ${(await r.text()).slice(0, 300)}` };
  let text = '', buf = '', end = null;
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      const o = JSON.parse(line);
      if (o.d) text += o.d; else if (o.done || o.error || o.stopped) end = o;
    }
  }
  return end && end.error ? { error: end.error, text } : { text, model: end && end.model, usage: end && end.usage };
}

const cases = CASES.filter((c) => !ONLY || ONLY.includes(c.id));
const jobs = cases.flatMap((c) => Object.entries(VERSIONS).map(([v, P]) => ({ c, v, P })));
console.log(`${jobs.length} requests to ${MODEL} via ${BASE} (real usage): ${cases.length} cases × before (${BEFORE}) / after (working copy)`);
const out = {};
let next = 0, done = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (next < jobs.length) {
    const { c, v, P } = jobs[next++];
    const t0 = Date.now(), res = await ask(systemFor(P, c), c.messages(P));
    (out[c.id] ||= {})[v] = { ...res, ms: Date.now() - t0 };
    console.log(`  ${++done}/${jobs.length} ${c.id} ${v}${res.error ? ' ERROR ' + res.error : ` ${res.text.length} chars`}`);
  }
}));

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = join(ROOT, 'evals/out'); mkdirSync(dir, { recursive: true });
const base = join(dir, `${stamp}-${MODEL}`);
const quote = (s) => (s || '').split('\n').map((l) => '> ' + l).join('\n');
let md = `# Prompt eval: ${MODEL}\n\nBefore: \`${BEFORE}\`'s web/prompts.js. After: the working copy. ${new Date().toISOString()}\n`;
for (const c of cases) {
  const r = out[c.id] || {};
  md += `\n---\n\n## ${c.id}\n\n**Look for:** ${c.look}\n`;
  for (const v of ['before', 'after']) {
    const x = r[v] || {};
    md += `\n### ${v} (${x.error ? 'error' : `${(x.text || '').length} chars, ${((x.ms || 0) / 1000).toFixed(1)} s`})\n\n${x.error ? 'Error: ' + x.error : quote(x.text)}\n`;
  }
}
writeFileSync(base + '.md', md);
writeFileSync(base + '.json', JSON.stringify({ model: MODEL, before: BEFORE, cases: out }, null, 2));
console.log('\nWrote ' + base + '.md');
