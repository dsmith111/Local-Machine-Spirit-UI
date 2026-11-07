/*
 * A small, safe Markdown renderer for machine-spirit output.
 * All text is HTML-escaped first; only a fixed set of tags is generated.
 * Supports: fenced code (incl. unterminated while streaming), inline code,
 * headings, bold/italic/strike, links (http/https/mailto only), lists,
 * blockquotes, horizontal rules and pipe tables.
 */
(function () {
  'use strict';

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function inline(text) {
    // text is already escaped
    const codes = [];
    let out = text.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = out
      .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, (_, label, url) =>
        `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, url) =>
        `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }

  function renderBlocks(src) {
    const lines = src.split('\n');
    const html = [];
    let i = 0;
    let para = [];

    const flushPara = () => {
      if (para.length) {
        html.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
      }
    };

    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();

      // code placeholder on its own line
      const ph = t.match(/^\u0001(\d+)\u0001$/);
      if (ph) { flushPara(); html.push(`\u0001${ph[1]}\u0001`); i++; continue; }

      if (!t) { flushPara(); i++; continue; }

      let m;
      if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
        flushPara();
        const level = Math.min(m[1].length, 4);
        html.push(`<h${level}>${inline(m[2])}</h${level}>`);
        i++; continue;
      }
      if (/^([-*_])(\s*\1){2,}$/.test(t)) { flushPara(); html.push('<hr>'); i++; continue; }

      // table
      if (t.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flushPara();
        const head = splitRow(t);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().includes('|')) { rows.push(splitRow(lines[i])); i++; }
        html.push('<div class="table-wrap"><table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') +
          '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>');
        continue;
      }

      if (t.startsWith('&gt;')) {
        flushPara();
        const quote = [];
        while (i < lines.length && lines[i].trim().startsWith('&gt;')) {
          quote.push(lines[i].trim().replace(/^&gt;\s?/, ''));
          i++;
        }
        html.push(`<blockquote>${renderBlocks(quote.join('\n'))}</blockquote>`);
        continue;
      }

      const ul = /^\s*[-*+]\s+(.*)$/;
      const ol = /^\s*\d+[.)]\s+(.*)$/;
      if (ul.test(line) || ol.test(line)) {
        flushPara();
        const ordered = ol.test(line) && !ul.test(line);
        const re = ordered ? ol : ul;
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          if (re.test(l)) { items.push(l.match(re)[1]); i++; continue; }
          // continuation line (indented, non-empty)
          if (l.trim() && /^\s{2,}/.test(l) && items.length && !ul.test(l) && !ol.test(l)) {
            items[items.length - 1] += '\n' + l.trim(); i++; continue;
          }
          // nested list items: flatten with indentation marker
          if ((ul.test(l) || ol.test(l)) && /^\s{2,}/.test(l)) { items.push(l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')); i++; continue; }
          break;
        }
        const tag = ordered ? 'ol' : 'ul';
        html.push(`<${tag}>` + items.map((it) => `<li>${it.split('\n').map(inline).join('<br>')}</li>`).join('') + `</${tag}>`);
        continue;
      }

      para.push(line);
      i++;
    }
    flushPara();
    return html.join('');
  }

  function render(src) {
    if (!src) return '';
    const blocks = [];
    // Fenced code blocks, including an unterminated trailing block (streaming).
    let text = src.replace(/\r\n/g, '\n').replace(/(^|\n)```([^\n`]*)\n([\s\S]*?)(?:\n```[ \t]*(?=\n|$)|$)/g, (_, pre, lang, code) => {
      blocks.push({ lang: lang.trim(), code });
      return `${pre}\n\u0001${blocks.length - 1}\u0001\n`;
    });
    text = escapeHtml(text);
    let html = renderBlocks(text);
    html = html.replace(/\u0001(\d+)\u0001/g, (_, idx) => {
      const b = blocks[Number(idx)];
      const lang = escapeHtml(b.lang || 'data');
      return `<div class="codeblock"><div class="lang"><span>${lang}</span><button type="button" class="copy-btn" data-copy>Copy</button></div><pre><code>${escapeHtml(b.code)}</code></pre></div>`;
    });
    return html;
  }

  window.Markdown = { render, escapeHtml };
})();
