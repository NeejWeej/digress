// Direct Node unit tests for web/js/context.js against the real web/prompts.js and web/threads.js.
// Focuses on high-value invariants: prompt-cache prefix stability, over-budget doc handling
// (tools vs. page-picking), CLIP branch isolation, takeaways/images merging, and system/skill precedence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  DOC_FIRST, DOC_TOOL_NAMES,
  fullSysOf, buildContext, joinParts, appendText,
} from '../web/js/context.js';

// Load real web/prompts.js and web/threads.js (classic browser globals) into a sandboxed VM.
const sandbox = { window: {} };
sandbox.globalThis = sandbox;
const PROMPTS = vm.runInNewContext(fs.readFileSync(new URL('../web/prompts.js', import.meta.url), 'utf8') + '\n;PROMPTS;', sandbox);
const ThreadOps = vm.runInNewContext(fs.readFileSync(new URL('../web/threads.js', import.meta.url), 'utf8') + '\n;ThreadOps;', sandbox);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok  ', name);
}

function makeEnv(overrides = {}) {
  return {
    conv: {
      id: 'c1',
      title: 'Test conv',
      threads: { main: { id: 'main', parent: null, title: 'Main' } },
      order: { main: [] },
      msgs: {},
    },
    docState: null,
    docView: { current: 1 },
    custom: { prompts: {}, skills: new Map() },
    prompts: PROMPTS,
    threadOps: ThreadOps,
    settings: { web: false },
    io: { llm: { supportsTools: true, supportsWeb: true } },
    ...overrides,
  };
}

test('prompt-cache prefix stability: system prompt is identical across main, reply branch, doc branch, and CLIP branch', () => {
  const pages = ['Page 1 intro about transformers.', 'Page 2 details about scaling.', 'Page 3 experiments.'];
  const env = makeEnv({
    conv: {
      id: 'c1',
      title: 'Paper',
      doc: { name: 'paper.pdf', kind: 'pdf' },
      cards: { on: true },
      threads: {
        main: { id: 'main', parent: null, title: 'Main' },
        bReply: { id: 'bReply', parent: 'main', anchorMsg: 'm2', anchorText: 'dot product', title: 'Dot product' },
        bDoc: { id: 'bDoc', parent: 'main', anchorMsg: 'DOC', anchorPage: 1, anchorText: 'scaling', title: 'Scaling' },
        bClip: { id: 'bClip', parent: 'main', anchorMsg: 'CLIP', anchorText: 'Clipped tweet text', anchorTitle: 'X post', anchorUrl: 'https://x.com/u/status/1', title: 'X post' },
      },
      order: {
        main: ['m1', 'm2'],
        bReply: ['m3'],
        bDoc: ['m4'],
        bClip: ['m5'],
      },
      msgs: {
        m1: { id: 'm1', thread: 'main', role: 'user', content: 'Summarize this paper.' },
        m2: { id: 'm2', thread: 'main', role: 'assistant', content: 'It uses scaled dot product attention.' },
        m3: { id: 'm3', thread: 'bReply', role: 'user', content: 'Why dot product?' },
        m4: { id: 'm4', thread: 'bDoc', role: 'user', content: 'Explain scaling on page 2.' },
        m5: { id: 'm5', thread: 'bClip', role: 'user', content: 'What do you think of this tweet?' },
      },
    },
    docState: { loaded: true, kind: 'pdf', name: 'paper.pdf', pages },
  });

  const cMain = buildContext(env, 'main');
  const cReply = buildContext(env, 'bReply');
  const cDoc = buildContext(env, 'bDoc');
  const cClip = buildContext(env, 'bClip');

  assert.equal(cMain.system, cReply.system);
  assert.equal(cMain.system, cDoc.system);
  assert.equal(cMain.system, cClip.system);
  assert.deepEqual(cMain.docSeen, { of: 3, all: true, tools: true });
  assert.deepEqual(cMain.tools, [...DOC_TOOL_NAMES, 'suggest_card']);
});

