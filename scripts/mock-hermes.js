#!/usr/bin/env node
/*
 * A tiny stand-in for the Hermes Agent API server, for trying the UI without
 * a real agent. Emits the same SSE shapes Hermes does: chat.completion.chunk
 * deltas (content + reasoning_content), `hermes.tool.progress` events,
 * `approval.request` events, and the X-Hermes-Session-Id response header.
 *
 *   node scripts/mock-hermes.js            # listens on 127.0.0.1:8642
 *   HERMES_API_KEY=mock npm start          # in another terminal
 *
 * Mention "sanction" in a message to trigger an approval prompt.
 */
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.MOCK_PORT || 8642);
const pendingApprovals = new Map(); // runId -> resolve

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (data, event) => (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const REPLY = `Praise be, adept. The rite is complete and thy host endures.

### Condition of the host
| Organ | Reading |
|---|---|
| Load | 0.42 |
| Memory | 3.1 / 8 GiB |
| Disk | 61% sanctified |

- The **motive force** flows true.
- No daemons stir in the logs.

\`\`\`bash
df -h / && free -h && uptime
\`\`\`

Thus is the Omnissiah's will made manifest.`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health' || url.pathname === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"status":"ok"}');
  }
  if (req.headers.authorization !== `Bearer ${process.env.HERMES_API_KEY || 'mock'}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end('{"error":{"message":"Invalid API key"}}');
  }
  const m = url.pathname.match(/^\/v1\/runs\/([^/]+)\/(approval|stop)$/);
  if (m && req.method === 'POST') {
    const body = await readBody(req);
    const resolve = pendingApprovals.get(m[1]);
    if (m[2] === 'stop' || resolve) {
      if (resolve) resolve(m[2] === 'stop' ? 'deny' : body.choice);
      pendingApprovals.delete(m[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ run_id: m[1], choice: body.choice, resolved: 1 }));
    }
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end('{"error":{"message":"No pending approval"}}');
  }
  if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
    res.writeHead(404);
    return res.end();
  }

  const body = await readBody(req);
  const last = [...(body.messages || [])].reverse().find((x) => x.role === 'user');
  const text = typeof last?.content === 'string' ? last.content : (last?.content || []).map((p) => p.text || '[image]').join(' ');
  const sessionId = req.headers['x-hermes-session-id'] || 'sess_' + crypto.randomBytes(4).toString('hex');
  const id = 'chatcmpl-' + crypto.randomBytes(6).toString('hex');
  const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: 'hermes-agent', choices: [{ index: 0, delta, finish_reason: finish }] });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Hermes-Session-Id': sessionId });
  let closed = false;
  res.on('close', () => (closed = true));
  const write = (s) => !closed && res.write(s);

  write(frame(chunk({ role: 'assistant' })));
  for (const piece of ['The supplicant asks of ', 'the host. ', 'I shall consult the terminal.']) {
    await sleep(250);
    write(frame(chunk({ reasoning_content: piece })));
  }
  await sleep(300);
  write(': keepalive\n\n');
  write(frame({ tool: 'terminal', emoji: '💻', label: 'df -h / && free -h', toolCallId: 'call_1', status: 'running' }, 'hermes.tool.progress'));

  if (/sanction/i.test(text)) {
    write(frame({ event: 'approval.request', run_id: id, timestamp: Date.now() / 1000, command: 'rm -rf ~/.cache/old-litanies', description: 'Dangerous command: recursive delete', choices: ['once', 'session', 'always', 'deny'] }, 'approval.request'));
    const choice = await new Promise((resolve) => pendingApprovals.set(id, resolve));
    if (choice === 'deny') {
      write(frame(chunk({ content: 'Thy will be done; the rite is withheld.' })));
      write(frame(chunk({}, 'stop')));
      write('data: [DONE]\n\n');
      return res.end();
    }
  }
  await sleep(1200);
  write(frame({ tool: 'terminal', toolCallId: 'call_1', status: 'completed' }, 'hermes.tool.progress'));
  write(frame({ kind: 'info', text: 'Composing reply…' }, 'hermes.status'));
  await sleep(400);
  for (let i = 0; i < REPLY.length && !closed; i += 6) {
    write(frame(chunk({ content: REPLY.slice(i, i + 6) })));
    await sleep(18);
  }
  write(frame(chunk({}, 'stop')));
  write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, '127.0.0.1', () => console.log(`Mock Hermes listening on http://127.0.0.1:${PORT}`));
