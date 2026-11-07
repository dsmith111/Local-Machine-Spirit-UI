// Round-trip tests for lib/webpush.js: decrypt exactly as a browser would
// (RFC 8291 / RFC 8188) and verify the VAPID JWT (RFC 8292).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { loadOrCreateVapidKeys, vapidAuthorization, encryptPayload, b64u } = require('../lib/webpush');

// The "user agent" side: a browser's push subscription keys.
function makeSubscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, keys: { p256dh: b64u.enc(ecdh.getPublicKey()), auth: b64u.enc(auth) }, auth };
}

function decryptAsBrowser(body, sub) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  assert.strictEqual(rs, 4096);
  const shared = sub.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), sub.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, sub.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, -16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2, 'last-record delimiter');
  return plain.subarray(0, -1).toString();
}

test('payload decrypts to the original text', () => {
  const sub = makeSubscriber();
  const msg = JSON.stringify({ title: 'MACHINE SPIRIT has answered', body: 'Praise be — ünïcödé ✓' });
  assert.strictEqual(decryptAsBrowser(encryptPayload(msg, sub.keys.p256dh, sub.keys.auth), sub), msg);
});

test('each message uses a fresh salt and server key', () => {
  const sub = makeSubscriber();
  const a = encryptPayload('x', sub.keys.p256dh, sub.keys.auth);
  const b = encryptPayload('x', sub.keys.p256dh, sub.keys.auth);
  assert.notDeepStrictEqual(a.subarray(0, 86), b.subarray(0, 86));
});

test('VAPID keys persist and the JWT verifies against the public key', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vapid-')), 'vapid.json');
  const keys = loadOrCreateVapidKeys(file);
  assert.deepStrictEqual(loadOrCreateVapidKeys(file), keys, 'second load reuses the same keys');
  assert.strictEqual(b64u.dec(keys.publicKey).length, 65);

  const header = vapidAuthorization('https://web.push.apple.com/abc/def', keys, 'https://example.com');
  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, header);
  const [, h, c, s, k] = m;
  assert.strictEqual(k, keys.publicKey);
  const claims = JSON.parse(b64u.dec(c));
  assert.strictEqual(claims.aud, 'https://web.push.apple.com');
  assert.strictEqual(claims.sub, 'https://example.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);

  const pub = b64u.dec(keys.publicKey);
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, b64u.dec(s)));
});
