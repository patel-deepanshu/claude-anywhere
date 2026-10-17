/**
 * Safe, dependency-free markdown for the Claude Anywhere dialog.
 *
 * The source is parsed into a small AST and then rendered either to a DOM
 * fragment (renderMarkdown, no innerHTML anywhere) or to an HTML string
 * (markdownToSafeHtml, every text and attribute value escaped). Raw HTML in
 * the input is never interpreted: it comes out as literal text. Links are
 * only emitted for http:, https: and mailto: URLs.
 *
 * Supported: fenced code blocks, inline code, bold, italic, strikethrough,
 * links and bare URLs, headings h1-h4, ordered/unordered (nested) lists, task
 * items, blockquotes, simple tables, horizontal rules and line breaks.
 */

const MAX_INPUT = 200000;
const MAX_DEPTH = 6;
const MAX_INLINE_DEPTH = 8;
const ESCAPABLE = '\\`*_{}[]()#+-.!|~<>"\'&';

const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const TABLE_SEP_RE = /^ *\|? *:?-{1,}:? *(\| *:?-{1,}:? *)*\|? *$/;

/**
 * Escape text for HTML element content and attribute values.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Return the URL when it is an absolute http(s) or mailto URL, else null.
 * Whitespace, control characters and every other scheme are rejected.
 * @param {string} raw
 * @returns {string|null}
 */
export function safeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 4096) return null;
  // Whitespace, control, zero-width and bidi-override characters (scheme and spoofing tricks).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007F-\u00A0\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/.test(s)) return null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    return /^https?:\/\/[^/?#\\]/i.test(s) ? s : null;
  }
  if (scheme === 'mailto') return s.length > 7 ? s : null;
  return null;
}

function sanitizeLang(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_+#.-]/g, '')
    .slice(0, 24);
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

function indentOf(line) {
  const m = /^ */.exec(line);
  return m ? m[0].length : 0;
}

function isBlockStart(line) {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || QUOTE_RE.test(line) || HR_RE.test(line);
}

function isOrderedMarker(marker) {
  return /\d/.test(marker);
}

// ------------------------------------------------------------------ tables

/** Split a table row on unescaped pipes that are not inside inline code. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run += 1;
      if (inCode === 0) inCode = run;
      else if (inCode === run) inCode = 0;
      cur += s.slice(i, i + run);
      i += run - 1;
      continue;
    }
    if (c === '|' && inCode === 0) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseAlign(cell) {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

// ------------------------------------------------------------------ blocks

/**
 * Parse markdown into block nodes.
 * @param {string} text
 * @returns {object[]}
 */
export function parseMarkdown(text) {
  let src = text == null ? '' : String(text);
  if (src.length > MAX_INPUT) src = `${src.slice(0, MAX_INPUT)}\n\n… (truncated)`;
  src = src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD');
  const lines = src.split('\n').map((l) => l.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
  return parseBlocks(lines, 0);
}

function parseBlocks(lines, depth) {
  const blocks = [];
  if (depth > MAX_DEPTH) {
    const t = lines.join('\n').trim();
    if (t) blocks.push({ type: 'paragraph', children: [{ type: 'text', text: t }] });
    return blocks;
  }
  let para = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: 'paragraph', children: parseInline(para.join('\n').trim(), 0, {}) });
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      flush();
      i += 1;
      continue;
    }

    let m = FENCE_RE.exec(line);
    if (m) {
      flush();
      const fence = m[1];
      const lang = sanitizeLang(m[2]);
      const closeRe = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      const body = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        if (closeRe.test(lines[i])) {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      if (!closed && body.length && isBlank(body[body.length - 1])) body.pop();
      blocks.push({ type: 'code', lang, text: body.join('\n'), closed });
      continue;
    }

    m = HEADING_RE.exec(line);
    if (m) {
      flush();
      blocks.push({ type: 'heading', level: Math.min(4, m[1].length), children: parseInline((m[2] || '').trim(), 0, {}) });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      flush();
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flush();
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(inner, depth + 1) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      const sepCells = splitRow(lines[i + 1]);
      if (sepCells.length === header.length || (header.length > 1 && lines[i + 1].includes('|'))) {
        flush();
        const cols = header.length;
        const align = [];
        for (let c = 0; c < cols; c += 1) align.push(parseAlign(sepCells[c] || ''));
        const rows = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && !isBlockStart(lines[i])) {
          const cells = splitRow(lines[i]);
          const row = [];
          for (let c = 0; c < cols; c += 1) row.push(parseInline(cells[c] || '', 0, {}));
          rows.push(row);
          i += 1;
        }
        blocks.push({ type: 'table', align, header: header.map((h) => parseInline(h, 0, {})), rows });
        continue;
      }
    }

    m = LIST_RE.exec(line);
    if (m && (m[4] !== undefined || para.length === 0)) {
      flush();
      const res = parseList(lines, i, depth);
      blocks.push(res.block);
      i = res.next;
      continue;
    }

    para.push(line);
    i += 1;
  }
  flush();
  return blocks;
}

