#!/usr/bin/env node
// Stands in for the Claude Code CLI in tests: prints the same stream-json lines `claude -p` does.
// It echoes what it received, so tests can check the server passed things through correctly.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (Claude Code fake)'); process.exit(0); }
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const log = (s) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, s + '\n');
let prompt = '';
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', async () => {
  const system = fs.readFileSync(arg('--system-prompt-file'), 'utf8');
  const model = arg('--model'), effort = arg('--effort') || 'none';
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  log(JSON.stringify({ model, effort, tools: arg('--tools'), allowed: arg('--allowedTools') || null, apiKeyVisible: !!process.env.ANTHROPIC_API_KEY, systemChars: system.length, prompt }));
  process.on('SIGTERM', () => { log('KILLED'); process.exit(143); });
  if (prompt.includes('FAILAUTH')) {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' });
    process.exit(1);
  }
  if (prompt.includes('SEARCHME') && arg('--tools') === 'WebSearch') {
    // what the real CLI prints for one WebSearch call: the tool call streams, then its result comes back as a user message
    const ev = (event) => emit({ type: 'stream_event', event });
    ev({ type: 'message_start', message: { model } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look.' } });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'WebSearch', input: {} } });
    for (const j of ['{"query": "fake ', 'search query"}']) ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: j } });
    ev({ type: 'content_block_stop', index: 1 });
    emit({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'fake search query' } }] } });
    const links = [{ title: 'Example source', url: 'https://example.com/a' }, { title: 'Bad', url: 'javascript:alert(1)' }];
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `Web search results for query: "fake search query"\n\nLinks: ${JSON.stringify(links)}\n\nSummary...` }] } });
    ev({ type: 'message_start', message: { model } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it: [Example](https://example.com/a).' } });
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'Found it.' });
    return;
  }
  const reply = `Fake reply. model=${model} effort=${effort} system=${system.length} turns=${(prompt.match(/<user>/g) || []).length + 1}\n\nThe gradient of $x^2$ is $2x$.`;
  emit({ type: 'system', subtype: 'init', model });
  emit({ type: 'stream_event', event: { type: 'message_start', message: { model } } });
  const slow = prompt.includes('SLOW');
  const parts = slow ? Array(200).fill('tick ') : reply.match(/[\s\S]{1,12}/g);
  for (const p of parts) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } } });
    await new Promise((r) => setTimeout(r, slow ? 100 : 5));
  }
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
  emit({ type: 'assistant', message: { model, content: [{ type: 'text', text: parts.join('') }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: parts.join('') });
});
