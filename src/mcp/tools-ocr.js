'use strict';

/**
 * find_text and read_screen_text: on-device OCR of a display (src/os/ocr.js: Vision on macOS,
 * Windows.Media.Ocr on Windows and WSL, tesseract on Linux and wherever it is installed), with
 * results in the screenshot coordinates click() takes. Loaded by src/mcp/tools.js (TOOL_MODULES)
 * with the shared tool context `ext`.
 *
 * Both tools only read the screen (a region capture that never changes the coordinate mapping), so
 * they are read-only and need no pause guard. Without an OCR engine they answer isError with the
 * install hint, and the model reads the screenshot itself.
 */

const { createLogger } = require('../shared/log');

const log = createLogger('mcp-ocr');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_MAX_LINES = 300;
const MAX_LINES = 1000;
const MAX_LINE_CHARS = 300;
const MAX_OUTPUT_CHARS = 40000;
const MAX_TEXT_CHARS = 500;
const SUGGESTIONS = 3;

const DISPLAY = {
  type: 'integer',
  minimum: 0,
  maximum: 15,
  description: 'Display index, 0-based (0 = primary). Default: the display of your latest screenshot.',
};

const REGION = {
  type: 'object',
  description: 'Optional rectangle to read, in pixels of your latest full screenshot of this display (smaller is faster and catches smaller text).',
  properties: {
    x: { type: 'number', minimum: 0, description: 'Left edge.' },
    y: { type: 'number', minimum: 0, description: 'Top edge.' },
    width: { type: 'number', minimum: 1, description: 'Width.' },
    height: { type: 'number', minimum: 1, description: 'Height.' },
  },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
};

function toolError(message, code, hint) {
  const err = new Error(message);
  if (code) err.code = code;
  if (hint) err.hint = hint;
  return err;
}