function parseList(lines, start, depth) {
  const first = LIST_RE.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = isOrderedMarker(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m || m[1].length > baseIndent + 1 || m[1].length + 1 < baseIndent) break;
    if (isOrderedMarker(m[2]) !== ordered) break;
    const gap = m[3] ? m[3].replace(/\t/g, '    ').length : 1;
    const contentIndent = m[1].length + m[2].length + (gap > 4 ? 1 : gap);
    const itemLines = [m[4] || ''];
    i += 1;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j += 1;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
          for (let k = i; k < j; k += 1) itemLines.push('');
          i = j;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind >= contentIndent) {
        itemLines.push(l.slice(contentIndent));
        i += 1;
        continue;
      }
      if (ind > baseIndent + 1 && LIST_RE.test(l)) {
        itemLines.push(l.slice(ind));
        i += 1;
        continue;
      }
      if (LIST_RE.test(l) || isBlockStart(l)) break;
      if (!isBlank(itemLines[itemLines.length - 1])) {
        itemLines.push(l.trim());
        i += 1;
        continue;
      }
      break;
    }
    items.push(parseItem(itemLines, depth + 1));
    // Blank lines between items keep the list going when another sibling follows.
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j += 1;
    if (j > i && j < lines.length) {
      const n = LIST_RE.exec(lines[j]);
      if (n && n[1].length <= baseIndent + 1 && n[1].length + 1 >= baseIndent && isOrderedMarker(n[2]) === ordered) {
        i = j;
        continue;
      }
    }
    if (j > i) break;
  }
  return { block: { type: 'list', ordered, start: startNum, items }, next: i };
}

function parseItem(itemLines, depth) {
  let task = null;
  const firstLine = itemLines[0] || '';
  const t = /^\[([ xX])\][ \t]+/.exec(firstLine);
  if (t) {
    task = t[1] !== ' ';
    itemLines = [firstLine.slice(t[0].length), ...itemLines.slice(1)];
  }
  return { task, children: parseBlocks(itemLines, depth) };
}

// ------------------------------------------------------------------ inline

function isWordChar(c) {
  return !!c && /[\p{L}\p{N}]/u.test(c);
}

function isSpace(c) {
  return !c || /\s/.test(c);
}

/**
 * Parse a link starting at src[i] === '['.
 * @returns {{label:string, href:string, title:string, end:number}|null}
 */
function parseLinkAt(src, i) {
  let depth = 0;
  let j = i;
  const limit = Math.min(src.length, i + 2000);
  for (; j < limit; j += 1) {
    const c = src[j];
    if (c === '\\') {
      j += 1;
      continue;
    }
    if (c === '`') {
      const close = src.indexOf('`', j + 1);
      if (close !== -1 && close < limit) j = close;
      continue;
    }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) break;
    } else if (c === '\n' && src[j + 1] === '\n') return null;
  }
  if (j >= limit || src[j] !== ']' || src[j + 1] !== '(') return null;
  const label = src.slice(i + 1, j);
  let k = j + 2;
  while (src[k] === ' ') k += 1;
  let href = '';
  if (src[k] === '<') {
    const close = src.indexOf('>', k + 1);
    if (close === -1 || close - k > 4096) return null;
    href = src.slice(k + 1, close);
    if (/[\n<]/.test(href)) return null;
    k = close + 1;
  } else {
    let parens = 0;
    const s = k;
    while (k < src.length && k - s < 4096) {
      const c = src[k];
      if (c === '\\' && k + 1 < src.length) {
        k += 2;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === '(') parens += 1;
      else if (c === ')') {
        if (parens === 0) break;
        parens -= 1;
      }
      k += 1;
    }
    href = src.slice(s, k).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  while (src[k] === ' ') k += 1;
  let title = '';
  const q = src[k];
  if (q === '"' || q === "'" || q === '(') {
    const closeChar = q === '(' ? ')' : q;
    const close = src.indexOf(closeChar, k + 1);
    if (close === -1 || close - k > 1000) return null;
    title = src.slice(k + 1, close);
    k = close + 1;
    while (src[k] === ' ') k += 1;
  }
  if (src[k] !== ')') return null;
  return { label, href, title, end: k + 1 };
}

