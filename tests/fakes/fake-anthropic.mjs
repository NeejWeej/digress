#!/usr/bin/env node
// A pretend Anthropic API for tests: /v1/models and a streaming /v1/messages.
// Models whose name contains "noeffort" reject output_config, like a model without effort support.
import http from 'node:http';
import fs from 'node:fs';
// FAKE_API_LOG: each request's system + messages, one JSON line each (tests/test_context.py reads it)
const log = (o) => process.env.FAKE_API_LOG && fs.appendFileSync(process.env.FAKE_API_LOG, JSON.stringify(o) + '\n');
const port = Number(process.argv[2] || 8799);
http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8'); // whole characters even when one is split between chunks
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.headers['x-api-key'] !== 'test-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } })); }
    if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'claude-test-1', display_name: 'Test One' }, { id: 'claude-noeffort', display_name: 'No Effort' }] })); }
    const j = JSON.parse(body);
    log({ api: true, system: j.system, messages: j.messages });
    if (j.output_config && j.model.includes('noeffort')) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'output_config.effort: not supported for this model' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { model: j.model } });
    const web = (j.tools || []).find((t) => t.name === 'web_search');
    const last = j.messages[j.messages.length - 1];
    if (web && last.role === 'assistant') {
      // resuming a paused turn: the server must send back the search blocks it rebuilt from the stream
      const types = last.content.map((b) => b.type).join(',');
      const q = (last.content.find((b) => b.type === 'server_tool_use') || {}).input;
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `resumed with ${types} query=${q && q.query}` } });
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }); ev({ type: 'message_stop' }); return res.end();
    }
    if (web && JSON.stringify(last.content).includes('SEARCHME')) {
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"api search"}' } });
      ev({ type: 'content_block_stop', index: 0 });
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'API source', url: 'https://example.org/b', encrypted_content: 'x' }] } });
      ev({ type: 'content_block_stop', index: 1 });
      ev({ type: 'message_delta', delta: { stop_reason: 'pause_turn' } }); ev({ type: 'message_stop' }); return res.end();
    }
    const text = `api reply web=${!!web} effort=${j.output_config ? j.output_config.effort : 'none'} cached=${!!(j.system && j.system[0].cache_control)} n=${j.messages.length}`;
    for (const p of text.match(/.{1,8}/g)) { ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } }); await new Promise((r) => setTimeout(r, 3)); }
    ev({ type: 'message_delta', delta: { stop_reason: j.max_tokens < 50 ? 'max_tokens' : 'end_turn' } });
    ev({ type: 'message_stop' });
    res.end();
  });
}).listen(port, '127.0.0.1', () => console.log('fake anthropic on', port));
