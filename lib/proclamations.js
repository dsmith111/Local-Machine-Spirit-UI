/*
 * Proclamations: messages the machine spirit sends on its own, without being
 * asked in the app. Two sources:
 *
 *   - ntfy:  scheduled jobs and reminders. Hermes' ntfy platform publishes to
 *            this server, which speaks the small part of the ntfy HTTP API that
 *            Hermes uses (POST /ntfy/<topic>, GET /ntfy/<topic>/json).
 *   - envoy: a Discord guest asked the spirit to pass something to its adept.
 *            Hermes' outbound webhook (post_llm_call) posts each guest turn;
 *            replies containing a "TO THE ADEPT:" line are forwarded.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ITEMS = 200;
const MAX_BODY = 8000;
// Hermes tags its own ntfy publishes so it can ignore their echo; not useful to show.
const HIDDEN_TAGS = new Set(['hermes-agent']);

class Proclamations {
  constructor({ dataDir, onNew = () => {}, log = console }) {
    this.file = path.join(dataDir, 'proclamations.json');
    this.onNew = onNew;
    this.log = log;
    this.items = this.load();
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  add({ source, title = '', body, tags = [] }) {
    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      at: Date.now(),
      source,
      title: String(title).slice(0, 200),
      body: String(body).slice(0, MAX_BODY),
      tags: tags.map(String).filter((t) => t && !HIDDEN_TAGS.has(t.toLowerCase())).slice(0, 8),
    };
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS);
    this.save();
    try {
      this.onNew(item);
    } catch (err) {
      this.log.warn('    proclamation hook failed', err.message);
    }
    return item;
  }

  list(limit = 100) {
    return this.items.slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// ntfy publish endpoint (what Hermes' ntfy platform calls)
// ---------------------------------------------------------------------------

/** Accept "Bearer <token>" or Basic auth whose password (or user:pass) equals the token. */
function ntfyAuthorized(req, token) {
  const h = String(req.headers.authorization || '');
  let supplied = '';
  if (/^Bearer\s+/i.test(h)) supplied = h.replace(/^Bearer\s+/i, '').trim();
  else if (/^Basic\s+/i.test(h)) {
    const decoded = Buffer.from(h.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
    supplied = decoded === token ? decoded : decoded.slice(decoded.indexOf(':') + 1);
  }
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return supplied.length > 0 && crypto.timingSafeEqual(a, b);
}

function header(req, ...names) {
  for (const n of names) {
    const v = req.headers[n];
    if (v) return decodeHeader(String(v));
  }
  return '';
}

// ntfy allows RFC 2047 encoded-words for non-ASCII titles; decode the common UTF-8 forms.
function decodeHeader(v) {
  return v.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, enc, text) => {
    try {
      return enc.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1').toString('utf8');
    } catch {
      return text;
    }
  });
}

// Hermes wraps cron output (cron.wrap_response, on by default):
//   Cronjob Response: <name>\n(job_id: <id>)\n-------------\n\n<content>\n\nTo stop or manage this job, …
const CRON_WRAP = /^Cronjob Response: (.+)\n\(job_id: [^)\n]*\)\n-{3,}\n+([\s\S]*?)(?:\n+To stop or manage this job, send me a new message[\s\S]*)?$/;

function unwrapCron(message) {
  const m = message.match(CRON_WRAP);
  return m ? { title: m[1].trim(), body: m[2].trim(), scheduled: true } : null;
}

/** POST/PUT /ntfy/<topic> — returns the ntfy-style message JSON Hermes expects. */
function ntfyPublish(req, body, { topic, store }) {
  let message = body.toString('utf8').trim();
  let title = header(req, 'x-title', 'title', 't');
  const tags = header(req, 'x-tags', 'tags', 'ta').split(',').map((t) => t.trim()).filter(Boolean);
  const cron = unwrapCron(message);
  if (cron) {
    message = cron.body;
    title = title || cron.title;
    tags.push('scheduled');
  }
  const item = store.add({ source: 'ntfy', title, body: message || '(empty proclamation)', tags });
  return { id: item.id, time: Math.floor(item.at / 1000), event: 'message', topic, message: item.body, ...(title ? { title } : {}) };
}