function oneLine(s, max = 200) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function quote(s, max = 120) {
  return `"${oneLine(s, max).replace(/"/g, '\\"')}"`;
}

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (v == null || v === '' || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

/** Where the coordinates live, and what click needs to use them. */
function coordinateNote(scan) {
  const d = scan.display;
  const parts = [];
  if (scan.mapped) parts.push(`Coordinates are pixels of your latest screenshot of display ${d}`);
  else parts.push(`No screenshot of display ${d} has been taken yet, so coordinates are display-local screen pixels (click uses the same until you take one)`);
  if (scan.lastDisplay != null && scan.lastDisplay !== d) parts.push(`pass display: ${d} to click`);
  return `${parts.join('; ')}.`;
}

function engineLabel(scan) {
  return scan.engine === 'windows' ? 'Windows OCR' : scan.engine === 'vision' ? 'Apple Vision' : scan.engine;
}

function boxText(s) {
  return `box ${s.x},${s.y} ${s.width}x${s.height}`;
}

/** Up to SUGGESTIONS lines that share a word (or a 3-letter prefix) with the query, for a miss. */
function suggestions(ocr, lines, query) {
  const qTokens = ocr.normalizeText(query).split(' ').filter((t) => t.length >= 2);
  if (!qTokens.length) return [];
  const scored = [];
  for (const line of lines) {
    const tokens = ocr.normalizeText(line.text).split(' ');
    let score = 0;
    for (const q of qTokens) {
      if (tokens.includes(q)) score += 2;
      else if (q.length >= 3 && tokens.some((t) => t.length >= 3 && (t.startsWith(q.slice(0, 3)) || q.startsWith(t.slice(0, 3))))) score += 1;
    }
    if (score > 0) scored.push({ line, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SUGGESTIONS).map((s) => s.line);
}

function unavailable(scan, fail) {
  return fail(
    `On-screen text recognition (OCR) is not available here. ${scan.hint || ''} Take a screenshot and read the text from the image instead.`
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/**
 * @param {object} ext the shared tool context from src/mcp/tools.js (ext.deps.ocr replaces src/os/ocr.js in tests)
 * @returns {object[]} [find_text, read_screen_text]
 */
function createTools(ext = {}) {
  const { getComputer, postActivity, keepAlive, ok, fail, objectSchema, annotations } = ext;
  const deps = ext.deps || {};
  const ocr = deps.ocr || require('../os/ocr');
  const activity = typeof postActivity === 'function' ? postActivity : () => {};
  const alive = typeof keepAlive === 'function' ? keepAlive : () => () => {};
  const okText = typeof ok === 'function' ? ok : (text) => ({ content: [{ type: 'text', text }] });
  const failText = typeof fail === 'function' ? fail : (text) => ({ content: [{ type: 'text', text }], isError: true });
  const schema =
    typeof objectSchema === 'function'
      ? objectSchema
      : (properties, required = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
  const notes =
    typeof annotations === 'function'
      ? annotations
      : (title, { readOnly = false } = {}) => ({ title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true });

  async function computer() {
    if (typeof getComputer !== 'function') throw toolError('Desktop control is not available in this process.', 'UNSUPPORTED');
    return getComputer();
  }

  /** Run an OCR call with progress keep-alives; failures are reported to the activity feed and rethrown. */
  async function withOcr(name, summary, extra, fn) {
    const comp = await computer();
    const stop = alive(extra, (s) => `Reading the screen with OCR (${s} s)`);
    try {
      return await fn(comp);
    } catch (err) {
      activity({ tool: name, summary, ok: false, error: oneLine(err && err.message, 300) });
      throw err;
    } finally {
      stop();
    }
  }

  return [
    {
      name: 'find_text',
      title: 'Find text on screen',
      description: [
        'Find visible text on a display with on-device OCR and get its position, ready to click: a button, tab, link, menu item, list entry or label by its words (e.g. "For you", "ABC-123", "Create issue").',
        'Use it for apps without an accessibility tree (canvas apps, games, remote desktops, video editors, images, some Electron apps) when ui_find finds nothing, to check that something appeared, or to locate text in a big screenshot precisely. It reads the real screen at full resolution, so it also catches text too small to read in the downscaled screenshot.',
        'Returns the best matches first, each with its center (cx, cy) and box in pixels of your latest screenshot of that display, the coordinates click takes. Matching ignores case and extra spaces and tolerates one OCR slip in a word (never a different digit: ABC-123 does not match ABC-124); exact: true accepts only the whole words. A partial match ("contains") names the line it is in.',
        'No match is not proof the text is absent: it may be scrolled away, covered, too stylized, or in an image. Take a screenshot to check. Without an OCR engine the tool says how to install one; read the screenshot meanwhile.',
      ].join('\n\n'),
      inputSchema: schema(
        {
          text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_CHARS, description: 'The text to look for: a word or a phrase as shown on screen.' },
          display: DISPLAY,
          region: REGION,
          exact: { type: 'boolean', description: 'Only whole-word matches of the full text, no partial or fuzzy ones (default false).' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Most matches to return (default ${DEFAULT_LIMIT}).` },
        },
        ['text'],
      ),
      annotations: notes('Find text on screen', { readOnly: true }),
      handler: async (args = {}, extra = {}) => {
        const text = typeof args.text === 'string' ? args.text : '';
        if (!ocr.normalizeText(text)) throw toolError('text must be a non-empty string, e.g. "For you".', 'INVALID_INPUT');
        if (text.length > MAX_TEXT_CHARS) throw toolError(`text must be at most ${MAX_TEXT_CHARS} characters.`, 'INVALID_INPUT');
        const limit = clampInt(args.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
        const summary = `Find text ${quote(text, 60)}`;
        let matches;
        try {
          matches = await withOcr('find_text', summary, extra, (comp) =>
            ocr.findText(comp, { text, display: args.display, region: args.region, exact: Boolean(args.exact), limit }),
          );
        } catch (err) {
          if (!err || err.code !== 'OCR_UNAVAILABLE') throw err;
          return unavailable({ hint: err.hint }, failText);
        }
        const s = matches.scan;
        const where = `display ${s.display}${args.region ? ' (region)' : ''}`;
        if (!matches.length) {
          const near = suggestions(ocr, s.lines, text);
          const lines = [`No text matching ${quote(text)} was found on ${where} (${engineLabel(s)} read ${plural(s.lines.length, 'line')}).`];
          if (near.length) {
            lines.push(`Lines with similar words: ${near.map((l) => `${quote(l.text, 80)} at (${l.shot.cx}, ${l.shot.cy})`).join('; ')}.`);
            lines.push(coordinateNote(s));
          }
          lines.push('The text may be scrolled out of view, covered, drawn as an image or too stylized for OCR: take a screenshot to check, scroll, or try fewer or other words.');
          activity({ tool: 'find_text', summary: `${summary}: not found`, ok: true });
          return okText(lines.join('\n'));
        }
        const out = [`Found ${plural(matches.length, 'match', 'matches')} for ${quote(text)} on ${where} (${engineLabel(s)}), best first. ${coordinateNote(s)} Click the center.`];
        matches.forEach((m, i) => {
          const conf = m.confidence == null ? '' : `, confidence ${m.confidence}`;
          const inLine = m.match !== 'exact' && oneLine(m.line) !== oneLine(m.text) ? ` in line ${quote(m.line, 100)}` : '';
          out.push(`${i + 1}. ${quote(m.text, 100)} center (${m.shot.cx}, ${m.shot.cy}), ${boxText(m.shot)}, ${m.match}${conf}${inLine}`);
        });
        activity({ tool: 'find_text', summary: `${summary}: ${plural(matches.length, 'match', 'matches')}`, ok: true });
        log.debug(`find_text ${quote(text, 60)} -> ${matches.length} via ${s.engine}`);
        return okText(out.join('\n'));
      },
    },
    {
      name: 'read_screen_text',
      title: 'Read screen text',
      description: [
        'Read all visible text on a display (or a region of it) with on-device OCR, line by line in reading order, each with its center and size in pixels of your latest screenshot of that display (the coordinates click takes).',
        'Use it to read a page, list, chat, table, dialog or log as text instead of squinting at a downscaled screenshot, or to get the positions of many labels at once. Pass region to read part of the screen faster and at higher detail. For one known label, find_text is shorter.',
        'OCR can misread stylized or tiny text and does not see icons or images: take a screenshot when the layout matters.',
      ].join('\n\n'),
      inputSchema: schema({
        display: DISPLAY,
        region: REGION,
        maxLines: { type: 'integer', minimum: 1, maximum: MAX_LINES, description: `Most lines to return (default ${DEFAULT_MAX_LINES}).` },
      }),
      annotations: notes('Read screen text', { readOnly: true }),
      handler: async (args = {}, extra = {}) => {
        const maxLines = clampInt(args.maxLines, 1, MAX_LINES, DEFAULT_MAX_LINES);
        const summary = `Read screen text of display ${args.display == null ? '(current)' : args.display}`;
        const s = await withOcr('read_screen_text', summary, extra, (comp) => ocr.readScreenText(comp, { display: args.display, region: args.region }));
        if (!s.engine) {
          activity({ tool: 'read_screen_text', summary, ok: false, error: 'no OCR engine' });
          return unavailable(s, failText);
        }
        const where = `display ${s.display}${args.region ? ` region ${s.region.x},${s.region.y} ${s.region.width}x${s.region.height}` : ''}`;
        if (!s.lines.length) {
          activity({ tool: 'read_screen_text', summary: `${summary}: no text`, ok: true });
          return okText(`${engineLabel(s)} found no text on ${where}. The screen may be blank, locked or showing only images; take a screenshot to check.`);
        }
        const shown = s.lines.slice(0, maxLines);
        const out = [
          `${plural(s.lines.length, 'text line')} on ${where} (${engineLabel(s)}), in reading order. Each line: (center x, center y) width x height: text. ${coordinateNote(s)}`,
        ];
        let size = out[0].length;
        let listed = 0;
        for (const l of shown) {
          const row = `(${l.shot.cx}, ${l.shot.cy}) ${l.shot.width}x${l.shot.height}: ${oneLine(l.text, MAX_LINE_CHARS)}`;
          if (size + row.length + 1 > MAX_OUTPUT_CHARS) break;
          out.push(row);
          size += row.length + 1;
          listed++;
        }
        if (s.lines.length > listed) {
          const how = listed < shown.length ? 'pass region to read part of the screen' : 'raise maxLines or pass region to read part of the screen';
          out.push(`[${plural(s.lines.length - listed, 'more line')} not shown: ${how}.]`);
        }
        activity({ tool: 'read_screen_text', summary: `${summary}: ${plural(s.lines.length, 'line')}`, ok: true });
        return okText(out.join('\n'));
      },
    },
  ];
}

module.exports = {
  createTools,
  TOOL_NAMES: ['find_text', 'read_screen_text'],
  // helpers (exported for tests)
  coordinateNote,
  suggestions,
};
