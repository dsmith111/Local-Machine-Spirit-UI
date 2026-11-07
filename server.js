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
    const noCache = ext === '.html' || rel === '/sw.js' || ext === '.webmanifest';
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
  if (p.startsWith('/api/')) return sendJson(res, 404, { error: { message: 'Not found' } });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  return serveStatic(req, res, p);
});

server.requestTimeout = 0; // agent turns can run for a long time
server.headersTimeout = 60_000;

server.listen(config.port, config.host, () => {
  console.log(`+++ Cogitator online at http://${config.host}:${config.port} +++`);
  console.log(`    Relaying to machine spirit at ${config.agentUrl}`);
  console.log(`    Model: ${config.model || '(auto: first entry of /v1/models)'}`);
  if (!config.agentKey) console.log('    NOTE: AGENT_API_KEY is not set; requests are sent without a bearer token.');
  if (!config.accessCode) console.warn('    NOTE: COGITATOR_ACCESS_CODE is not set; anyone who can reach this port can command the agent.');
});
