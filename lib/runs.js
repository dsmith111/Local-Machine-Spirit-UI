/*
 * Detached runs: a streamed chat completion keeps going on the server even if
 * the device that started it disconnects (phone locked, app swiped away). The
 * raw SSE stream is buffered so any device can re-attach and replay it, and
 * lifecycle hooks drive push notifications.
 */
'use strict';

const http = require('node:http');
const https = require('node:https');

const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const KEEP_FINISHED_MS = 60 * 60 * 1000; // replayable for an hour after finishing
const MAX_RUNS = 100;
const MAX_BYTES = 16 * 1024 * 1024; // per run; beyond this replay is truncated

class RunStore {
  /**
   * @param {object} opts
   * @param {string} opts.agentUrl   harness base URL
   * @param {string} opts.agentKey   bearer token for the harness ('' for none)
   * @param {object} opts.hooks      { onApproval(run, data), onFinish(run) }
   */
  constructor({ agentUrl, agentKey, hooks = {} }) {
    this.agentUrl = agentUrl;
    this.agentKey = agentKey;
    this.hooks = hooks;
    this.runs = new Map();
    setInterval(() => this.gc(), 5 * 60 * 1000).unref();
  }

  static validId(id) {
    return typeof id === 'string' && RUN_ID.test(id);
  }

  get(id) {
    return this.runs.get(id) || null;
  }

  gc() {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (run.finishedAt && now - run.finishedAt > KEEP_FINISHED_MS) this.runs.delete(id);
    }
    if (this.runs.size > MAX_RUNS) {
      const finished = [...this.runs.values()].filter((r) => r.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
      for (const r of finished.slice(0, this.runs.size - MAX_RUNS)) this.runs.delete(r.id);
    }
  }

