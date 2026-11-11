#!/usr/bin/env node
// A pretend Anthropic API for tests: /v1/models and a streaming /v1/messages.
// Models whose name contains "noeffort" reject output_config, like a model without effort support.
import http from 'node:http';
const port = Number(process.argv[2] || 8799);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.headers['x-api-key'] !== 'test-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } })); }
    if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'claude-test-1', display_name: 'Test One' }, { id: 'claude-noeffort', display_name: 'No Effort' }] })); }
    const j = JSON.parse(body);
    if (j.output_config && j.model.includes('noeffort')) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'output_config.effort: not supported for this model' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { model: j.model } });
    const text = `api reply effort=${j.output_config ? j.output_config.effort : 'none'} cached=${!!(j.system && j.system[0].cache_control)} n=${j.messages.length}`;
    for (const p of text.match(/.{1,8}/g)) { ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } }); await new Promise((r) => setTimeout(r, 3)); }
    ev({ type: 'message_delta', delta: { stop_reason: j.max_tokens < 50 ? 'max_tokens' : 'end_turn' } });
    ev({ type: 'message_stop' });
    res.end();
  });
}).listen(port, '127.0.0.1', () => console.log('fake anthropic on', port));