/** GET /ntfy/<topic>/json — Hermes keeps this open; we only ever send keepalives. */
function ntfySubscribe(req, res, topic) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const id = () => crypto.randomBytes(6).toString('hex');
  const now = () => Math.floor(Date.now() / 1000);
  res.write(JSON.stringify({ id: id(), time: now(), event: 'open', topic }) + '\n');
  const timer = setInterval(() => res.write(JSON.stringify({ id: id(), time: now(), event: 'keepalive', topic }) + '\n'), 45000);
  req.on('close', () => clearInterval(timer));
}

// ---------------------------------------------------------------------------
// Hermes outbound webhook (envoy messages from Discord guests)
// ---------------------------------------------------------------------------

const ENVOY_LINE = /^[ \t>*_]*TO THE ADEPT[*_]*\s*[:：][*_]*[ \t]*(.+)$/gim;

/** Extract "TO THE ADEPT: …" lines from an assistant reply. */
function envoyLines(text) {
  const out = [];
  for (const m of String(text || '').matchAll(ENVOY_LINE)) {
    const line = m[1].replace(/[*_]+$/, '').trim();
    if (line) out.push(line);
  }
  return out;
}

class HookReceiver {
  constructor({ secret, store, profiles, perHour = 12, log = console }) {
    this.secret = secret;
    this.store = store;
    this.profiles = new Set(profiles);
    this.perHour = perHour;
    this.log = log;
    this.seen = new Map(); // delivery_id -> time
    this.sent = []; // timestamps of forwarded envoy messages
  }

  verify(raw, signature) {
    if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', this.secret).update(raw).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()));
  }

  /** Returns [status, message]. */
  handle(raw, headers) {
    if (!this.verify(raw, String(headers['x-hermes-signature-256'] || ''))) return [401, 'bad signature'];
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return [400, 'invalid JSON'];
    }
    const ts = Date.parse(event.timestamp || '');
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return [400, 'stale or missing timestamp'];
    const delivery = String(event.delivery_id || headers['x-hermes-delivery'] || '');
    if (delivery) {
      if (this.seen.has(delivery)) return [200, 'duplicate'];
      this.seen.set(delivery, Date.now());
      if (this.seen.size > 1000) for (const [k] of [...this.seen].slice(0, 500)) this.seen.delete(k);
    }
    if (event.hook_event_name !== 'post_llm_call') return [200, 'ignored event'];
    if (this.profiles.size && !this.profiles.has(String(event.profile || 'default'))) return [200, 'ignored profile'];

    const extra = event.extra || {};
    const lines = envoyLines(extra.assistant_response);
    if (!lines.length) return [200, 'nothing for the adept'];

    const hourAgo = Date.now() - 3600 * 1000;
    this.sent = this.sent.filter((t) => t > hourAgo);
    if (this.sent.length >= this.perHour) {
      this.log.warn(`    envoy: rate limit reached (${this.perHour}/hour); message dropped`);
      return [200, 'rate limited'];
    }
    this.sent.push(Date.now());

    const asked = String(extra.user_message || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const plat = extra.platform ? String(extra.platform) : '';
    const platform = plat ? plat.charAt(0).toUpperCase() + plat.slice(1) : 'a guest channel';
    const body = lines.join('\n\n') + (asked ? `\n\n---\n*Asked via ${platform}:*\n> ${asked}` : '');
    this.store.add({ source: 'envoy', title: `Message via ${platform}`, body });
    return [200, 'forwarded'];
  }
}

module.exports = { Proclamations, ntfyAuthorized, ntfyPublish, ntfySubscribe, HookReceiver, envoyLines, unwrapCron };