const BARE_URL_RE = /^https?:\/\/[^\s<>"'`]+/i;

function trimUrl(url) {
  let u = url.replace(/[.,;:!?'"*_~]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    while (u.endsWith(close)) {
      const opens = u.split(open).length - 1;
      const closes = u.split(close).length - 1;
      if (closes <= opens) break;
      u = u.slice(0, -1).replace(/[.,;:!?'"*_~]+$/, '');
    }
  }
  return u;
}

function parseInline(src, depth, opts) {
  const out = [];
  if (!src) return out;
  if (depth > MAX_INLINE_DEPTH) {
    out.push({ type: 'text', text: src });
    return out;
  }
  let buf = '';
  const pushText = () => {
    if (buf) {
      out.push({ type: 'text', text: buf });
      buf = '';
    }
  };
  // For each delimiter, the position after which no valid closer exists.
  const noCloser = Object.create(null);

  const findCloser = (delim, from) => {
    if (noCloser[delim] !== undefined && from >= noCloser[delim]) return -1;
    const single = delim.length === 1;
    const ch = delim[0];
    let j = from;
    while ((j = src.indexOf(delim, j)) !== -1) {
      const before = src[j - 1];
      const after = src[j + delim.length];
      let ok = !isSpace(before);
      if (ok && single && (after === ch || before === ch)) ok = false;
      if (ok && ch === '_' && isWordChar(after)) ok = false;
      if (ok && !single && after === ch && src[j + delim.length + 1] !== ch) {
        // "***" closing "**": prefer the outermost run end.
        j += 1;
        continue;
      }
      if (ok) return j;
      j += 1;
    }
    noCloser[delim] = from;
    return -1;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      pushText();
      out.push({ type: 'br' });
      i += 2;
      continue;
    }
    if (c === '\n') {
      buf = buf.replace(/ +$/, '');
      pushText();
      out.push({ type: 'br' });
      i += 1;
      while (src[i] === ' ') i += 1;
      continue;
    }

    if (c === '`') {
      let run = 1;
      while (src[i + run] === '`') run += 1;
      const fence = '`'.repeat(run);
      let j = i + run;
      let found = -1;
      while ((j = src.indexOf(fence, j)) !== -1) {
        let end = j + run;
        if (src[end] !== '`') {
          found = j;
          break;
        }
        while (src[end] === '`') end += 1;
        j = end;
      }
      if (found !== -1) {
        pushText();
        let code = src.slice(i + run, found).replace(/\n/g, ' ');
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
        out.push({ type: 'code', text: code });
        i = found + run;
        continue;
      }
      buf += fence;
      i += run;
      continue;
    }

    if (!opts.noLinks && (c === '[' || (c === '!' && src[i + 1] === '['))) {
      const isImage = c === '!';
      const link = parseLinkAt(src, isImage ? i + 1 : i);
      if (link) {
        pushText();
        const href = safeUrl(link.href);
        const labelNodes = isImage
          ? [{ type: 'text', text: link.label || link.title || 'image' }]
          : parseInline(link.label, depth + 1, { noLinks: true });
        if (href) {
          out.push({ type: 'link', href, title: link.title, children: labelNodes.length ? labelNodes : [{ type: 'text', text: href }] });
        } else {
          out.push(...labelNodes);
        }
        i = link.end;
        continue;
      }
    }

    if (!opts.noLinks && c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]{1,4000})>/i.exec(src.slice(i, i + 4100));
      if (m) {
        const href = safeUrl(m[1]);
        if (href) {
          pushText();
          out.push({ type: 'link', href, title: '', children: [{ type: 'text', text: m[1] }] });
          i += m[0].length;
          continue;
        }
      }
    }

    if (!opts.noLinks && (c === 'h' || c === 'H') && !isWordChar(src[i - 1]) && src[i - 1] !== '/') {
      const m = BARE_URL_RE.exec(src.slice(i, i + 4100));
      if (m) {
        const url = trimUrl(m[0]);
        const href = safeUrl(url);
        if (href && url.length > 8) {
          pushText();
          out.push({ type: 'link', href, title: '', children: [{ type: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
    }

    if (c === '~' && src[i + 1] === '~' && !isSpace(src[i + 2])) {
      const close = findCloser('~~', i + 3);
      if (close !== -1) {
        pushText();
        out.push({ type: 'del', children: parseInline(src.slice(i + 2, close), depth + 1, opts) });
        i = close + 2;
        continue;
      }
    }

    if (c === '*' || c === '_') {
      const leftOk = c === '*' || !isWordChar(src[i - 1]);
      const dbl = src[i + 1] === c;
      if (dbl && leftOk && !isSpace(src[i + 2]) && src[i + 2] !== c) {
        const close = findCloser(c + c, i + 3);
        if (close !== -1) {
          pushText();
          out.push({ type: 'strong', children: parseInline(src.slice(i + 2, close), depth + 1, opts) });
          i = close + 2;
          continue;
        }
      }
      if (dbl && leftOk && src[i + 2] === c && !isSpace(src[i + 3])) {
        // ***bold italic***
        const close = src.indexOf(c + c + c, i + 4);
        if (close !== -1 && !isSpace(src[close - 1])) {
          pushText();
          out.push({ type: 'strong', children: [{ type: 'em', children: parseInline(src.slice(i + 3, close), depth + 1, opts) }] });
          i = close + 3;
          continue;
        }
      }
      if (!dbl && leftOk && !isSpace(src[i + 1])) {
        const close = findCloser(c, i + 2);
        if (close !== -1) {
          pushText();
          out.push({ type: 'em', children: parseInline(src.slice(i + 1, close), depth + 1, opts) });
          i = close + 1;
          continue;
        }
      }
      // Literal run of delimiters.
      let run = 1;
      while (src[i + run] === c) run += 1;
      buf += src.slice(i, i + run);
      i += run;
      continue;
    }

    buf += c;
    i += 1;
  }
  pushText();
  return out;
}

// ------------------------------------------------------------------ HTML renderer

function inlineToHtml(nodes) {
  let s = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        s += escapeHtml(n.text);
        break;
      case 'br':
        s += '<br>';
        break;
      case 'code':
        s += `<code>${escapeHtml(n.text)}</code>`;
        break;
      case 'strong':
        s += `<strong>${inlineToHtml(n.children)}</strong>`;
        break;
      case 'em':
        s += `<em>${inlineToHtml(n.children)}</em>`;
        break;
      case 'del':
        s += `<del>${inlineToHtml(n.children)}</del>`;
        break;
      case 'link':
        s += `<a href="${escapeHtml(n.href)}"${n.title ? ` title="${escapeHtml(n.title)}"` : ''} target="_blank" rel="noopener noreferrer">${inlineToHtml(n.children)}</a>`;
        break;
      default:
        break;
    }
  }
  return s;
}

function blocksToHtml(blocks) {
  let s = '';
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        s += `<p>${inlineToHtml(b.children)}</p>`;
        break;
      case 'heading':
        s += `<h${b.level}>${inlineToHtml(b.children)}</h${b.level}>`;
        break;
      case 'hr':
        s += '<hr>';
        break;
      case 'code':
        s += b.lang
          ? `<pre data-lang="${escapeHtml(b.lang)}"><code class="language-${escapeHtml(b.lang)}">${escapeHtml(b.text)}</code></pre>`
          : `<pre><code>${escapeHtml(b.text)}</code></pre>`;
        break;
      case 'blockquote':
        s += `<blockquote>${blocksToHtml(b.children)}</blockquote>`;
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 && Number.isInteger(b.start) ? ` start="${b.start}"` : '';
        s += `<${tag}${start}>`;
        for (const item of b.items) {
          s += item.task === null ? '<li>' : `<li class="task${item.task ? ' done' : ''}">${item.task ? '☑' : '☐'} `;
          s += itemBodyHtml(item.children);
          s += '</li>';
        }
        s += `</${tag}>`;
        break;
      }
      case 'table': {
        const al = (i) => (b.align[i] ? ` class="al-${b.align[i]}"` : '');
        s += '<div class="md-table"><table><thead><tr>';
        b.header.forEach((cell, i) => {
          s += `<th${al(i)}>${inlineToHtml(cell)}</th>`;
        });
        s += '</tr></thead><tbody>';
        for (const row of b.rows) {
          s += '<tr>';
          row.forEach((cell, i) => {
            s += `<td${al(i)}>${inlineToHtml(cell)}</td>`;
          });
          s += '</tr>';
        }
        s += '</tbody></table></div>';
        break;
      }
      default:
        break;
    }
  }
  return s;
}

function itemBodyHtml(children) {
  if (children.length && children[0].type === 'paragraph') {
    return inlineToHtml(children[0].children) + blocksToHtml(children.slice(1));
  }
  return blocksToHtml(children);
}

/**
 * Render markdown to an HTML string in which all input text is escaped.
 * @param {string} text untrusted markdown
 * @returns {string}
 */
export function markdownToSafeHtml(text) {
  return blocksToHtml(parseMarkdown(text));
}

// ------------------------------------------------------------------ DOM renderer

function el(doc, tag, attrs) {
  const e = doc.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== '') e.setAttribute(k, String(v));
  return e;
}

