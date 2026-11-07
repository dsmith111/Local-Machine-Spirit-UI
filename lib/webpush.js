/*
 * Minimal Web Push sender using only node:crypto.
 *
 *   - VAPID authentication (RFC 8292): an ES256-signed JWT identifies this
 *     server to the push service (Apple, Google, Mozilla).
 *   - Payload encryption (RFC 8291, "aes128gcm" from RFC 8188): the push
 *     service only relays ciphertext; only the subscribed device can read it.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (str) => Buffer.from(String(str), 'base64url'),
};

/** Load the VAPID key pair from `file`, creating it on first use. */
function loadOrCreateVapidKeys(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.publicKey && saved.privateJwk) return saved;
  } catch {
    /* create below */
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const keys = {
    // Uncompressed P-256 point (0x04 || X || Y), the form browsers expect.
    publicKey: b64u.enc(Buffer.concat([Buffer.from([4]), b64u.dec(pub.x), b64u.dec(pub.y)])),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

/** VAPID Authorization header value for a push endpoint. */
function vapidAuthorization(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u.enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u.enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const unsigned = `${header}.${claims}`;
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${keys.publicKey}`;
}

/** Encrypt `payload` for a subscription's keys (RFC 8291 / aes128gcm). */
function encryptPayload(payload, p256dh, authSecret) {
  const uaPublic = b64u.dec(p256dh);
  const auth = b64u.dec(authSecret);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, auth, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // A single record: payload followed by the 0x02 "last record" delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/**
 * Send one notification. Resolves to { status } (201/202 = delivered to the
 * push service; 404/410 = the subscription is gone and should be deleted).
 */
function sendPush(subscription, payload, { keys, subject, ttl = 86400, urgency = 'high' }) {
  return new Promise((resolve) => {
    let body;
    try {
      body = encryptPayload(JSON.stringify(payload), subscription.keys.p256dh, subscription.keys.auth);
    } catch (err) {
      return resolve({ status: 0, error: `encrypt: ${err.message}` });
    }
    const url = new URL(subscription.endpoint);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          'Content-Length': body.length,
          TTL: String(ttl),
          Urgency: urgency,
          Authorization: vapidAuthorization(subscription.endpoint, keys, subject),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text.slice(0, 300) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.end(body);
  });
}

module.exports = { loadOrCreateVapidKeys, vapidAuthorization, encryptPayload, sendPush, b64u };
