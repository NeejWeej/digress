#!/usr/bin/env node
// Stands in for the Claude Code CLI in tests: prints the same stream-json lines `claude -p` does.
// It echoes what it received, so tests can check the server passed things through correctly.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { scriptFor, INTRO, answer } from './doc-script.mjs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (Claude Code fake)'); process.exit(0); }
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const log = (s) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, s + '\n');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', async () => {
  // with --input-format stream-json the conversation is one user message of content blocks (like the real CLI):
  // `prompt` is its text, `blocks` lists every block in order (images as their type and the sha256 of their bytes)
  let blocks = null;
  if (arg('--input-format') === 'stream-json') {
    const msg = JSON.parse(prompt.trim().split('\n')[0]);
    if (msg.type !== 'user' || msg.message.role !== 'user') { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'bad stream-json input' }) + '\n'); process.exit(1); }
    blocks = msg.message.content.map((b) => b.type === 'text' ? { text: b.text } : { image: b.source.media_type, sha256: crypto.createHash('sha256').update(Buffer.from(b.source.data, 'base64')).digest('hex') });
    prompt = blocks.filter((b) => 'text' in b).map((b) => b.text).join('');
  }
  const system = fs.readFileSync(arg('--system-prompt-file'), 'utf8');
  const model = arg('--model'), effort = arg('--effort') || 'none';
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  // token counts like the real CLI's: each request's usage on message_start / message_delta, and the model's
  // context window in the result's modelUsage. Input: about a token per 4 characters of system + conversation.
  const ctx = Math.ceil((system.length + prompt.length) / 4);
  const usage = () => ({ input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx, output_tokens: 1 });
  const modelUsage = { [model]: { inputTokens: 3, outputTokens: 7, cacheReadInputTokens: ctx, contextWindow: 1000000 } };
  // isolated from the user's own Claude Code setup: --safe-mode, or (with our MCP server, which --safe-mode would turn
  // off) the same piece by piece: no settings files, hooks off, only our MCP server, no slash commands, no CLAUDE.md or memory
  const safe = ['--strict-mcp-config', '--safe-mode', '--disable-slash-commands'].every((f) => args.includes(f));
  const pieces = !args.includes('--safe-mode') && ['--strict-mcp-config', '--disable-slash-commands', '--mcp-config'].every((f) => args.includes(f)) && arg('--setting-sources') === ''
    && /"disableAllHooks":true/.test(arg('--settings') || '') && process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === '1' && process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1';
  log(JSON.stringify({ model, effort, tools: arg('--tools'), allowed: arg('--allowedTools') || null, mcp: arg('--mcp-config') || null, isolated: safe || pieces, isolatedHow: safe ? 'safe-mode' : pieces ? 'pieces' : 'NO', apiKeyVisible: !!process.env.ANTHROPIC_API_KEY, otherKeysVisible: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY), systemChars: system.length, system, prompt, blocks }));
  process.on('SIGTERM', () => { log('KILLED'); process.exit(143); });
  if (prompt.includes('UNICODE')) {
    // a reply full of multi-byte characters, written a few bytes at a time so characters split between chunks
    const text = '∑ 日本語 é 🙂 '.repeat(60);
    const bytes = Buffer.from([{ type: 'stream_event', event: { type: 'message_start', message: { model, usage: usage() } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } } },
      { type: 'result', subtype: 'success', is_error: false, modelUsage, result: text }].map((o) => JSON.stringify(o) + '\n').join(''));
    for (let i = 0; i < bytes.length; i += 5) { process.stdout.write(bytes.subarray(i, i + 5)); await new Promise((r) => setTimeout(r, 1)); }
    return;
  }
  const ROUNDS = scriptFor(prompt);
  if (ROUNDS && arg('--mcp-config')) {
    // the real CLI connects to the MCP server, lists its tools and calls them while the model works
    const url = JSON.parse(arg('--mcp-config')).mcpServers.digress.url, allowed = (arg('--allowedTools') || '').split(',');
    let rid = 0;
    const rpc = async (method, params, notify) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rid, method, params }) });
      if (notify) return r.status;
      const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
    };
    const ev = (event) => emit({ type: 'stream_event', event });
    try {
      await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
      await rpc('notifications/initialized', {}, true);
      const listed = (await rpc('tools/list', {})).tools.map((t) => t.name);
      log(JSON.stringify({ mcpTools: listed }));
      ev({ type: 'message_start', message: { model, usage: usage() } });
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: INTRO } });
      const results = [];
      for (const [r, round] of ROUNDS.entries()) {
        if (r > 0) ev({ type: 'message_start', message: { model, usage: usage() } });
        round.forEach(([name, input], k) => {
          ev({ type: 'content_block_start', index: k + 1, content_block: { type: 'tool_use', id: `tu${r}${k}`, name: 'mcp__digress__' + name, input: {} } });
          ev({ type: 'content_block_delta', index: k + 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
          ev({ type: 'content_block_stop', index: k + 1 });
        });
        ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
        const got = await Promise.all(round.map(([name, input]) => allowed.includes('mcp__digress__' + name)
          ? rpc('tools/call', { name, arguments: input }) : { isError: true, content: [{ type: 'text', text: 'permission denied: not in --allowedTools' }] }));
        got.forEach((g, k) => results.push({ name: round[k][0], error: !!g.isError, parts: g.content.map((c) => (c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image', mediaType: c.mimeType, data: c.data })) }));
        emit({ type: 'user', message: { content: got.map((g, k) => ({ type: 'tool_result', tool_use_id: `tu${r}${k}`, content: g.content })) } });
      }
      const text = answer(results);
      ev({ type: 'message_start', message: { model, usage: usage() } });
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
      emit({ type: 'result', subtype: 'success', is_error: false, modelUsage, result: text });
    } catch (e) {
      emit({ type: 'result', subtype: 'error', is_error: true, result: 'MCP failed: ' + e.message });
      process.exit(1);
    }
    return;
  }
  if (prompt.includes('FAILAUTH')) {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' });
    process.exit(1);
  }
  if (prompt.includes('SEARCHME') && arg('--tools') === 'WebSearch' && (arg('--allowedTools') || '').split(',').includes('WebSearch')) {   // listed and allowed (listed only, the real CLI refuses the call)
    // what the real CLI prints for one WebSearch call: the tool call streams, then its result comes back as a user message
    const ev = (event) => emit({ type: 'stream_event', event });
    ev({ type: 'message_start', message: { model, usage: usage() } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look.' } });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'WebSearch', input: {} } });
    for (const j of ['{"query": "fake ', 'search query"}']) ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: j } });
    ev({ type: 'content_block_stop', index: 1 });
    emit({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'fake search query' } }] } });
    const links = [{ title: 'Example source', url: 'https://example.com/a' }, { title: 'Bad', url: 'javascript:alert(1)' }];
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `Web search results for query: "fake search query"\n\nLinks: ${JSON.stringify(links)}\n\nSummary...` }] } });
    ev({ type: 'message_start', message: { model, usage: usage() } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it: [Example](https://example.com/a).' } });
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
    emit({ type: 'result', subtype: 'success', is_error: false, modelUsage, result: 'Found it.' });
    return;
  }
  const reply = `Fake reply. model=${model} effort=${effort} system=${system.length} turns=${(prompt.match(/<user>/g) || []).length + 1}\n\nThe gradient of $x^2$ is $2x$.`;
  emit({ type: 'system', subtype: 'init', model });
  emit({ type: 'stream_event', event: { type: 'message_start', message: { model, usage: usage() } } });
  // SLOW in the latest question: 200 ticks, 100 ms apart (SLOWISH: 30). HOLD: a tick every 100 ms until the file
  // FAKE_LOG + '.release' exists, then 'done.' (for tests that need a reply still running however slow the machine is)
  const latest = prompt.slice(prompt.lastIndexOf('</user>') + 1), hold = latest.includes('HOLD'), slow = hold || latest.includes('SLOW');
  const parts = hold ? [] : slow ? Array(latest.includes('SLOWISH') ? 30 : 200).fill('tick ') : reply.match(/[\s\S]{1,12}/g);
  const delta = (p) => emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } } });
  if (hold) {
    const released = () => { try { fs.accessSync(process.env.FAKE_LOG + '.release'); return true; } catch { return false; } };
    while (!released()) { delta('tick '); parts.push('tick '); await new Promise((r) => setTimeout(r, 100)); }
    delta('done.'); parts.push('done.');
  }
  for (const p of hold ? [] : parts) {
    delta(p);
    await new Promise((r) => setTimeout(r, slow ? 100 : 5));
  }
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } } });
  emit({ type: 'assistant', message: { model, content: [{ type: 'text', text: parts.join('') }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, modelUsage, result: parts.join('') });
});
