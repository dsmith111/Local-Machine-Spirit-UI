// Rules for who gets notified, without a network: deliver() is replaced by a recorder.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Notifier } = require('../lib/notify');

function setup() {
  const n = new Notifier({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cog-')), subject: 'https://example.com', log: { log() {}, warn() {} } });
  const sent = [];
  n.deliver = async (sub, payload) => {
    sent.push({ to: sub.clientId, ...payload });
    return { status: 201 };
  };
  const sub = (clientId, prefs) => n.subscribe({ endpoint: `https://push.example/${clientId}`, keys: { p256dh: 'x', auth: 'y' } }, clientId, prefs);
  const run = (over = {}) => ({ id: 'run1', status: 'completed', content: 'Praise **be**, adept.', errorText: '', listeners: new Set(), meta: { convId: 'c1', clientId: 'phone', spiritName: 'HERMES' }, ...over });
  const flush = () => new Promise((r) => setImmediate(r));
  return { n, sent, sub, run, flush };
}

test('an answer is pushed to every subscribed device when nobody is watching', async () => {
  const { n, sent, sub, run, flush } = setup();
  sub('phone');
  sub('tablet');
  n.onFinish(run());
  await flush();
  assert.deepStrictEqual(sent.map((s) => [s.to, s.kind, s.title, s.body, s.convId]), [
    ['phone', 'answer', 'HERMES has answered', 'Praise be, adept.', 'c1'],
    ['tablet', 'answer', 'HERMES has answered', 'Praise be, adept.', 'c1'],
  ]);
});

test('no push when the starting device is watching the run', async () => {
  const { n, sent, sub, run, flush } = setup();
  sub('phone');
  n.setPresence('phone', true);
  n.onFinish(run({ listeners: new Set([{}]) }));
  await flush();
  assert.strictEqual(sent.length, 0);
});

test('a device that is watching is skipped, others still get it', async () => {
  const { n, sent, sub, run, flush } = setup();
  sub('phone');
  sub('laptop');
  n.setPresence('laptop', true);
  n.onFinish(run()); // phone left (no listeners)
  await flush();
  assert.deepStrictEqual(sent.map((s) => s.to), ['phone']);
});

test('cancelled runs are silent; failures become faults', async () => {
  const { n, sent, sub, run, flush } = setup();
  sub('phone');
  n.onFinish(run({ status: 'cancelled' }));
  n.onFinish(run({ status: 'failed', errorText: 'HTTP 500: boom' }));
  await flush();
  assert.deepStrictEqual(sent.map((s) => [s.kind, s.title, s.body]), [['fault', 'The rite ended in fault', 'HTTP 500: boom']]);
});

test('preferences: kinds can be turned off and previews hidden', async () => {
  const { n, sent, sub, run, flush } = setup();
  sub('phone', { answers: false, previews: false });
  n.onFinish(run());
  n.onApproval(run(), { command: 'rm -rf ~/secret', description: 'Dangerous command' });
  await flush();
  assert.deepStrictEqual(sent.map((s) => [s.kind, s.body]), [['sanction', 'The machine spirit awaits thy verdict.']]);
});

test('approval previews keep commands verbatim', async () => {
  const { n, sent, sub, run, flush } = setup();
  sub('phone');
  n.onApproval(run(), { command: 'rm -rf ~/.cache/*_old', description: 'Dangerous command' });
  await flush();
  assert.strictEqual(sent[0].body, 'Dangerous command: rm -rf ~/.cache/*_old');
});

test('subscriptions persist and can be removed', () => {
  const { n, sub } = setup();
  sub('phone');
  const reloaded = new Notifier({ dataDir: path.dirname(n.subsFile), subject: 'x', log: console });
  assert.strictEqual(reloaded.subs.length, 1);
  assert.ok(reloaded.unsubscribe('https://push.example/phone'));
  assert.strictEqual(reloaded.subs.length, 0);
});
