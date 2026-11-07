#!/usr/bin/env node
/*
 * Cogitator server — serves the Local Cogitator Interface PWA and relays
 * requests to your agentic harness: any OpenAI-compatible chat endpoint
 * (Hermes Agent, OpenClaw, Ollama, vLLM, LM Studio, llama.cpp server, …).
 *
 * Zero dependencies: only Node.js built-ins (Node 18+).
 *
 * Why a relay instead of letting the browser call the harness directly?
 *   - The harness API key stays on this machine and never reaches your phone.
 *   - No CORS configuration is needed on the harness.
 *   - The harness can stay bound to 127.0.0.1.
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RunStore } = require('./lib/runs');
const { Notifier } = require('./lib/notify');

// ---------------------------------------------------------------------------
// Configuration (.env file next to this script, overridden by real env vars)
// ---------------------------------------------------------------------------
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8080),
  // AGENT_* are canonical; HERMES_* are accepted as aliases.
  agentUrl: (process.env.AGENT_URL || process.env.HERMES_URL || 'http://127.0.0.1:8642').replace(/\/+$/, ''),
  agentKey: process.env.AGENT_API_KEY || process.env.HERMES_API_KEY || '',
  model: process.env.AGENT_MODEL || process.env.HERMES_MODEL || '',
  accessCode: process.env.COGITATOR_ACCESS_CODE || '',
  // Where push keys and device subscriptions are kept.
  dataDir: path.resolve(__dirname, process.env.DATA_DIR || 'data'),
  // Contact for push services (VAPID "sub"): a mailto: or https: URL.
  vapidSubject: process.env.VAPID_SUBJECT || 'https://github.com/dsmith111/Local-Machine-Spirit-UI',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

// Only these upstream paths may be reached through the relay.
const ALLOWED_UPSTREAM = [
  { method: 'GET', re: /^\/(health|v1\/health)$/, public: true },
  { method: 'GET', re: /^\/v1\/(models|capabilities)$/ },
  { method: 'POST', re: /^\/v1\/chat\/completions$/ },
  { method: 'POST', re: /^\/v1\/runs\/[A-Za-z0-9_.:-]{1,128}\/(stop|approval)$/ },
];

// Request headers forwarded to the harness (x-hermes-* enable Hermes Agent sessions).
const FORWARD_REQ_HEADERS = ['content-type', 'accept', 'x-hermes-session-id', 'x-hermes-session-key', 'idempotency-key'];
// x-cogitator-* request headers (run id, conversation, client, spirit name) stay here; they are not forwarded.
// Response headers passed back to the browser.
const FORWARD_RES_HEADERS = ['content-type', 'x-hermes-session-id', 'x-hermes-session-key', 'retry-after'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthorized(req) {
  if (!config.accessCode) return true;
  const supplied = req.headers['x-cogitator-key'];
  return typeof supplied === 'string' && safeEqual(supplied, config.accessCode);
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback: unknown non-asset routes get the app shell.
      if (!path.extname(rel)) return serveStatic(req, res, '/index.html');
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    // App code revalidates on every load so updates reach installed PWAs at once;
    // only images keep a long cache.
    const noCache = !['.png', '.svg', '.ico'].includes(ext);
    res.writeHead(200, {
      ...securityHeaders,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Notifications and detached runs
// ---------------------------------------------------------------------------
let notifier = null;
try {
  notifier = new Notifier({ dataDir: config.dataDir, subject: config.vapidSubject });
} catch (err) {
  console.warn(`    WARNING: notifications disabled; cannot use data directory ${config.dataDir} (${err.message})`);
}
const runs = new RunStore({
  agentUrl: config.agentUrl,
  agentKey: config.agentKey,
  hooks: notifier ? { onApproval: (r, d) => notifier.onApproval(r, d), onFinish: (r) => notifier.onFinish(r) } : {},
});

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const header = (req, name, max = 64) => String(req.headers[name] || '').slice(0, max);

// ---------------------------------------------------------------------------
// Relay to the agentic harness
// ---------------------------------------------------------------------------
function relay(req, res, upstreamPath, search) {
  const rule = ALLOWED_UPSTREAM.find((r) => r.method === req.method && r.re.test(upstreamPath));
  if (!rule) return sendJson(res, 404, { error: { message: 'Unknown rite.' } });
  if (!rule.public && !isAuthorized(req)) {
    return sendJson(res, 401, { error: { message: 'Access code required.', code: 'cogitator_auth' } });
  }

  const target = new URL(config.agentUrl + upstreamPath + (search || ''));
  const headers = {};
  for (const h of FORWARD_REQ_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  if (config.agentKey) headers.authorization = `Bearer ${config.agentKey}`;

  // A chat request tagged with a run id becomes a detached run: it keeps going
  // if the device disconnects, and can be re-attached and replayed.
  const runId = header(req, 'x-cogitator-run');
  if (upstreamPath === '/v1/chat/completions' && RunStore.validId(runId)) {
    return runs.start(req, res, {
      id: runId,
      upstreamPath: upstreamPath + (search || ''),
      headers,
      securityHeaders,
      forwardResHeaders: FORWARD_RES_HEADERS,
      meta: {
        convId: header(req, 'x-cogitator-conversation'),
        clientId: header(req, 'x-cogitator-client'),
        spiritName: decodeURIComponent(header(req, 'x-cogitator-spirit', 120)).slice(0, 32) || 'The machine spirit',
      },
    });
  }

  const lib = target.protocol === 'https:' ? https : http;
  const upstream = lib.request(
    target,
    { method: req.method, headers, timeout: 0 },
    (up) => {
      const out = { ...securityHeaders, 'Cache-Control': 'no-store' };
      for (const h of FORWARD_RES_HEADERS) if (up.headers[h]) out[h] = up.headers[h];
      if (String(up.headers['content-type'] || '').includes('text/event-stream')) {
        out['X-Accel-Buffering'] = 'no';
        out.Connection = 'keep-alive';
      }
      res.writeHead(up.statusCode || 502, out);
      res.flushHeaders?.();
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: `The machine spirit does not answer (${err.code || err.message}).`, code: 'upstream_unreachable' },
      });
    } else {
      res.destroy(err);
    }
  });

  // If the phone disconnects (Cease button, app closed), drop the upstream
  // connection too — harnesses such as Hermes interrupt the agent on client disconnect.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream);
}

// ---------------------------------------------------------------------------
// Model discovery: if AGENT_MODEL is unset, use the first model the harness
// advertises on /v1/models (cached for 5 minutes).
// ---------------------------------------------------------------------------
let modelCache = { value: '', at: 0 };
function resolveModel() {
  if (config.model) return Promise.resolve(config.model);
  if (modelCache.value && Date.now() - modelCache.at < 300_000) return Promise.resolve(modelCache.value);
  return new Promise((resolve) => {
    const target = new URL(config.agentUrl + '/v1/models');
    const lib = target.protocol === 'https:' ? https : http;
    const headers = config.agentKey ? { authorization: `Bearer ${config.agentKey}` } : {};
    const r = lib.get(target, { headers, timeout: 4000 }, (up) => {
      let body = '';
      up.setEncoding('utf8');
      up.on('data', (c) => (body += c));
      up.on('end', () => {
        try {
          const id = JSON.parse(body)?.data?.[0]?.id;
          if (id) modelCache = { value: id, at: Date.now() };
          resolve(id || 'default');
        } catch {
          resolve('default');
        }
      });
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve(modelCache.value || 'default'));
  });
}

// ---------------------------------------------------------------------------
// Runs, push and presence API
// ---------------------------------------------------------------------------
async function handleApi(req, res, p) {
  let m;
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/stream$/)) && req.method === 'GET') {
    const run = runs.get(m[1]);
    if (!run) return sendJson(res, 404, { error: { message: 'That rite is no longer remembered.', code: 'run_unknown' } });
    if (!runs.attach(m[1], res)) return sendJson(res, 409, { error: { message: 'Rite cannot be replayed.' }, run: runs.summary(run) });
    return;
  }
  if ((m = p.match(/^\/api\/runs\/([^/]+)$/)) && req.method === 'GET') {
    const run = runs.get(m[1]);
    return run ? sendJson(res, 200, runs.summary(run)) : sendJson(res, 404, { error: { message: 'Unknown run.' } });
  }
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/cancel$/)) && req.method === 'POST') {
    return runs.cancel(m[1]) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: { message: 'Unknown run.' } });
  }
  if (p === '/api/presence' && req.method === 'POST') {
    const body = await readJson(req, 4096);
    notifier?.setPresence(body.clientId, body.visible);
    return sendJson(res, 200, { ok: true });
  }
  if (!notifier) return sendJson(res, 503, { error: { message: 'Notifications are disabled on this server.' } });
  if (p === '/api/push/config' && req.method === 'GET') {
    return sendJson(res, 200, { publicKey: notifier.publicKey });
  }
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const body = await readJson(req);
    const entry = notifier.subscribe(body.subscription, body.clientId, body.prefs);
    return sendJson(res, 200, { ok: true, prefs: entry.prefs });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const body = await readJson(req);
    notifier.unsubscribe(String(body.endpoint || ''));
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    const body = await readJson(req);
    const result = await notifier.test(String(body.endpoint || ''));
    const ok = result.status >= 200 && result.status < 300;
    return sendJson(res, ok ? 200 : 502, { ok, status: result.status, error: result.error || result.body || undefined });
  }
  return sendJson(res, 404, { error: { message: 'Not found' } });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const p = url.pathname;

  if (p === '/api/config' && req.method === 'GET') {
    return resolveModel().then((model) => sendJson(res, 200, { authRequired: Boolean(config.accessCode), model }));
  }
  if (p === '/api/auth' && req.method === 'GET') {
    return isAuthorized(req) ? sendJson(res, 200, { ok: true }) : sendJson(res, 401, { ok: false });
  }
  if (p.startsWith('/api/agent/')) {
    return relay(req, res, p.slice('/api/agent'.length), url.search);
  }
  if (p.startsWith('/api/runs/') || p.startsWith('/api/push/') || p === '/api/presence') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: { message: 'Access code required.', code: 'cogitator_auth' } });
    return handleApi(req, res, p).catch((err) => {
      if (!res.headersSent) sendJson(res, 400, { error: { message: err.message } });
    });
  }
  if (p.startsWith('/api/')) return sendJson(res, 404, { error: { message: 'Not found' } });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  return serveStatic(req, res, p);
});

server.requestTimeout = 0; // agent turns can run for a long time
server.headersTimeout = 60_000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`!!! Port ${config.port} on ${config.host} is already in use. Is another copy running (a forgotten \`npm start\`, or the service)?`);
    console.error('    Stop it, or set a different PORT in .env.');
  } else {
    console.error(`!!! Cannot listen on ${config.host}:${config.port}: ${err.message}`);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`+++ Cogitator online at http://${config.host}:${config.port} +++`);
  console.log(`    Relaying to machine spirit at ${config.agentUrl}`);
  console.log(`    Model: ${config.model || '(auto: first entry of /v1/models)'}`);
  if (!config.agentKey) console.log('    NOTE: AGENT_API_KEY is not set; requests are sent without a bearer token.');
  if (!config.accessCode) console.warn('    NOTE: COGITATOR_ACCESS_CODE is not set; anyone who can reach this port can command the agent.');
  if (notifier) console.log(`    Push notifications ready (${notifier.subs.length} device${notifier.subs.length === 1 ? '' : 's'} subscribed; keys in ${config.dataDir})`);
});
