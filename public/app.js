/*
 * Cogitator — client logic.
 * Talks to the relay at /api/hermes/* which forwards to the Hermes Agent
 * OpenAI-compatible API server (POST /v1/chat/completions, streaming SSE).
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------
  const LS_SETTINGS = 'cogitator.settings.v1';
  const LS_ARCHIVES = 'cogitator.archives.v1';
  const LS_CURRENT = 'cogitator.current.v1';

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (err) {
        console.warn('Storage write failed', err);
        return false;
      }
    },
  };

  const DEFAULT_SETTINGS = {
    accessCode: '',
    name: 'HERMES',
    phosphor: 'green',
    ritual: false,
    system: '',
    reasoning: true,
    fx: true,
    boot: true,
  };
  let settings = { ...DEFAULT_SETTINGS, ...store.get(LS_SETTINGS, {}) };
  let archives = store.get(LS_ARCHIVES, []);
  let currentId = store.get(LS_CURRENT, null);
  let serverConfig = { authRequired: false, model: 'hermes-agent' };

  const RITUAL_PROMPT =
    'Adopt the persona of a venerable machine spirit dwelling within a sacred cogitator, addressing the user as an honoured adept. ' +
    'Open or close replies with a brief, archaic techno-religious flourish (rites, litanies, sacred unguents, the blessed motive force, praise of the Omnissiah), ' +
    'but keep the substance of every answer accurate, complete and plainly readable. Never let the persona obscure code, commands, numbers or facts.';

  const LITANIES = [
    'Reciting the Litany of Activation',
    'Applying the sacred unguents',
    'Consulting the data-archives',
    'Appeasing the machine spirit',
    'Burning votive incense',
    'Aligning the noospheric conduits',
    'Chanting the Canticle of Computation',
    'Invoking the blessed motive force',
    'Parsing the binharic cant',
    'Awaiting the Omnissiah’s favour',
  ];

  const SUGGESTIONS = [
    'Report the condition of thy host system — disk, memory and load.',
    'Summarise the latest tidings from the wider noosphere on a subject of my choosing.',
    'Remind me what rites (tools and skills) thou art able to perform.',
    'Inscribe a short script that lists the largest files in my home directory.',
  ];

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const el = {
    root: document.documentElement,
    body: document.body,
    log: $('#log'),
    input: $('#input'),
    composer: $('#composer'),
    send: $('#btn-send'),
    sendLabel: $('#btn-send .label'),
    fileInput: $('#file-input'),
    attachments: $('#attachments'),
    spiritName: $('#spirit-name'),
    linkStatus: $('#link-status'),
    drawer: $('#drawer'),
    scrim: $('#scrim'),
    archiveList: $('#archive-list'),
    settings: $('#settings'),
    settingsForm: $('#settings-form'),
  };

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ts) => {
    const d = new Date(ts);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? fmtTime(ts)
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + fmtTime(ts);
  };

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  function applySettings() {
    el.root.dataset.phosphor = settings.phosphor;
    el.root.classList.toggle('fx', !!settings.fx);
    const name = (settings.name || 'HERMES').trim() || 'HERMES';
    el.spiritName.textContent = name.toUpperCase();
    document.title = `${name} · Cogitator`;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = '#050806';
  }

  function openSettings(message) {
    $('#set-access').value = settings.accessCode;
    $('#set-name').value = settings.name;
    $('#set-phosphor').value = settings.phosphor;
    $('#set-ritual').checked = settings.ritual;
    $('#set-system').value = settings.system;
    $('#set-reasoning').checked = settings.reasoning;
    $('#set-fx').checked = settings.fx;
    $('#set-boot').checked = settings.boot;
    $('#field-access').hidden = !serverConfig.authRequired && !settings.accessCode;
    const existing = el.settingsForm.querySelector('.notice');
    if (existing) existing.remove();
    if (message) {
      el.settingsForm.insertBefore(h('p', { class: 'notice', style: 'margin:0;color:#ff8a7a' }, message), el.settingsForm.children[1]);
    }
    el.settings.showModal();
  }

  el.settings.addEventListener('close', () => {
    if (el.settings.returnValue !== 'save') return;
    settings = {
      ...settings,
      accessCode: $('#set-access').value.trim(),
      name: $('#set-name').value.trim() || 'HERMES',
      phosphor: $('#set-phosphor').value,
      ritual: $('#set-ritual').checked,
      system: $('#set-system').value.trim(),
      reasoning: $('#set-reasoning').checked,
      fx: $('#set-fx').checked,
      boot: $('#set-boot').checked,
    };
    store.set(LS_SETTINGS, settings);
    applySettings();
    renderConversation();
    checkLink();
  });

  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-purge').addEventListener('click', () => {
    if (!confirm('Purge every record from the data-archives on this device? This cannot be undone.')) return;
    archives = [];
    currentId = null;
    persist();
    el.settings.close('cancel');
    renderArchiveList();
    renderConversation();
  });

  // -------------------------------------------------------------------------
  // Archives (conversations)
  // -------------------------------------------------------------------------
  function persist() {
    // Keep storage bounded: most recent 60 conversations.
    archives.sort((a, b) => b.updated - a.updated);
    if (archives.length > 60) archives = archives.slice(0, 60);
    if (!store.set(LS_ARCHIVES, archives)) {
      // Likely quota: drop image thumbnails from older conversations and retry.
      for (const c of archives.slice(5)) for (const m of c.messages) delete m.images;
      store.set(LS_ARCHIVES, archives);
    }
    store.set(LS_CURRENT, currentId);
  }

  function current() {
    return archives.find((c) => c.id === currentId) || null;
  }

  function newConversation() {
    const conv = { id: uid(), title: 'New communion', created: Date.now(), updated: Date.now(), sessionId: null, messages: [] };
    archives.unshift(conv);
    currentId = conv.id;
    return conv;
  }

  function renderArchiveList() {
    el.archiveList.replaceChildren(
      ...archives
        .slice()
        .sort((a, b) => b.updated - a.updated)
        .map((c) =>
          h(
            'li',
            { class: c.id === currentId ? 'active' : '' },
            h(
              'button',
              {
                class: 'open',
                type: 'button',
                onclick: () => {
                  if (busy) return;
                  currentId = c.id;
                  persist();
                  closeDrawer();
                  renderConversation();
                },
              },
              h('span', { class: 't' }, c.title),
              h('span', { class: 'd' }, `${fmtDate(c.updated)} · ${c.messages.length} entries`),
            ),
            h(
              'button',
              {
                class: 'del',
                type: 'button',
                'aria-label': `Expunge ${c.title}`,
                title: 'Expunge',
                onclick: () => {
                  if (busy && c.id === currentId) return;
                  if (!confirm(`Expunge “${c.title}”?`)) return;
                  archives = archives.filter((x) => x.id !== c.id);
                  if (currentId === c.id) currentId = null;
                  persist();
                  renderArchiveList();
                  renderConversation();
                },
              },
              '✕',
            ),
          ),
        ),
    );
    if (!archives.length) el.archiveList.append(h('li', { class: 'drawer-foot' }, 'The archives are empty.'));
  }

  function openDrawer() {
    renderArchiveList();
    el.drawer.hidden = false;
    el.scrim.hidden = false;
  }
  function closeDrawer() {
    el.drawer.hidden = true;
    el.scrim.hidden = true;
  }
  $('#btn-archives').addEventListener('click', openDrawer);
  $('#btn-close-drawer').addEventListener('click', closeDrawer);
  el.scrim.addEventListener('click', closeDrawer);
  $('#btn-new').addEventListener('click', () => {
    if (busy) return;
    currentId = null;
    persist();
    closeDrawer();
    renderConversation();
    el.input.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.drawer.hidden) closeDrawer();
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function scrollToEnd(force) {
    const nearBottom = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 160;
    if (force || nearBottom) el.log.scrollTop = el.log.scrollHeight;
  }

  function entryHead(who, ts) {
    return h('div', { class: 'entry-head' }, h('span', { class: 'who' }, who), h('span', { class: 'rule' }), ts ? h('time', null, fmtTime(ts)) : null);
  }

  function spiritLabel() {
    return (settings.name || 'HERMES').toUpperCase();
  }

  function renderRites(msg) {
    if (!msg.rites || !msg.rites.length) return null;
    return h(
      'div',
      { class: 'rites' },
      msg.rites.map((r) =>
        h(
          'div',
          { class: `rite ${r.status}` },
          h('span', { class: 'state' }, r.status === 'running' ? '[ INVOKING ]' : '[ COMPLETE ]'),
          h('span', null, `${r.emoji ? r.emoji + ' ' : ''}${r.label || r.tool}`),
        ),
      ),
    );
  }

  const APPROVAL_LABELS = {
    once: 'Grant once',
    session: 'Grant for this communion',
    always: 'Grant eternally',
    deny: 'Forbid',
    expired: 'lapsed — the rite ended first',
  };

  function renderSanctions(msg) {
    if (!msg.approvals || !msg.approvals.length) return null;
    return msg.approvals.map((a) => {
      const card = h(
        'div',
        { class: 'sanction' },
        h('h4', null, '⚠ SANCTION REQUIRED'),
        h('div', { class: 'desc' }, a.description || 'The machine spirit seeks leave to perform a guarded rite.'),
        a.command ? h('pre', null, a.command) : null,
      );
      if (a.verdict) {
        card.append(h('div', { class: 'verdict' }, `Verdict rendered: ${APPROVAL_LABELS[a.verdict] || a.verdict}`));
      } else {
        const choices = (a.choices && a.choices.length ? a.choices : ['once', 'deny']).map((choice) =>
          h(
            'button',
            {
              type: 'button',
              class: `rite-btn ${choice === 'deny' ? 'danger' : 'grant'}`,
              onclick: (e) => respondApproval(msg, a, choice, e.currentTarget.parentElement),
            },
            APPROVAL_LABELS[choice] || choice,
          ),
        );
        card.append(h('div', { class: 'choices' }, choices));
      }
      return card;
    });
  }

  function renderMessage(msg, { streaming = false } = {}) {
    if (msg.role === 'user') {
      const body = h('div', { class: 'body', html: Markdown.render(msg.content) });
      if (msg.images && msg.images.length) {
        for (const src of msg.images) body.prepend(h('img', { class: 'pict', src, alt: 'Attached pict-capture' }));
      }
      return h('section', { class: 'entry user' }, entryHead('Supplicant', msg.ts), body);
    }
    if (msg.role === 'error') {
      const retry = msg.retryable
        ? h('div', { class: 'meta-line' }, h('button', { type: 'button', onclick: () => retryLast() }, '↻ Repeat the rite'))
        : null;
      return h('section', { class: 'entry error' }, entryHead('Fault', msg.ts), h('div', { class: 'body' }, msg.content), retry);
    }
    if (msg.role === 'system') {
      return h('section', { class: 'entry system' }, h('div', { class: 'body' }, msg.content));
    }

    // spirit (assistant)
    const node = h('section', { class: 'entry spirit' }, entryHead(spiritLabel(), msg.ts));
    if (settings.reasoning && msg.reasoning) {
      node.append(
        h(
          'details',
          { class: 'deliberation', open: streaming && !msg.content ? true : null },
          h('summary', null, 'Deliberations of the spirit'),
          h('div', { class: 'thought' }, msg.reasoning),
        ),
      );
    }
    const rites = renderRites(msg);
    if (rites) node.append(rites);
    if (msg.status && streaming) node.append(h('div', { class: 'status-line' }, msg.status));
    const sanctions = renderSanctions(msg);
    if (sanctions) node.append(...sanctions);

    const body = h('div', { class: 'body' + (streaming ? ' cursor' : '') });
    if (msg.content) body.innerHTML = Markdown.render(msg.content);
    else if (streaming && !msg.approvals?.some((a) => !a.verdict)) {
      body.append(h('span', { class: 'litany' }, msg.litany || LITANIES[0]));
      body.classList.remove('cursor');
    }
    node.append(body);

    if (!streaming) {
      const meta = h('div', { class: 'meta-line' });
      if (msg.content) {
        meta.append(
          h('button', { type: 'button', onclick: (e) => copyText(msg.content, e.currentTarget) }, 'Copy'),
        );
      }
      if (msg.note) meta.append(h('span', null, msg.note));
      if (meta.childNodes.length) node.append(meta);
    }
    return node;
  }

  function renderWelcome() {
    const wrap = h('div', { class: 'welcome' });
    wrap.append(
      h(
        'div',
        { class: 'boot-banner' },
        h('svg', { class: 'sigil-big', viewBox: '0 0 64 64', 'aria-hidden': 'true', html: '<use href="#cog-sigil"/>' }),
        `THE ${spiritLabel()} AWAITS`,
      ),
      h('div', { class: 'boot-sub' }, 'Speak, and the machine shall answer'),
      h(
        'div',
        { class: 'suggestions' },
        SUGGESTIONS.map((s) =>
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                el.input.value = s;
                autoGrow();
                el.input.focus();
              },
            },
            '› ' + s,
          ),
        ),
      ),
    );
    return wrap;
  }

  function renderConversation() {
    const conv = current();
    el.log.replaceChildren();
    if (!conv || !conv.messages.length) {
      el.log.append(renderWelcome());
      return;
    }
    for (const msg of conv.messages) el.log.append(renderMessage(msg));
    requestAnimationFrame(() => scrollToEnd(true));
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const old = btn.textContent;
        btn.textContent = 'Inscribed';
        setTimeout(() => (btn.textContent = old), 1200);
      }
    } catch {
      /* clipboard unavailable */
    }
  }

  el.log.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.codeblock')?.querySelector('code');
    if (code) copyText(code.textContent, btn);
  });

  // -------------------------------------------------------------------------
  // Boot sequence
  // -------------------------------------------------------------------------
  async function bootSequence() {
    const lines = [
      ['COGITATOR MK.', 'IV  // ROM VERIFIED'],
      ['MOTIVE FORCE', '........ NOMINAL'],
      ['SACRED UNGUENTS', '..... APPLIED'],
      ['LITANY OF IGNITION', '.. RECITED'],
      ['NOOSPHERIC LINK', '..... ESTABLISHING'],
      ['MACHINE SPIRIT', '...... ROUSED'],
    ];
    const pre = h('div', { class: 'boot' });
    el.log.replaceChildren(pre);
    let skip = false;
    const skipper = () => (skip = true);
    el.log.addEventListener('pointerdown', skipper, { once: true });
    for (const [a, b] of lines) {
      if (skip) break;
      const row = h('div', null, a + ' ');
      pre.append(row);
      await new Promise((r) => setTimeout(r, 120));
      row.append(h('span', { class: 'hi' }, b));
      await new Promise((r) => setTimeout(r, 140));
    }
    if (!skip) await new Promise((r) => setTimeout(r, 350));
    el.log.removeEventListener('pointerdown', skipper);
  }

  // -------------------------------------------------------------------------
  // Link status (health)
  // -------------------------------------------------------------------------
  async function checkLink() {
    try {
      const res = await fetch('/api/hermes/health', { cache: 'no-store' });
      if (res.ok) {
        el.linkStatus.className = 'link ok';
        el.linkStatus.textContent = 'Noosphere: stable';
      } else {
        throw new Error(String(res.status));
      }
    } catch {
      el.linkStatus.className = 'link down';
      el.linkStatus.textContent = navigator.onLine ? 'Spirit unresponsive' : 'Noosphere severed';
    }
  }
  setInterval(() => {
    if (document.visibilityState === 'visible') checkLink();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkLink();
  });
  window.addEventListener('online', checkLink);
  window.addEventListener('offline', checkLink);

  // -------------------------------------------------------------------------
  // Attachments (images)
  // -------------------------------------------------------------------------
  let pending = []; // { full, thumb }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Unreadable pict'));
      };
      img.src = url;
    });
  }

  function downscale(img, max, quality) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    canvas.getContext('2d').drawImage(img, 0, 0, w, hgt);
    return canvas.toDataURL('image/jpeg', quality);
  }

  el.fileInput.addEventListener('change', async () => {
    for (const file of el.fileInput.files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const img = await loadImage(file);
        pending.push({ full: downscale(img, 1568, 0.85), thumb: downscale(img, 240, 0.7) });
      } catch (err) {
        console.warn(err);
      }
    }
    el.fileInput.value = '';
    renderPending();
  });

  function renderPending() {
    el.attachments.hidden = !pending.length;
    el.attachments.replaceChildren(
      ...pending.map((p, i) =>
        h(
          'div',
          { class: 'thumb' },
          h('img', { src: p.thumb, alt: 'Pending pict-capture' }),
          h(
            'button',
            {
              type: 'button',
              'aria-label': 'Remove image',
              onclick: () => {
                pending.splice(i, 1);
                renderPending();
              },
            },
            '✕',
          ),
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------
  const coarse = window.matchMedia('(pointer: coarse)').matches;

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight + 2, window.innerHeight * 0.34) + 'px';
  }
  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) {
      e.preventDefault();
      el.composer.requestSubmit();
    }
  });

  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) {
      cease();
      return;
    }
    const text = el.input.value.trim();
    if (!text && !pending.length) return;
    el.input.value = '';
    autoGrow();
    const images = pending;
    pending = [];
    renderPending();
    transmit(text, images);
  });

  // -------------------------------------------------------------------------
  // Talking to the machine spirit
  // -------------------------------------------------------------------------
  let busy = false;
  let controller = null;
  let activeRunId = null;

  function setBusy(on) {
    busy = on;
    el.body.classList.toggle('busy', on);
    el.sendLabel.textContent = on ? 'Cease' : 'Transmit';
    el.send.setAttribute('aria-label', on ? 'Stop' : 'Transmit');
  }

  function systemPrompt() {
    const parts = [];
    if (settings.ritual) parts.push(RITUAL_PROMPT);
    if (settings.system) parts.push(settings.system);
    return parts.join('\n\n');
  }

  function authHeaders() {
    return settings.accessCode ? { 'X-Cogitator-Key': settings.accessCode } : {};
  }

  function buildMessages(conv, userMsg, fullImages) {
    const msgs = [];
    const sys = systemPrompt();
    if (sys) msgs.push({ role: 'system', content: sys });

    const toWire = (m, images) => {
      if (m.role === 'user' && images && images.length) {
        const parts = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
        return { role: 'user', content: parts };
      }
      return { role: m.role === 'spirit' ? 'assistant' : m.role, content: m.content || '' };
    };

    // With a Hermes session id, Hermes reloads history itself; send only the new turn.
    if (!conv.sessionId) {
      for (const m of conv.messages) {
        if (m === userMsg) break;
        if (m.role === 'user' || (m.role === 'spirit' && m.content)) msgs.push(toWire(m));
      }
    }
    msgs.push(toWire(userMsg, fullImages));
    return msgs;
  }

  async function transmit(text, images, { reuseUser } = {}) {
    let conv = current();
    if (!conv) conv = newConversation();

    let userMsg = reuseUser;
    if (!userMsg) {
      userMsg = { role: 'user', content: text, ts: Date.now() };
      if (images.length) userMsg.images = images.map((i) => i.thumb);
      if (!conv.messages.some((m) => m.role === 'user')) {
        const title = text || 'Pict-capture';
        conv.title = title.length > 48 ? title.slice(0, 47) + '…' : title;
      }
      conv.messages.push(userMsg);
    }
    conv.updated = Date.now();
    persist();

    if (el.log.querySelector('.welcome')) el.log.replaceChildren();
    if (!reuseUser) el.log.append(renderMessage(userMsg));

    const spirit = { role: 'spirit', content: '', reasoning: '', rites: [], approvals: [], ts: Date.now(), litany: LITANIES[Math.floor(Math.random() * LITANIES.length)] };
    let node = renderMessage(spirit, { streaming: true });
    el.log.append(node);
    scrollToEnd(true);

    let frame = 0;
    const redraw = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const fresh = renderMessage(spirit, { streaming: true });
        const openState = node.querySelector('details.deliberation')?.open;
        if (openState != null) {
          const d = fresh.querySelector('details.deliberation');
          if (d) d.open = openState;
        }
        node.replaceWith(fresh);
        node = fresh;
        scrollToEnd();
      });
    };

    let litanyTimer = setInterval(() => {
      if (spirit.content) return;
      spirit.litany = LITANIES[(LITANIES.indexOf(spirit.litany) + 1) % LITANIES.length];
      redraw();
    }, 2400);

    setBusy(true);
    controller = new AbortController();
    activeRunId = null;
    let finishReason = null;
    let hermesExtras = null;
    let failure = null;

    try {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(),
      };
      if (conv.sessionId) headers['X-Hermes-Session-Id'] = conv.sessionId;

      const res = await fetch('/api/hermes/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: serverConfig.model || 'hermes-agent',
          messages: buildMessages(conv, userMsg, images.map((i) => i.full)),
          stream: true,
        }),
        signal: controller.signal,
      });

      const sid = res.headers.get('X-Hermes-Session-Id');
      if (sid) conv.sessionId = sid;

      if (!res.ok) {
        let detail = '';
        let code = '';
        try {
          const j = await res.json();
          detail = j?.error?.message || '';
          code = j?.error?.code || '';
        } catch {
          /* not json */
        }
        if (res.status === 401 && code === 'cogitator_auth') {
          failure = { text: 'The cogitator rejects thy access cipher. Enter it in the Configuration Rites.', auth: true };
        } else if (res.status === 401) {
          failure = { text: 'The machine spirit rejected the relay’s credentials. Check HERMES_API_KEY on the server.' };
        } else if (res.status === 429) {
          failure = { text: 'The spirit is overburdened with concurrent rites. Wait, then repeat.', retryable: true };
        } else {
          failure = { text: `Rite failed (${res.status}). ${detail}`.trim(), retryable: res.status >= 500 };
        }
      } else {
        await readStream(res.body, {
          onChunk(chunk) {
            if (chunk.id && !activeRunId) activeRunId = chunk.id;
            if (chunk.hermes) hermesExtras = chunk.hermes;
            const choice = chunk.choices && chunk.choices[0];
            if (!choice) return;
            const d = choice.delta || {};
            if (d.reasoning_content) spirit.reasoning += d.reasoning_content;
            if (d.content) {
              spirit.content += d.content;
              spirit.status = '';
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
            redraw();
          },
          onEvent(name, data) {
            if (name === 'hermes.tool.progress') {
              const existing = spirit.rites.find((r) => r.toolCallId && r.toolCallId === data.toolCallId);
              if (existing) Object.assign(existing, { status: data.status || existing.status });
              else spirit.rites.push({ toolCallId: data.toolCallId, tool: data.tool, label: data.label, emoji: data.emoji, status: data.status || 'running' });
            } else if (name === 'hermes.status') {
              spirit.status = data.text || '';
            } else if (name === 'approval.request') {
              if (data.run_id) activeRunId = data.run_id;
              spirit.approvals.push({ ...data, verdict: null });
              requestAnimationFrame(() => requestAnimationFrame(() => scrollToEnd(true)));
              notify('Sanction required', data.description || data.command || 'The machine spirit awaits thy verdict.');
            }
            redraw();
          },
        });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        finishReason = 'cancelled';
      } else {
        failure = { text: `The noospheric link faltered: ${err.message}`, retryable: true };
      }
    } finally {
      clearInterval(litanyTimer);
      if (frame) cancelAnimationFrame(frame);
      controller = null;
      setBusy(false);
    }

    // Finalise
    for (const r of spirit.rites) if (r.status === 'running') r.status = 'completed';
    for (const a of spirit.approvals) if (!a.verdict) a.verdict = 'expired';
    if (finishReason === 'cancelled') spirit.note = 'Rite ceased by the supplicant';
    else if (finishReason === 'length') spirit.note = 'The spirit’s labours were cut short';
    else if (finishReason === 'error') spirit.note = 'The rite ended in fault';
    if (hermesExtras && hermesExtras.error_code && !spirit.note) spirit.note = String(hermesExtras.error_code).replace(/_/g, ' ');

    const keepSpirit = spirit.content || spirit.reasoning || spirit.rites.length || spirit.approvals.length;
    if (keepSpirit) {
      delete spirit.litany;
      delete spirit.status;
      conv.messages.push(spirit);
      const finalNode = renderMessage(spirit);
      node.replaceWith(finalNode);
      node = finalNode;
    } else {
      node.remove();
    }
    if (failure) {
      const errMsg = { role: 'error', content: failure.text, ts: Date.now(), retryable: !!failure.retryable };
      conv.messages.push(errMsg);
      el.log.append(renderMessage(errMsg));
      if (failure.auth) openSettings('Access cipher required.');
    } else if (!keepSpirit && finishReason === 'cancelled') {
      const sysMsg = { role: 'system', content: 'The rite was ceased before the spirit spoke.', ts: Date.now() };
      conv.messages.push(sysMsg);
      el.log.append(renderMessage(sysMsg));
    }
    conv.updated = Date.now();
    persist();
    scrollToEnd();

    if (document.visibilityState === 'hidden' && spirit.content) {
      notify(`${spiritLabel()} has answered`, spirit.content.slice(0, 140));
    }
  }

  async function readStream(stream, { onChunk, onEvent }) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const dispatch = (block) => {
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue; // keepalive comments
        const idx = line.indexOf(':');
        const field = idx === -1 ? line : line.slice(0, idx);
        let value = idx === -1 ? '' : line.slice(idx + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length) return;
      const payload = data.join('\n');
      if (payload === '[DONE]') return;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (event === 'message') {
        if (parsed && parsed.error) throw new Error(parsed.error.message || 'stream error');
        onChunk(parsed);
      } else {
        onEvent(event, parsed);
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        dispatch(block);
      }
    }
    if (buffer.trim()) dispatch(buffer);
  }

  async function respondApproval(msg, approval, choice, container) {
    const runId = approval.run_id || activeRunId;
    if (!runId) return;
    container.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const body = { choice };
    const reqId = approval.request_id || approval.prompt_id;
    if (reqId) body.request_id = reqId;
    if (approval.execution_generation != null) body.execution_generation = approval.execution_generation;
    try {
      const res = await fetch(`/api/hermes/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message || `status ${res.status}`);
      }
      approval.verdict = choice;
      container.replaceWith(h('div', { class: 'verdict' }, `Verdict rendered: ${APPROVAL_LABELS[choice] || choice}`));
    } catch (err) {
      container.querySelectorAll('button').forEach((b) => (b.disabled = false));
      container.append(h('div', { class: 'verdict' }, `The verdict was not received: ${err.message}`));
    }
  }

  function cease() {
    if (activeRunId) {
      fetch(`/api/hermes/v1/runs/${encodeURIComponent(activeRunId)}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: '{}',
      }).catch(() => {});
    }
    // Closing the stream also makes Hermes interrupt the agent.
    setTimeout(() => controller && controller.abort(), 150);
  }

  function retryLast() {
    if (busy) return;
    const conv = current();
    if (!conv) return;
    // drop trailing error/system entries
    while (conv.messages.length && ['error', 'system'].includes(conv.messages[conv.messages.length - 1].role)) conv.messages.pop();
    const last = conv.messages[conv.messages.length - 1];
    if (!last || last.role !== 'user') return renderConversation();
    renderConversation();
    transmit(last.content, [], { reuseUser: last });
  }

  // -------------------------------------------------------------------------
  // Notifications (only when the app is backgrounded and permission granted)
  // -------------------------------------------------------------------------
  function notify(title, body) {
    if (document.visibilityState === 'visible') return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    navigator.serviceWorker?.ready
      .then((reg) => reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'cogitator' }))
      .catch(() => {});
  }
  // Ask once, on the first transmission, so the prompt follows a user gesture.
  el.composer.addEventListener(
    'submit',
    () => {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    },
    { once: true },
  );

  // -------------------------------------------------------------------------
  // Start-up
  // -------------------------------------------------------------------------
  async function init() {
    applySettings();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
    }
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (res.ok) serverConfig = { ...serverConfig, ...(await res.json()) };
    } catch {
      /* offline */
    }

    let firstThisSession = false;
    try {
      firstThisSession = !sessionStorage.getItem('cogitator.booted');
      sessionStorage.setItem('cogitator.booted', '1');
    } catch {
      /* ignore */
    }
    if (settings.boot && firstThisSession) await bootSequence();

    renderConversation();
    checkLink();

    if (serverConfig.authRequired) {
      let ok = false;
      try {
        ok = (await fetch('/api/auth', { headers: authHeaders(), cache: 'no-store' })).ok;
      } catch {
        ok = true; // offline: don't nag
      }
      if (!ok) openSettings(settings.accessCode ? 'The access cipher was refused.' : 'This cogitator is warded. Enter the access cipher.');
    }
  }

  init();
})();
