#!/usr/bin/env node
// A pretend OpenAI for tests: the "Sign in with ChatGPT" endpoints (authorize, token, keys, revoke) and
// the plan route of the Responses API (/v1/models, streaming /v1/responses). It enforces the plan
// route's rules (store:false, stream:true, no system messages, no max_output_tokens), so a request
// that breaks them fails the test. Each /v1/responses body is appended to FAKE_LOG.
// Messages containing SEARCHME search (when web_search is offered and tool_choice allows it), LIMIT hit the plan limit,
// DROP end without response.completed.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { scriptFor, INTRO, answer } from './doc-script.mjs';
const port = Number(process.argv[2] || 8798);
const BASE = `http://127.0.0.1:${port}`;
const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims) {
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), p = b64({ iss: BASE, sub: 'user-1', email: 'reader@example.com', exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return h + '.' + p + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url');
}
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const pending = new Map(); // code -> {nonce, challenge, redirect}
let access = new Set(['tok-1']), refresh = new Set(['ref-1']), n = 0;
const revoked = [];

http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8'); // whole characters even when one is split between chunks
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, BASE);
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') return json(200, { issuer: BASE, jwks_uri: BASE + '/jwks', revocation_endpoint: BASE + '/revoke' });
    if (u.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (u.pathname === '/revoke') { revoked.push(new URLSearchParams(body).get('token')); return json(200, {}); }
    if (u.pathname === '/revoked') return json(200, revoked);
    if (u.pathname === '/api/accounts/authorize') {
      const q = u.searchParams;
      if (q.get('client_id') !== 'dynamic_agent_client' || !q.get('ext_agent_host_id')?.startsWith('urn:uuid:') || q.get('resource') !== 'https://api.openai.com/v1'
        || !q.get('scope').includes('chatgpt.tokens.use.direct') || q.get('code_challenge_method') !== 'S256' || !q.get('redirect_uri').startsWith('http://127.0.0.1:')) return json(400, { error: 'bad authorize request' });
      const code = 'code-' + ++n;
      pending.set(code, { nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') });
      res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state'))}&client_id=app_123&scope=${encodeURIComponent(SCOPE)}` });
      return res.end();
    }
    if (u.pathname === '/api/accounts/oauth/token') {
      const f = Object.fromEntries(new URLSearchParams(body));
      if (f.resource !== 'https://api.openai.com/v1' || f.client_id !== 'app_123') return json(400, { error: 'invalid_client' });
      if (f.grant_type === 'authorization_code') {
        const p = pending.get(f.code); pending.delete(f.code);
        const ok = p && p.redirect === f.redirect_uri && crypto.createHash('sha256').update(f.code_verifier).digest('base64url') === p.challenge;
        if (!ok) return json(400, { error: 'invalid_grant' });
        access = new Set(['tok-login']); refresh = new Set(['ref-login']);
        return json(200, { access_token: 'tok-login', refresh_token: 'ref-login', id_token: idToken({ aud: 'app_123', nonce: p.nonce }), token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
      }
      if (f.grant_type === 'refresh_token') {
        if (!refresh.has(f.refresh_token)) return json(400, { error: 'refresh_token_reused' });
        const k = ++n; access = new Set(['tok-r' + k]); refresh = new Set(['ref-r' + k]); // rotates
        return json(200, { access_token: 'tok-r' + k, refresh_token: 'ref-r' + k, id_token: idToken({ aud: 'app_123' }), token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (u.pathname.startsWith('/v1/') && !access.has(auth)) return json(401, { error: { code: 'subscription_sharing_invalid_user', message: 'bad token' } });
    if (u.pathname === '/v1/models') return json(200, { models: [{ slug: 'gpt-test-1', display_name: 'GPT Test', visibility: 'list', context_window: 272000 }, { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' }] });
    if (u.pathname !== '/v1/responses') return json(404, {});

    const j = JSON.parse(body);
    log({ token: auth, ...j });
    const bad = j.store !== false ? 'store' : j.stream !== true ? 'stream' : 'max_output_tokens' in j ? 'max_output_tokens' : 'temperature' in j ? 'temperature'
      : j.input.some((m) => m.role === 'system') ? 'input' : (j.tools || []).some((t) => t.type !== 'web_search' && t.type !== 'function') ? 'tools' : null;
    if (bad) return json(400, { error: { code: 'subscription_sharing_unsupported_capability', param: bad, message: 'unsupported ' + bad } });
    if (j.reasoning && j.reasoning.effort === 'max') return json(400, { error: { message: "Unsupported value: 'reasoning.effort' does not support 'max' with this model." } });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let seq = 0;
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify({ ...o, sequence_number: seq++ })}\n\n`);
    const resp = { id: 'resp_1', model: j.model + '-2026', status: 'in_progress' };
    ev({ type: 'response.created', response: resp });
    const last = j.input[j.input.length - 1].content;
    const say = (i, text, annotations = []) => {
      ev({ type: 'response.output_item.added', output_index: i, item: { type: 'message', role: 'assistant', content: [] } });
      for (const p of text.match(/[\s\S]{1,10}/g)) ev({ type: 'response.output_text.delta', output_index: i, delta: p });
      ev({ type: 'response.output_item.done', output_index: i, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations }] } });
    };
    const asked = [...j.input].reverse().find((m) => m.role === 'user');
    const ROUNDS = asked && scriptFor(JSON.stringify(asked.content));
    if ((j.tools || []).some((t) => t.type === 'function' && t.name === 'read_pages') && ROUNDS) {
      const outs = j.input.filter((it) => it.type === 'function_call_output'), calls = j.input.filter((it) => it.type === 'function_call');
      let done = 0; for (let n = 0; done < ROUNDS.length && n + ROUNDS[done].length <= outs.length; done++) n += ROUNDS[done].length;
      if (done > 0) {
        // store:false: the model's encrypted reasoning from each earlier round must come back, as must its calls
        const enc = j.input.filter((it) => it.type === 'reasoning').map((it) => it.encrypted_content);
        if (!(j.include || []).includes('reasoning.encrypted_content') || !Array.from({ length: done }, (_, k) => `ENC-${k + 1}`).every((e) => enc.includes(e)) || calls.length !== outs.length) {
          ev({ type: 'response.failed', response: { ...resp, status: 'failed', error: { message: `tool loop state not sent back: include=${j.include} reasoning=${enc} calls=${calls.length} outputs=${outs.length}` } } }); return res.end();
        }
      }
      if (done < ROUNDS.length) {
        let i = 0;
        ev({ type: 'response.output_item.done', output_index: i++, item: { type: 'reasoning', id: `rs_${done + 1}`, summary: [], encrypted_content: `ENC-${done + 1}` } });
        if (done === 0) say(i++, INTRO);
        ROUNDS[done].forEach(([name, input], k) => ev({ type: 'response.output_item.done', output_index: i++, item: { type: 'function_call', id: `fc_${done}${k}`, call_id: `call_${done}${k}`, name, arguments: JSON.stringify(input), status: 'completed' } }));
      } else {
        const names = new Map(calls.map((c) => [c.call_id, c.name]));
        const results = outs.map((o) => ({ name: names.get(o.call_id) || 'UNMATCHED', error: /^\(?error/i.test(o.output[0] && o.output[0].text || ''),
          parts: o.output.map((c) => (c.type === 'input_text' ? { type: 'text', text: c.text } : { type: 'image', mediaType: c.image_url.slice(5, c.image_url.indexOf(';')), data: c.image_url.split(',', 2)[1] })) }));
        say(0, answer(results));
      }
      ev({ type: 'response.completed', response: { ...resp, status: 'completed', usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 20 } } });
      return res.end();
    }
    if (last.includes('LIMIT')) {
      say(0, 'Partial ');
      ev({ type: 'response.failed', response: { ...resp, status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } });
      return res.end();
    }
    if (last.includes('DROP')) { say(0, 'Half a repl'); return res.end(); }
    if (last.includes('SEARCHME') && (j.tools || []).some((t) => t.type === 'web_search') && (!j.tool_choice || (j.tool_choice.tools || []).some((t) => t.type === 'web_search'))) {
      say(0, 'Let me check.');
      const sources = [{ type: 'url', url: 'https://example.net/c', title: 'Net source' }, { type: 'url', url: 'javascript:alert(1)' }];
      ev({ type: 'response.output_item.added', output_index: 1, item: { type: 'web_search_call', status: 'in_progress' } });
      ev({ type: 'response.output_item.done', output_index: 1, item: { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'gpt search', sources: j.include?.includes('web_search_call.action.sources') ? sources : undefined } } });
      say(2, 'Found: [net](https://example.net/c).', [{ type: 'url_citation', url: 'https://example.net/d', title: 'Cited', start_index: 0, end_index: 5 }]);
    } else {
      const dev = j.input[0].role === 'developer' ? j.input[0].content.length : 0;
      say(0, `gpt reply effort=${j.reasoning ? j.reasoning.effort : 'none'} tools=${(j.tools || []).length} dev=${dev} n=${j.input.length}`);
    }
    ev({ type: 'response.completed', response: { ...resp, status: 'completed', usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 20 } } });
    res.end();
  });
}).listen(port, '127.0.0.1', () => console.log('fake openai on', port));
