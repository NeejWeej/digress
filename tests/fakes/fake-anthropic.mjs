#!/usr/bin/env node
// A pretend Anthropic API for tests: /v1/models and a streaming /v1/messages.
// Models whose name contains "noeffort" reject output_config, like a model without effort support.
import http from 'node:http';
import fs from 'node:fs';
import { scriptFor, INTRO, answer } from './doc-script.mjs';
// FAKE_API_LOG: each request's system + messages, one JSON line each (tests/test_context.py reads it)
const log = (o) => process.env.FAKE_API_LOG && fs.appendFileSync(process.env.FAKE_API_LOG, JSON.stringify(o) + '\n');
const port = Number(process.argv[2] || 8799);
http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8'); // whole characters even when one is split between chunks
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.headers['x-api-key'] !== 'test-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } })); }
    if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'claude-test-1', display_name: 'Test One', max_input_tokens: 200000 }, { id: 'claude-noeffort', display_name: 'No Effort' }] })); }
    const j = JSON.parse(body);
    log({ api: true, system: j.system, messages: j.messages, tools: (j.tools || []).map((t) => t.name), tool_choice: j.tool_choice });
    if (j.output_config && j.model.includes('noeffort')) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'output_config.effort: not supported for this model' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { model: j.model, usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: Math.ceil(JSON.stringify([j.system, j.messages]).length / 4), output_tokens: 1 } } });
    const web = (j.tools || []).find((t) => t.name === 'web_search');
    const isResults = (m) => m.role === 'user' && Array.isArray(m.content) && m.content.length && m.content.every((b) => b.type === 'tool_result');
    const asked = [...j.messages].reverse().find((m) => m.role === 'user' && !isResults(m));
    const ROUNDS = asked && scriptFor(JSON.stringify(asked.content));
    // NEVERSTOP: a model that keeps searching for as long as it may; told it can't (tool_choice none), it answers
    if ((j.tools || []).some((t) => t.name === 'search') && asked && JSON.stringify(asked.content).includes('NEVERSTOP')) {
      const done = j.messages.filter(isResults).length;
      ev({ type: 'content_block_start', index: 0, content_block: (j.tool_choice || {}).type === 'none' ? { type: 'text', text: '' } : { type: 'tool_use', id: `toolu_n${done}`, name: 'search', input: {} } });
      if ((j.tool_choice || {}).type === 'none') {
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `FINALANSWER after ${done} tool results` } }); ev({ type: 'content_block_stop', index: 0 });
        ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      } else {
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: 'Section ' + (done + 1) }) } }); ev({ type: 'content_block_stop', index: 0 });
        ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
      }
      ev({ type: 'message_stop' }); return res.end();
    }
    if ((j.tools || []).some((t) => t.name === 'read_pages') && ROUNDS) {
      const done = j.messages.filter(isResults).length;
      if (done < ROUNDS.length) {
        let i = 0;
        if (done === 0) { ev({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }); ev({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: INTRO } }); ev({ type: 'content_block_stop', index: i++ }); }
        ROUNDS[done].forEach(([name, input], k) => {
          ev({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${done}${k}`, name, input: {} } });
          const js = JSON.stringify(input); for (const piece of [js.slice(0, 5), js.slice(5)]) ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: piece } });
          ev({ type: 'content_block_stop', index: i++ });
        });
        ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }); ev({ type: 'message_stop' }); return res.end();
      }
      // every result, named from the tool_use block it answers (which the server must have sent back too)
      const names = new Map(j.messages.filter((m) => m.role === 'assistant' && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => [b.id, b.name])));
      const results = j.messages.filter(isResults).flatMap((m) => m.content.map((b) => ({ name: names.get(b.tool_use_id) || 'UNMATCHED', error: !!b.is_error,
        parts: b.content.map((c) => (c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image', mediaType: c.source.media_type, data: c.source.data })) })));
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer(results) } });
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }); ev({ type: 'message_stop' }); return res.end();
    }
    const last = j.messages[j.messages.length - 1];
    if (web && last.role === 'assistant') {
      // resuming a paused turn: the server must send back the search blocks it rebuilt from the stream
      const types = last.content.map((b) => b.type).join(',');
      const q = (last.content.find((b) => b.type === 'server_tool_use') || {}).input;
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `resumed with ${types} query=${q && q.query}` } });
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }); ev({ type: 'message_stop' }); return res.end();
    }
    if (web && JSON.stringify(last.content).includes('SEARCHME')) {
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"api search"}' } });
      ev({ type: 'content_block_stop', index: 0 });
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'API source', url: 'https://example.org/b', encrypted_content: 'x' }] } });
      ev({ type: 'content_block_stop', index: 1 });
      ev({ type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 9 } }); ev({ type: 'message_stop' }); return res.end();
    }
    const text = `api reply web=${!!web} effort=${j.output_config ? j.output_config.effort : 'none'} cached=${!!(j.system && j.system[0].cache_control)} n=${j.messages.length}`;
    for (const p of text.match(/.{1,8}/g)) { ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } }); await new Promise((r) => setTimeout(r, 3)); }
    ev({ type: 'message_delta', delta: { stop_reason: j.max_tokens < 50 ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 9 } });
    ev({ type: 'message_stop' });
    res.end();
  });
}).listen(port, '127.0.0.1', () => console.log('fake anthropic on', port));