  /**
   * Start a run: forward the client's request upstream and stream the reply to
   * `res`. Non-streaming or error responses are passed straight through.
   */
  start(req, res, { id, upstreamPath, headers, meta, securityHeaders, forwardResHeaders }) {
    if (this.runs.has(id)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Run id already in use.' } }));
    }
    const run = {
      id,
      meta, // { convId, clientId, spiritName }
      status: 'starting',
      startedAt: Date.now(),
      finishedAt: 0,
      chunks: [],
      bytes: 0,
      truncated: false,
      listeners: new Set(),
      resHeaders: {},
      completionId: '',
      content: '',
      finishReason: '',
      errorText: '',
      sseBuffer: '',
      upstream: null,
    };
    this.runs.set(id, run);
    this.gc();

    const target = new URL(this.agentUrl + upstreamPath);
    const lib = target.protocol === 'https:' ? https : http;
    const upstream = lib.request(target, { method: 'POST', headers, timeout: 0 }, (up) => {
      const isStream = String(up.headers['content-type'] || '').includes('text/event-stream');
      const out = { ...securityHeaders, 'Cache-Control': 'no-store', 'X-Cogitator-Run': id };
      for (const h of forwardResHeaders) if (up.headers[h]) out[h] = up.headers[h];

      if (!isStream || (up.statusCode || 0) >= 400) {
        // Not something we can detach: pass through and record the failure.
        run.status = (up.statusCode || 0) >= 400 ? 'failed' : 'completed';
        let text = '';
        up.on('data', (c) => {
          if (text.length < 2000) text += c.toString('utf8');
        });
        up.on('end', () => {
          run.errorText = run.status === 'failed' ? `HTTP ${up.statusCode}: ${text.slice(0, 300)}` : '';
          this.finish(run, run.status);
        });
        if (!res.destroyed) {
          res.writeHead(up.statusCode || 502, out);
          up.pipe(res);
        } else up.resume();
        return;
      }

      run.status = 'running';
      run.resHeaders = { ...out, 'X-Accel-Buffering': 'no', Connection: 'keep-alive' };
      if (!res.destroyed) this.attachResponse(run, res, false);

      up.on('data', (chunk) => this.ingest(run, chunk));
      up.on('end', () => this.finish(run, this.terminalStatus(run)));
      up.on('error', (err) => {
        run.errorText = run.errorText || `stream error: ${err.message}`;
        this.finish(run, run.status === 'cancelled' ? 'cancelled' : 'failed');
      });
    });
    run.upstream = upstream;

    upstream.on('error', (err) => {
      if (run.finishedAt) return;
      run.errorText = `The machine spirit does not answer (${err.code || err.message}).`;
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'X-Cogitator-Run': id });
        res.end(JSON.stringify({ error: { message: run.errorText, code: 'upstream_unreachable' } }));
      }
      this.finish(run, run.status === 'cancelled' ? 'cancelled' : 'failed');
    });

    // The device leaving does NOT stop the run; only an explicit cancel does.
    req.pipe(upstream);
  }

  /** Attach a client response; replays everything so far when `replay`. */
  attachResponse(run, res, replay = true) {
    res.writeHead(200, run.resHeaders);
    res.flushHeaders?.();
    if (replay) for (const c of run.chunks) res.write(c);
    if (run.finishedAt) return res.end();
    run.listeners.add(res);
    res.on('close', () => run.listeners.delete(res));
  }

  /** Re-attach an existing run by id. Returns false when unknown. */
  attach(id, res) {
    const run = this.get(id);
    if (!run || !run.resHeaders['Content-Type'] && !run.resHeaders['content-type']) return false;
    this.attachResponse(run, res, true);
    return true;
  }

  ingest(run, chunk) {
    if (run.bytes + chunk.length <= MAX_BYTES) {
      run.chunks.push(chunk);
      run.bytes += chunk.length;
    } else run.truncated = true;
    for (const l of run.listeners) l.write(chunk);

    // Light SSE parse for notifications: content preview, approvals, outcome.
    run.sseBuffer += chunk.toString('utf8').replace(/\r\n?/g, '\n');
    let sep;
    while ((sep = run.sseBuffer.indexOf('\n\n')) !== -1) {
      const block = run.sseBuffer.slice(0, sep);
      run.sseBuffer = run.sseBuffer.slice(sep + 2);
      this.parseBlock(run, block);
    }
  }

  parseBlock(run, block) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length || data[0] === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    if (event === 'approval.request') {
      if (parsed.run_id) run.completionId = run.completionId || parsed.run_id;
      this.hooks.onApproval?.(run, parsed);
      return;
    }
    if (event !== 'message') return;
    if (parsed.error) run.errorText = parsed.error.message || 'stream error';
    if (parsed.id && !run.completionId) run.completionId = parsed.id;
    const choice = parsed.choices && parsed.choices[0];
    if (!choice) return;
    if (choice.delta && typeof choice.delta.content === 'string' && run.content.length < 4000) run.content += choice.delta.content;
    if (choice.finish_reason) run.finishReason = choice.finish_reason;
  }

  terminalStatus(run) {
    if (run.status === 'cancelled' || run.finishReason === 'cancelled') return 'cancelled';
    if (run.errorText || run.finishReason === 'error') return 'failed';
    return 'completed';
  }

  finish(run, status) {
    if (run.finishedAt) return;
    run.status = status;
    run.finishedAt = Date.now();
    if (run.sseBuffer.trim()) this.parseBlock(run, run.sseBuffer);
    for (const l of run.listeners) l.end();
    run.listeners.clear();
    this.hooks.onFinish?.(run);
  }

  /** Stop a run: ask the harness to stop, then drop the upstream connection. */
  cancel(id) {
    const run = this.get(id);
    if (!run) return false;
    if (run.finishedAt) return true;
    run.status = 'cancelled';
    if (run.completionId) {
      const target = new URL(`${this.agentUrl}/v1/runs/${encodeURIComponent(run.completionId)}/stop`);
      const lib = target.protocol === 'https:' ? https : http;
      const headers = { 'content-type': 'application/json' };
      if (this.agentKey) headers.authorization = `Bearer ${this.agentKey}`;
      const r = lib.request(target, { method: 'POST', headers, timeout: 5000 }, (up) => up.resume());
      r.on('error', () => {});
      r.on('timeout', () => r.destroy());
      r.end('{}');
    }
    // Closing the stream also interrupts the agent on harnesses such as Hermes.
    setTimeout(() => {
      run.upstream?.destroy();
      this.finish(run, 'cancelled');
    }, 300);
    return true;
  }

  summary(run) {
    return {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt || null,
      convId: run.meta?.convId || null,
      truncated: run.truncated,
    };
  }
}

module.exports = { RunStore };