function inlineToDom(doc, parent, nodes) {
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        parent.appendChild(doc.createTextNode(n.text));
        break;
      case 'br':
        parent.appendChild(doc.createElement('br'));
        break;
      case 'code': {
        const e = doc.createElement('code');
        e.appendChild(doc.createTextNode(n.text));
        parent.appendChild(e);
        break;
      }
      case 'strong':
      case 'em':
      case 'del': {
        const e = doc.createElement(n.type);
        inlineToDom(doc, e, n.children);
        parent.appendChild(e);
        break;
      }
      case 'link': {
        const href = safeUrl(n.href);
        if (!href) {
          inlineToDom(doc, parent, n.children);
          break;
        }
        const e = el(doc, 'a', { href, title: n.title || undefined, target: '_blank', rel: 'noopener noreferrer' });
        inlineToDom(doc, e, n.children);
        parent.appendChild(e);
        break;
      }
      default:
        break;
    }
  }
}

function blocksToDom(doc, parent, blocks) {
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph': {
        const p = doc.createElement('p');
        inlineToDom(doc, p, b.children);
        parent.appendChild(p);
        break;
      }
      case 'heading': {
        const h = doc.createElement(`h${b.level}`);
        inlineToDom(doc, h, b.children);
        parent.appendChild(h);
        break;
      }
      case 'hr':
        parent.appendChild(doc.createElement('hr'));
        break;
      case 'code': {
        const pre = el(doc, 'pre', { 'data-lang': b.lang || undefined });
        const code = el(doc, 'code', { class: b.lang ? `language-${b.lang}` : undefined });
        code.appendChild(doc.createTextNode(b.text));
        pre.appendChild(code);
        parent.appendChild(pre);
        break;
      }
      case 'blockquote': {
        const q = doc.createElement('blockquote');
        blocksToDom(doc, q, b.children);
        parent.appendChild(q);
        break;
      }
      case 'list': {
        const list = el(doc, b.ordered ? 'ol' : 'ul', {
          start: b.ordered && b.start !== 1 && Number.isInteger(b.start) ? b.start : undefined,
        });
        for (const item of b.items) {
          const li = el(doc, 'li', { class: item.task === null ? undefined : `task${item.task ? ' done' : ''}` });
          if (item.task !== null) li.appendChild(doc.createTextNode(`${item.task ? '☑' : '☐'} `));
          const kids = item.children;
          if (kids.length && kids[0].type === 'paragraph') {
            inlineToDom(doc, li, kids[0].children);
            blocksToDom(doc, li, kids.slice(1));
          } else {
            blocksToDom(doc, li, kids);
          }
          list.appendChild(li);
        }
        parent.appendChild(list);
        break;
      }
      case 'table': {
        const wrap = el(doc, 'div', { class: 'md-table' });
        const table = doc.createElement('table');
        const thead = doc.createElement('thead');
        const htr = doc.createElement('tr');
        b.header.forEach((cell, i) => {
          const th = el(doc, 'th', { class: b.align[i] ? `al-${b.align[i]}` : undefined });
          inlineToDom(doc, th, cell);
          htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);
        const tbody = doc.createElement('tbody');
        for (const row of b.rows) {
          const tr = doc.createElement('tr');
          row.forEach((cell, i) => {
            const td = el(doc, 'td', { class: b.align[i] ? `al-${b.align[i]}` : undefined });
            inlineToDom(doc, td, cell);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        parent.appendChild(wrap);
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Render untrusted markdown into a DocumentFragment built with createElement
 * and text nodes only (no innerHTML).
 * @param {string} text
 * @param {Document} [doc] defaults to the global document
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  blocksToDom(doc, frag, parseMarkdown(text));
  return frag;
}
