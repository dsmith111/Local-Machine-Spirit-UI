/*
 * Push subscriptions, device presence, and the rules for when to notify.
 *
 * A device is "watching" while the app is visible on it (it reports this on
 * every visibility change). Nobody is notified about a run they are watching.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadOrCreateVapidKeys, sendPush } = require('./webpush');

const DEFAULT_PREFS = { answers: true, sanctions: true, faults: true, proclamations: true, previews: true };
const PRESENCE_STALE_MS = 3 * 60 * 1000; // a "visible" report older than this no longer counts

function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/[`"'*_]{0,3}MEDIA:\s*\S+/g, ' [pict-capture] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [pict-capture] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S.*?)[*_](?=[\s.,;:!?)]|$)/gm, '$1$2')
    .replace(/^\|.*\|$/gm, (row) => row.replace(/\|/g, ' ').replace(/-{3,}/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text, n) {
  return text.length > n ? text.slice(0, n - 1).trimEnd() + '…' : text;
}

class Notifier {
  constructor({ dataDir, subject, log = console }) {
    this.log = log;
    this.subject = subject;
    fs.mkdirSync(dataDir, { recursive: true });
    this.keys = loadOrCreateVapidKeys(path.join(dataDir, 'vapid.json'));
    this.subsFile = path.join(dataDir, 'subscriptions.json');
    this.subs = this.load();
    this.presence = new Map(); // clientId -> { visible, at }
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(this.subsFile, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  save() {
    const tmp = this.subsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.subs, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.subsFile);
  }

  get publicKey() {
    return this.keys.publicKey;
  }

  subscribe(subscription, clientId, prefs) {
    if (!subscription || typeof subscription.endpoint !== 'string' || !/^https?:\/\//.test(subscription.endpoint)) {
      throw new Error('invalid subscription');
    }
    if (!subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) throw new Error('subscription has no keys');
    const entry = {
      endpoint: subscription.endpoint,
      keys: { p256dh: String(subscription.keys.p256dh), auth: String(subscription.keys.auth) },
      clientId: String(clientId || '').slice(0, 64),
      prefs: { ...DEFAULT_PREFS, ...this.cleanPrefs(prefs) },
      updatedAt: Date.now(),
    };
    this.subs = this.subs.filter((s) => s.endpoint !== entry.endpoint);
    this.subs.push(entry);
    this.save();
    return entry;
  }

  cleanPrefs(prefs) {
    const out = {};
    for (const k of Object.keys(DEFAULT_PREFS)) if (prefs && typeof prefs[k] === 'boolean') out[k] = prefs[k];
    return out;
  }

  unsubscribe(endpoint) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
    return before !== this.subs.length;
  }

  setPresence(clientId, visible) {
    if (!clientId) return;
    this.presence.set(String(clientId).slice(0, 64), { visible: !!visible, at: Date.now() });
  }

  isWatching(clientId) {
    const p = clientId && this.presence.get(clientId);
    return !!(p && p.visible && Date.now() - p.at < PRESENCE_STALE_MS);
  }

  async send(kind, build) {
    const pref = { answer: 'answers', sanction: 'sanctions', fault: 'faults', proclamation: 'proclamations' }[kind];
    const targets = this.subs.filter((s) => s.prefs[pref] !== false && !this.isWatching(s.clientId));
    await Promise.all(targets.map((s) => this.deliver(s, build(s.prefs))));
  }

  async deliver(sub, payload) {
    const result = await sendPush(sub, payload, { keys: this.keys, subject: this.subject, urgency: payload.kind === 'sanction' ? 'high' : 'normal' });
    if (result.status === 404 || result.status === 410) {
      this.log.log(`    push: subscription expired, removing (${new URL(sub.endpoint).host})`);
      this.unsubscribe(sub.endpoint);
    } else if (!(result.status >= 200 && result.status < 300)) {
      this.log.warn(`    push: delivery to ${new URL(sub.endpoint).host} failed (${result.status || result.error}) ${result.body || ''}`);
    }
    return result;
  }

  // ---- events from the run store -------------------------------------------------

  onApproval(run, data) {
    if (this.anyoneWatchingRun(run)) return;
    // Commands are shown verbatim (only whitespace collapsed), never Markdown-stripped.
    const what = [data.description, data.command].filter(Boolean).join(': ').replace(/\s+/g, ' ').trim();
    this.send('sanction', (prefs) => ({
      kind: 'sanction',
      title: '⚠ Sanction required',
      body: prefs.previews && what ? clip(what, 160) : 'The machine spirit awaits thy verdict.',
      tag: `sanction-${run.id}`,
      convId: run.meta?.convId || null,
      runId: run.id,
    })).catch((err) => this.log.warn('    push error', err.message));
  }

  onFinish(run) {
    if (run.status === 'cancelled') return; // you pressed Cease; no need to tell you
    if (this.anyoneWatchingRun(run)) return;
    const name = run.meta?.spiritName || 'The machine spirit';
    const failed = run.status === 'failed';
    this.send(failed ? 'fault' : 'answer', (prefs) => {
      const preview = clip(stripMarkdown(failed ? run.errorText : run.content), 160);
      return {
        kind: failed ? 'fault' : 'answer',
        title: failed ? 'The rite ended in fault' : `${name} has answered`,
        body: prefs.previews && preview ? preview : failed ? 'Open the cogitator for details.' : 'Thy answer awaits in the cogitator.',
        tag: `conv-${run.meta?.convId || run.id}`,
        convId: run.meta?.convId || null,
        runId: run.id,
      };
    }).catch((err) => this.log.warn('    push error', err.message));
  }

  onProclamation(item) {
    const fromGuest = item.source === 'envoy';
    this.send('proclamation', (prefs) => {
      // Envoy bodies end with a "---" context block (what the guest asked); preview only the message.
      const preview = clip(stripMarkdown(item.body.split(/\n-{3,}\n/)[0]), 160);
      return {
        kind: 'proclamation',
        title: fromGuest ? `✉ ${item.title || 'A message for thee'}` : `⚜ ${item.title || 'Proclamation from the machine spirit'}`,
        body: prefs.previews && preview ? preview : 'A proclamation awaits in the cogitator.',
        tag: `proc-${item.id}`,
        convId: '__proclamations__',
      };
    }).catch((err) => this.log.warn('    push error', err.message));
  }

  /** The device that started the run is watching it with the app open. */
  anyoneWatchingRun(run) {
    return run.listeners.size > 0 && this.isWatching(run.meta?.clientId);
  }

  async test(endpoint) {
    const sub = this.subs.find((s) => s.endpoint === endpoint);
    if (!sub) return { status: 404, error: 'not subscribed' };
    return this.deliver(sub, {
      kind: 'test',
      title: '+++ Test transmission +++',
      body: 'The noospheric link holds. Thou shalt be summoned when the spirit speaks.',
      tag: 'test',
    });
  }
}

module.exports = { Notifier, stripMarkdown, DEFAULT_PREFS };