test('prompt-cache stability: toggling Web only affects excludeMid, never earlier turns', () => {
  const env = makeEnv({
    conv: {
      id: 'c1',
      title: 'Web cache',
      threads: { main: { id: 'main', parent: null, title: 'Main' } },
      order: { main: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'] },
      msgs: {
        u1: { id: 'u1', thread: 'main', role: 'user', content: 'First question', lookAt: 2 },
        a1: { id: 'a1', thread: 'main', role: 'assistant', content: 'First answer', web: true },
        u2: { id: 'u2', thread: 'main', role: 'user', content: 'Second question' },
        a2: { id: 'a2', thread: 'main', role: 'assistant', content: 'Second answer', web: false },
        u3: { id: 'u3', thread: 'main', role: 'user', content: 'Third question' },
        a3: { id: 'a3', thread: 'main', role: 'assistant', content: '', pending: true },
      },
    },
    docView: { current: 9 },   // must NOT affect u1's saved lookAt: 2
  });

  env.settings.web = false;
  const off = buildContext(env, 'main', 'a3');
  env.settings.web = true;
  const on = buildContext(env, 'main', 'a3');

  // Earlier turns are byte-for-byte identical regardless of current settings.web or docView.current
  assert.deepEqual(off.messages.slice(0, 4), on.messages.slice(0, 4));
  assert.ok(off.messages[0].content.includes(PROMPTS.webOn), 'u1 keeps webOn from saved a1.web=true');
  assert.ok(off.messages[0].content.includes(PROMPTS.lookingAt(2)), 'u1 keeps saved lookAt=2');
  assert.ok(!off.messages[2].content.includes(PROMPTS.webOn), 'u2 stays without webOn from saved a2.web=false');
  assert.ok(!off.messages[4].content.includes(PROMPTS.webOn), 'u3 has no webOn when settings.web=false');
  assert.ok(on.messages[4].content.includes(PROMPTS.webOn), 'u3 gets webOn when settings.web=true');
});

test('over-budget document with tools: system stays fixed (TOC + first pages) and branch gets aroundParts in its first message', () => {
  const pages = Array.from({ length: 10 }, (_, i) => `Page ${i + 1}: ` + 'x'.repeat(200));
  const outline = [{ depth: 0, title: 'Intro', page: 1 }, { depth: 0, title: 'Method', page: 7 }];
  const env = makeEnv({
    budget: 500,   // force over-budget without allocating 200KB
    conv: {
      id: 'c1',
      title: 'Big PDF',
      doc: { name: 'big.pdf', kind: 'pdf' },
      threads: {
        main: { id: 'main', parent: null, title: 'Main' },
        b7: { id: 'b7', parent: 'main', anchorMsg: 'DOC', anchorPage: 6, anchorText: 'key passage', title: 'Page 7' },
      },
      order: { main: ['m1'], b7: ['m2'] },
      msgs: {
        m1: { id: 'm1', thread: 'main', role: 'user', content: 'Overview?' },
        m2: { id: 'm2', thread: 'b7', role: 'user', content: 'Explain this part.' },
      },
    },
    docState: { loaded: true, kind: 'pdf', name: 'big.pdf', pages, outline },
  });

  const cMain = buildContext(env, 'main');
  const cBranch = buildContext(env, 'b7');

  assert.equal(cMain.system, cBranch.system, 'system prompt must stay identical across threads');
  assert.ok(cMain.system.includes('<contents>\nIntro … p. 1\nMethod … p. 7\n</contents>'));
  assert.ok(cMain.system.includes(`[p. ${DOC_FIRST}]`));
  assert.ok(!cMain.system.includes('[p. 7]'), 'page 7 must not be in system prompt');
  assert.ok(cMain.system.includes('pp. 4–10'));
  assert.deepEqual(cMain.docSeen, { of: 10, tools: true, pages: `the contents and pp. 1–${DOC_FIRST}` });

  // Branch at page 7 (0-indexed 6) gets pages 6, 7, 8 in its own first user message
  assert.ok(cBranch.messages[0].content.includes('[p. 6]'));
  assert.ok(cBranch.messages[0].content.includes('[p. 7]'));
  assert.ok(cBranch.messages[0].content.includes('[p. 8]'));
  assert.ok(!cBranch.messages[0].content.includes('[p. 5]'));
});

test('over-budget document without tools: page-picking respects budget, includes anchor/keyword pages, and marks every gap', () => {
  const pages = Array.from({ length: 8 }, (_, i) => `Page ${i + 1} ${i === 5 ? 'eigenvalue spectral' : 'filler'} ` + 'a'.repeat(120));
  const env = makeEnv({
    budget: 500,   // fits ~3 pages of ~140 chars each
    io: { llm: { supportsTools: false, supportsWeb: false } },
    conv: {
      id: 'c1',
      title: 'No tools',
      doc: { name: 'book.pdf', kind: 'pdf' },
      threads: { main: { id: 'main', parent: null, title: 'Main' } },
      order: { main: ['m1'] },
      msgs: { m1: { id: 'm1', thread: 'main', role: 'user', content: 'Explain eigenvalue spectral theory' } },
    },
    docState: { loaded: true, kind: 'pdf', name: 'book.pdf', pages },
  });

  const ctx = buildContext(env, 'main');
  assert.equal(ctx.tools, false);
  assert.ok(ctx.system.includes('[p. 1]'), 'always includes p. 1');
  assert.ok(ctx.system.includes('[p. 2]'), 'always includes p. 2');
  assert.ok(ctx.system.includes('[p. 6]'), 'picks keyword-matching p. 6');
  assert.ok(ctx.system.includes('[pp. 3–5 not included]'), 'marks gap before p. 6');
  assert.ok(ctx.system.includes('[pp. 7–8 not included]'), 'marks trailing gap');
  assert.equal(ctx.docSeen.n, 3);
  assert.equal(ctx.docSeen.of, 8);
});

test('CLIP branch isolation: excludes main history and preserves clipped metadata + images', () => {
  const imgRef = { asset: 'abc123', type: 'image/png' };
  const env = makeEnv({
    conv: {
      id: 'c1',
      title: 'Clippings',
      threads: {
        main: { id: 'main', parent: null, title: 'Main' },
        clip1: {
          id: 'clip1', parent: 'main', anchorMsg: 'CLIP',
          anchorText: 'A sharp claim about caching.',
          anchorTitle: 'Alice on X',
          anchorUrl: 'https://x.com/alice/status/42',
          anchorImages: [imgRef],
          title: 'Alice on X',
        },
      },
      order: { main: ['m1', 'm2'], clip1: ['c1q'] },
      msgs: {
        m1: { id: 'm1', thread: 'main', role: 'user', content: 'Unrelated main topic SECRET_MAIN' },
        m2: { id: 'm2', thread: 'main', role: 'assistant', content: 'Unrelated main reply' },
        c1q: { id: 'c1q', thread: 'clip1', role: 'user', content: 'Is this true?' },
      },
    },
  });

  const ctx = buildContext(env, 'clip1');
  assert.equal(ctx.messages.length, 1);
  assert.ok(Array.isArray(ctx.messages[0].content), 'clipped image makes message multipart');
  const allText = ctx.messages[0].content.filter(p => p.type === 'text').map(p => p.text).join('');
  const expectedPrefix = PROMPTS.branch.clip('> A sharp claim about caching.', 'Alice on X', 'https://x.com/alice/status/42', true);
  assert.ok(!allText.includes('SECRET_MAIN'), 'main history must not leak into CLIP branch');
  assert.ok(allText.startsWith(expectedPrefix), 'CLIP prefix includes title, URL, and quoted passage');
  assert.ok(allText.includes('Is this true?'));
  assert.deepEqual(ctx.messages[0].content.find(p => p.type === 'image').ref, imgRef);
});

test('takeaways, pending replies, and images merge cleanly without dropping parts', () => {
  const env = makeEnv({
    conv: {
      id: 'c1',
      title: 'Notes',
      threads: {
        main: { id: 'main', parent: null, title: 'Main' },
        b1: { id: 'b1', parent: 'main', anchorMsg: 'a1', title: 'Side topic' },
      },
      order: { main: ['u1', 'a1', 'n1', 'u2', 'a2'] },
      msgs: {
        u1: { id: 'u1', thread: 'main', role: 'user', content: 'Start' },
        a1: { id: 'a1', thread: 'main', role: 'assistant', content: 'Reply' },
        n1: { id: 'n1', thread: 'main', role: 'note', fromThread: 'b1', content: 'Key takeaway.' },
        u2: { id: 'u2', thread: 'main', role: 'user', content: 'Follow-up', images: [{ asset: 'img1', type: 'image/png' }] },
        a2: { id: 'a2', thread: 'main', role: 'assistant', content: '', pending: true },
      },
    },
  });

  const ctx = buildContext(env, 'main');
  assert.equal(ctx.messages.length, 3);   // u1, a1, merged(n1 + u2); pending a2 skipped
  assert.equal(ctx.messages[2].role, 'user');
  assert.ok(Array.isArray(ctx.messages[2].content));
  const texts = ctx.messages[2].content.filter(p => p.type === 'text').map(p => p.text).join('');
  assert.ok(texts.includes('Side topic') && texts.includes('Key takeaway.') && texts.includes('Follow-up'));
  assert.equal(ctx.messages[2].content.filter(p => p.type === 'image').length, 1);

  appendText(ctx.messages[2], '\nExtra');
  assert.equal(ctx.messages[2].content.at(-1).text, '\nExtra');
  assert.equal(joinParts([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
});

test('system prompt & skills precedence: conv.system > custom > default, howDigress always present, deleted skills ignored', () => {
  const skills = new Map([['sk1', { id: 'sk1', name: 'Socratic', description: 'Ask questions', body: 'Guide with questions.' }]]);
  const custom = { prompts: { system: 'Custom default tutor.' }, skills };

  const cDefault = { skills: ['sk1', 'deleted_id'] };
  const s1 = fullSysOf(cDefault, custom, PROMPTS);
  assert.ok(s1.startsWith('Custom default tutor.'));
  assert.ok(s1.includes(PROMPTS.howDigress), 'howDigress is always included');
  assert.ok(s1.includes('Socratic') && s1.includes('Guide with questions.'));
  assert.ok(!s1.includes('deleted_id'));

  const cOwn = { system: 'Conversation-specific tutor.', skills: [] };
  const s2 = fullSysOf(cOwn, custom, PROMPTS);
  assert.ok(s2.startsWith('Conversation-specific tutor.'));
  assert.ok(!s2.includes('Custom default tutor.'));
  assert.ok(s2.includes(PROMPTS.howDigress));
});

console.log(`\nall passed (${passed} tests)`);
