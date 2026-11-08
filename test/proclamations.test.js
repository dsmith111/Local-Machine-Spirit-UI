'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Proclamations, ntfyAuthorized, ntfyPublish, HookReceiver, envoyLines } = require('../lib/proclamations');

const store = () => {
  const added = [];
  const s = new Proclamations({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'proc-')), onNew: (i) => added.push(i) });
  return { s, added };
};
const req = (headers) => ({ headers });

test('ntfy auth: bearer, basic user:pass and basic token; wrong or missing rejected', () => {
  const tok = 'tk_secret123';
  assert.ok(ntfyAuthorized(req({ authorization: `Bearer ${tok}` }), tok));
  assert.ok(ntfyAuthorized(req({ authorization: 'Basic ' + Buffer.from(`hermes:${tok}`).toString('base64') }), tok));
  assert.ok(ntfyAuthorized(req({ authorization: 'Basic ' + Buffer.from(tok).toString('base64') }), tok));
  assert.ok(!ntfyAuthorized(req({ authorization: 'Bearer nope' }), tok));
  assert.ok(!ntfyAuthorized(req({}), tok));
});

test('ntfy publish stores a proclamation and answers like ntfy', () => {
  const { s, added } = store();
  const r = ntfyPublish(req({ 'x-title': '=?UTF-8?B?' + Buffer.from('Morning report ⚙').toString('base64') + '?=', 'x-tags': 'hermes-agent,cron' }), Buffer.from('Cronjob Response: daily\n\nAll systems nominal.'), { topic: 'proclamations', store: s });
  assert.strictEqual(r.event, 'message');
  assert.strictEqual(r.topic, 'proclamations');
  assert.ok(r.id);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].title, 'Morning report ⚙');
  assert.deepStrictEqual(added[0].tags, ['cron']);
  assert.strictEqual(new Proclamations({ dataDir: path.dirname(s.file) }).list().length, 1, 'persisted');
});

test('envoy lines are found in common formatting', () => {
  assert.deepStrictEqual(envoyLines('Very well.\n\nTO THE ADEPT: Kelly asks if game night is still on Friday.\n\nIt is done.'), ['Kelly asks if game night is still on Friday.']);
  assert.deepStrictEqual(envoyLines('**TO THE ADEPT:** a gift of lore\n> TO THE ADEPT: second'), ['a gift of lore', 'second']);
  assert.deepStrictEqual(envoyLines('I shall tell the adept: soon.'), []);
});

function signed(secret, body) {
  const raw = Buffer.from(JSON.stringify(body));
  return [raw, { 'x-hermes-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }];
}
const event = (over = {}) => ({
  hook_event_name: 'post_llm_call', profile: 'guest', delivery_id: crypto.randomUUID(), timestamp: new Date().toISOString(),
  extra: { user_message: 'tell your owner I said hi', assistant_response: 'It shall be done.\nTO THE ADEPT: Greetings from a visitor.', platform: 'discord' },
  ...over,
});

test('hook receiver: forwards signed guest messages, once', () => {
  const { s, added } = store();
  const h = new HookReceiver({ secret: 'shh', store: s, profiles: ['guest'] });
  const [raw, headers] = signed('shh', event({ delivery_id: 'd1' }));
  assert.deepStrictEqual(h.handle(raw, headers), [200, 'forwarded']);
  assert.deepStrictEqual(h.handle(raw, headers), [200, 'duplicate']);
  assert.strictEqual(added.length, 1);
  assert.match(added[0].body, /Greetings from a visitor\.[\s\S]*Asked via Discord[\s\S]*tell your owner I said hi/);
  assert.strictEqual(added[0].source, 'envoy');
});

test('hook receiver: rejects bad signatures, stale events; ignores other profiles and plain replies', () => {
  const { s, added } = store();
  const h = new HookReceiver({ secret: 'shh', store: s, profiles: ['guest'] });
  const [raw] = signed('shh', event());
  assert.strictEqual(h.handle(raw, { 'x-hermes-signature-256': 'sha256=' + '0'.repeat(64) })[0], 401);
  assert.strictEqual(h.handle(raw, {})[0], 401);
  assert.strictEqual(h.handle(...signed('wrong', event()))[0], 401);
  assert.strictEqual(h.handle(...signed('shh', event({ timestamp: new Date(Date.now() - 3600e3).toISOString() })))[0], 400);
  assert.deepStrictEqual(h.handle(...signed('shh', event({ profile: 'default' }))), [200, 'ignored profile']);
  assert.deepStrictEqual(h.handle(...signed('shh', event({ extra: { assistant_response: 'Just an answer.' } }))), [200, 'nothing for the adept']);
  assert.strictEqual(added.length, 0);
});

test('hook receiver: rate limit protects the adept from floods', () => {
  const { s, added } = store();
  const h = new HookReceiver({ secret: 'shh', store: s, profiles: ['guest'], perHour: 3, log: { warn() {} } });
  for (let i = 0; i < 5; i++) h.handle(...signed('shh', event()));
  assert.strictEqual(added.length, 3);
});

test('Hermes cron wrapper becomes a titled, tagged proclamation', () => {
  const { s, added } = store();
  const wrapped = 'Cronjob Response: Morning litany\n(job_id: abc123)\n-------------\n\nRecite the **Litany of Ignition**.\n\nTo stop or manage this job, send me a new message (e.g. "stop reminder Morning litany").';
  ntfyPublish(req({ 'x-tags': 'hermes-agent' }), Buffer.from(wrapped), { topic: 'proclamations', store: s });
  assert.strictEqual(added[0].title, 'Morning litany');
  assert.strictEqual(added[0].body, 'Recite the **Litany of Ignition**.');
  assert.deepStrictEqual(added[0].tags, ['scheduled']);
  ntfyPublish(req({}), Buffer.from('Plain message'), { topic: 'proclamations', store: s });
  assert.strictEqual(added[1].title, '');
  assert.strictEqual(added[1].body, 'Plain message');
});
