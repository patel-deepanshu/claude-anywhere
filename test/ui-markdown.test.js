'use strict';

/**
 * Tests for the dialog UI (src/ui): the markdown sanitizer, the pure voice
 * and WAV helpers, static checks on the page (CSP-safe, no inline script,
 * every referenced element and icon exists), and the UI stub server.
 *
 * src/ui holds browser ES modules; they are copied into a temp directory
 * with {"type":"module"} so dynamic import() works on every Node >= 18.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');

const UI = path.join(__dirname, '..', 'src', 'ui');
const STUB = path.join(__dirname, 'fixtures', 'ui-stub-server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-ui-test-'));
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}\n');
for (const f of fs.readdirSync(UI)) if (f.endsWith('.js')) fs.copyFileSync(path.join(UI, f), path.join(TMP, f));

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const load = (name) => import(pathToFileURL(path.join(TMP, name)).href);

// ------------------------------------------------------------------ HTML invariants

const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div']);
const ALLOWED_ATTRS = new Set(['href', 'title', 'target', 'rel', 'class', 'start', 'data-lang']);

/** Assert sanitizer output only holds allowlisted tags, attributes and URL schemes. */
function assertSafe(html, input) {
  const ctx = `input: ${JSON.stringify(input).slice(0, 200)}\noutput: ${html.slice(0, 400)}`;
  // Every "<" that starts markup must be one of our tags; everything else was escaped.
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>/g;
  const stripped = html.replace(tagRe, (m, tag, attrs) => {
    assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `unexpected tag <${tag}>\n${ctx}`);
    const attrRe = /\s+([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = attrRe.exec(attrs))) {
      const name = a[1].toLowerCase();
      assert.ok(ALLOWED_ATTRS.has(name), `unexpected attribute ${name}\n${ctx}`);
      assert.ok(!/^on/.test(name), `event handler attribute\n${ctx}`);
      if (name === 'href') {
        const v = a[2].replace(/&amp;/g, '&');
        assert.match(v, /^(https?:\/\/|mailto:)/i, `unsafe href ${v}\n${ctx}`);
      }
      if (a[2] !== undefined) assert.ok(!/[<>"]/.test(a[2]), `unescaped attribute value\n${ctx}`);
    }
    return '';
  });
  assert.ok(!/[<>]/.test(stripped), `raw angle bracket survived\n${ctx}`);
  assert.ok(!/javascript:/i.test(html.match(/href="[^"]*"/g)?.join(' ') || ''), `javascript: href\n${ctx}`);
}

const MALICIOUS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<style>body{display:none}</style>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click]( javascript:alert(1))',
  '[click](java\tscript:alert(1))',
  '[click](java&#x09;script:alert(1))',
  '[click](javascript&#58;alert(1))',
  '[click](&#106;avascript:alert(1))',
  '[click](\u0001javascript:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[click](vbscript:msgbox(1))',
  '[click](file:///etc/passwd)',
  '[click](//evil.example)',
  '[click](/relative/path)',
  '[click](#anchor)',
  '[click](<javascript:alert(1)>)',
  '<javascript:alert(1)>',
  '<https://ok.example" onmouseover="alert(1)>',
  '[a](https://x.example/"onmouseover="alert(1))',
  '[a](https://x.example "t" onmouseover="alert(1)")',
  '[a](https://x.example "t\\" onmouseover=\\"alert(1)")',
  "[a](https://x.example 'q\" onmouseover=\"alert(1)')",
  '[<img src=x onerror=alert(1)>](https://ok.example)',
  '[**<i onclick=alert(1)>bold</i>**](https://ok.example)',
  '![x" onerror="alert(1)](https://ok.example/a.png)',
  '![x](javascript:alert(1))',
  '**<b onmouseover=alert(1)>x</b>**',
  '*<em>*</em>*',
  '_<u>_x</u>_',
  '~~<s onclick=alert(1)>x</s>~~',
  '`<script>alert(1)</script>`',
  '```html\n</code></pre><script>alert(1)</script>\n```',
  '```"><script>alert(1)</script>\ncode\n```',
  '```js" onclick="alert(1)\nx\n```',
  '# <img src=x onerror=alert(1)>',
  '> <script>alert(1)</script>',
  '- <script>alert(1)</script>\n- [x](javascript:alert(1))',
  '| a | <b onclick=alert(1)>b</b> |\n|---|---|\n| <img src=x onerror=alert(1)> | `<x>` |',
  'https://ok.example/"><script>alert(1)</script>',
  'http://ok.example/<script>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#60;script&#62;',
  '<!-- comment --><script>',
  '<![CDATA[<script>]]>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '[x](https://ok.example)<script>',
  '[x](https://ok.example‮gnp.exe)',
  '[x](https://ok​.example)',
  '\u0000<script>\u0000',
  '[' + '['.repeat(200) + 'x](https://ok.example)' + ']'.repeat(200),
  '<' + 'a '.repeat(500) + '>',
];

test('markdown: malicious inputs only produce allowlisted markup', async () => {
  const { markdownToSafeHtml } = await load('markdown.js');
  for (const input of MALICIOUS) {
    const html = markdownToSafeHtml(input);
    assertSafe(html, input);
  }
});

test('markdown: script tags and handlers are escaped as text', async () => {
  const { markdownToSafeHtml } = await load('markdown.js');
  assert.equal(markdownToSafeHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(markdownToSafeHtml('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(markdownToSafeHtml('**<b onmouseover=alert(1)>x</b>**'), '<p><strong>&lt;b onmouseover=alert(1)&gt;x&lt;/b&gt;</strong></p>');
  // Entities in the source are shown literally, never decoded into markup.
  assert.equal(markdownToSafeHtml('&lt;script&gt;'), '<p>&amp;lt;script&amp;gt;</p>');
  assert.equal(markdownToSafeHtml('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
});

test('markdown: unsafe link schemes render as plain text', async () => {
  const { markdownToSafeHtml } = await load('markdown.js');
  for (const href of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//evil.example', '/x', '#x', 'ftp://x.example']) {
    const html = markdownToSafeHtml(`[click me](${href})`);
    assert.ok(!html.includes('<a '), `${href} → ${html}`);
    assert.ok(html.includes('click me'), html);
  }
  assert.equal(markdownToSafeHtml('<javascript:alert(1)>'), '<p>&lt;javascript:alert(1)&gt;</p>');
});

test('markdown: safe links get target and rel, and attribute values are escaped', async () => {
  const { markdownToSafeHtml, safeUrl } = await load('markdown.js');
  assert.equal(
    markdownToSafeHtml('[Docs](https://cloud.google.com/run "Cloud Run")'),
    '<p><a href="https://cloud.google.com/run" title="Cloud Run" target="_blank" rel="noopener noreferrer">Docs</a></p>'
  );
  assert.equal(markdownToSafeHtml('[mail](mailto:dev@example.com)'), '<p><a href="mailto:dev@example.com" target="_blank" rel="noopener noreferrer">mail</a></p>');
  const tricky = markdownToSafeHtml('[a](https://x.example/"onmouseover="alert(1))');
  assert.ok(tricky.includes('href="https://x.example/&quot;onmouseover=&quot;alert(1)"'), tricky);
  assert.equal(safeUrl('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&c=2');
  assert.equal(safeUrl('  https://example.com  '), 'https://example.com');
  assert.equal(safeUrl('https://'), null);
  assert.equal(safeUrl('https://a.example‮'), null);
  assert.equal(safeUrl('mailto:'), null);
  assert.equal(safeUrl(42), null);
});

test('markdown: bare and angle-bracket URLs are linked, trailing punctuation is not', async () => {
  const { markdownToSafeHtml } = await load('markdown.js');
  const html = markdownToSafeHtml('Live at https://shop-api-abc-uc.a.run.app. See (https://example.com/x_(y)) and <https://a.example/b>!');
  assert.ok(html.includes('<a href="https://shop-api-abc-uc.a.run.app" target="_blank"'), html);
  assert.ok(html.includes('>https://shop-api-abc-uc.a.run.app</a>.'), html);
  assert.ok(html.includes('<a href="https://example.com/x_(y)"'), html);
  assert.ok(html.includes('<a href="https://a.example/b"'), html);
  assert.ok(!markdownToSafeHtml('see xhttps://nope.example').includes('<a '));
});

test('markdown: headings, emphasis, code, rules and line breaks', async () => {
  const { markdownToSafeHtml } = await load('markdown.js');
  assert.equal(markdownToSafeHtml('# One\n## Two\n### Three\n#### Four\n##### Five'), '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h4>Five</h4>');
  assert.equal(markdownToSafeHtml('#hashtag'), '<p>#hashtag</p>');
  assert.equal(
    markdownToSafeHtml('**bold** *it* _also_ ***both*** ~~gone~~ `code`'),
    '<p><strong>bold</strong> <em>it</em> <em>also</em> <strong><em>both</em></strong> <del>gone</del> <code>code</code></p>'
  );
  assert.equal(markdownToSafeHtml('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>');
  assert.equal(markdownToSafeHtml('\\*not italic\\*'), '<p>*not italic*</p>');
  assert.equal(markdownToSafeHtml('line one\nline two'), '<p>line one<br>line two</p>');
  assert.equal(markdownToSafeHtml('a\n\nb'), '<p>a</p><p>b</p>');
  assert.equal(markdownToSafeHtml('---'), '<hr>');
  assert.equal(markdownToSafeHtml('``a ` b``'), '<p><code>a ` b</code></p>');
  assert.equal(markdownToSafeHtml(''), '');
  assert.equal(markdownToSafeHtml(null), '');
  assert.equal(markdownToSafeHtml(undefined), '');
  assert.equal(markdownToSafeHtml(42), '<p>42</p>');
});

test('markdown: fenced code blocks keep text verbatim and expose the language', async () => {
  const { markdownToSafeHtml } = await load('markdown.js');
  assert.equal(
    markdownToSafeHtml('```js\nconst a = 1 < 2 && "x";\n  indented\n```'),
    '<pre data-lang="js"><code class="language-js">const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;\n  indented</code></pre>'
  );
  assert.equal(markdownToSafeHtml('~~~\n**not bold**\n~~~'), '<pre><code>**not bold**</code></pre>');
  // While streaming, an unclosed fence still renders as code.
  assert.equal(markdownToSafeHtml('Run:\n```bash\ngcloud run deploy\n'), '<p>Run:</p><pre data-lang="bash"><code class="language-bash">gcloud run deploy</code></pre>');
});

test('markdown: ordered, unordered, nested and task lists', async () => {
  const { markdownToSafeHtml } = await load('markdown.js');
  assert.equal(markdownToSafeHtml('- a\n- b\n* c'), '<ul><li>a</li><li>b</li><li>c</li></ul>');
  assert.equal(markdownToSafeHtml('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(
    markdownToSafeHtml('1. Check auth\n   - gcloud\n   - aws\n2. Deploy'),
    '<ol><li>Check auth<ul><li>gcloud</li><li>aws</li></ul></li><li>Deploy</li></ol>'
  );
  assert.equal(
    markdownToSafeHtml('1. Run:\n   ```bash\n   npm test\n   ```\n2. Done'),
    '<ol><li>Run:<pre data-lang="bash"><code class="language-bash">npm test</code></pre></li><li>Done</li></ol>'
  );
  assert.equal(markdownToSafeHtml('- a\n\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(markdownToSafeHtml('Steps:\n- one'), '<p>Steps:</p><ul><li>one</li></ul>');
  assert.equal(markdownToSafeHtml('- [ ] todo\n- [x] done'), '<ul><li class="task">☐ todo</li><li class="task done">☑ done</li></ul>');
  assert.equal(markdownToSafeHtml('- a\n- b\n\nAfter'), '<ul><li>a</li><li>b</li></ul><p>After</p>');
});

test('markdown: blockquotes and tables', async () => {
  const { markdownToSafeHtml } = await load('markdown.js');
  assert.equal(markdownToSafeHtml('> quoted\n> **more**'), '<blockquote><p>quoted<br><strong>more</strong></p></blockquote>');
  assert.equal(
    markdownToSafeHtml('| Name | Cost |\n|:-----|-----:|\n| `run` | $1 |\n| a \\| b | |'),
    '<div class="md-table"><table><thead><tr><th class="al-left">Name</th><th class="al-right">Cost</th></tr></thead>' +
      '<tbody><tr><td class="al-left"><code>run</code></td><td class="al-right">$1</td></tr>' +
      '<tr><td class="al-left">a | b</td><td class="al-right"></td></tr></tbody></table></div>'
  );
  assert.equal(markdownToSafeHtml('a | b\n---'), '<p>a | b</p><hr>');
});

test('markdown: pathological input stays fast', async () => {
  const { markdownToSafeHtml } = await load('markdown.js');
  const inputs = ['**a '.repeat(30000), '['.repeat(20000), '*'.repeat(100000), '_a '.repeat(30000), '`'.repeat(50000), '> '.repeat(5000) + 'x', '- '.repeat(3000) + 'x', '[a](' + '('.repeat(20000), 'x'.repeat(300000)];
  const t0 = Date.now();
  for (const s of inputs) markdownToSafeHtml(s);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.ok(markdownToSafeHtml('y'.repeat(300000)).includes('(truncated)'));
});

/** Minimal DOM: just what renderMarkdown may use, and innerHTML is a trap. */
function fakeDocument() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const VOID = new Set(['br', 'hr']);
  const node = (tag) => {
    const n = {
      tag,
      attrs: [],
      kids: [],
      setAttribute(k, v) {
        const i = this.attrs.findIndex((a) => a[0] === k);
        if (i >= 0) this.attrs[i][1] = String(v);
        else this.attrs.push([k, String(v)]);
      },
      appendChild(c) {
        this.kids.push(c);
        return c;
      },
      toHtml() {
        if (this.tag === '#text') return esc(this.text);
        const inner = this.kids.map((k) => k.toHtml()).join('');
        if (this.tag === '#frag') return inner;
        const attrs = this.attrs.map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
        return VOID.has(this.tag) ? `<${this.tag}${attrs}>` : `<${this.tag}${attrs}>${inner}</${this.tag}>`;
      },
    };
    Object.defineProperty(n, 'innerHTML', {
      set() {
        throw new Error('innerHTML must not be used');
      },
    });
    return n;
  };
  return {
    createElement: (t) => node(t),
    createTextNode: (t) => Object.assign(node('#text'), { text: t }),
    createDocumentFragment: () => node('#frag'),
  };
}

test('markdown: renderMarkdown builds the same tree as markdownToSafeHtml, without innerHTML', async () => {
  const { markdownToSafeHtml, renderMarkdown } = await load('markdown.js');
  const samples = [
    "# Plan\n\nI'll deploy **shop-api** to *Cloud Run*:\n\n1. Check `gcloud`\n   - auth\n2. Deploy\n\n```bash\ngcloud run deploy --source .\n```\n\n> Note: [docs](https://cloud.google.com/run)\n\n| a | b |\n|:-:|---|\n| 1 | 2 |\n\n---\n- [x] done",
    ...MALICIOUS,
  ];
  const doc = fakeDocument();
  for (const s of samples) {
    const frag = renderMarkdown(s, doc);
    assert.equal(frag.toHtml(), markdownToSafeHtml(s), `mismatch for ${JSON.stringify(s).slice(0, 80)}`);
  }
});

// ------------------------------------------------------------------ voice helpers

test('voice: wake word matching tolerates mishearings and returns the rest', async () => {
  const { matchWakeWord } = await load('voice.js');
  assert.deepEqual(matchWakeWord('hey claude open chrome', 'hey claude'), { matched: true, rest: 'open chrome' });
  assert.deepEqual(matchWakeWord("Hey, Claude! What's on my screen?", 'hey claude'), { matched: true, rest: "What's on my screen?" });
  assert.equal(matchWakeWord('hey cloud deploy this', 'hey claude').rest, 'deploy this');
  assert.equal(matchWakeWord('hi clod, stop', 'hey claude').rest, 'stop');
  assert.deepEqual(matchWakeWord('Claude, run the tests', 'hey claude'), { matched: true, rest: 'run the tests' });
  assert.deepEqual(matchWakeWord('hey claude', 'Hey Claude'), { matched: true, rest: '' });
  assert.equal(matchWakeWord('so I said hey claude open mail', 'hey claude').rest, 'open mail');
  assert.equal(matchWakeWord('hello world', 'hey claude').matched, false);
  assert.equal(matchWakeWord('the cloud is down', 'hey claude').matched, false);
  assert.deepEqual(matchWakeWord('computer, lock the screen', 'computer'), { matched: true, rest: 'lock the screen' });
  assert.deepEqual(matchWakeWord('anything goes', ''), { matched: true, rest: 'anything goes' });
});

test('voice: intents for stop, approvals and questions', async () => {
  const { parseVoiceIntent } = await load('voice.js');
  for (const s of ['stop', 'Stop!', 'cancel', 'never mind', 'please stop', 'stop it']) assert.deepEqual(parseVoiceIntent(s), { kind: 'stop' }, s);
  assert.deepEqual(parseVoiceIntent('stop the server and restart it'), { kind: 'command', text: 'stop the server and restart it' });
  const ap = { approval: true };
  for (const s of ['yes', 'Yeah, go ahead.', 'allow', 'approve', 'OK', 'do it']) assert.deepEqual(parseVoiceIntent(s, ap), { kind: 'approve', decision: 'allow' }, s);
  for (const s of ['always', 'Always allow', 'yes always']) assert.deepEqual(parseVoiceIntent(s, ap), { kind: 'approve', decision: 'allow_session' }, s);
  assert.deepEqual(parseVoiceIntent('no', ap), { kind: 'approve', decision: 'deny' });
  assert.deepEqual(parseVoiceIntent('No, use the staging project instead', ap), { kind: 'approve', decision: 'deny', message: 'use the staging project instead' });
  assert.deepEqual(parseVoiceIntent("don't do that", ap), { kind: 'approve', decision: 'deny', message: 'do that' });
  assert.deepEqual(parseVoiceIntent('Do not, it costs money', ap), { kind: 'approve', decision: 'deny', message: 'it costs money' });
  assert.deepEqual(parseVoiceIntent("what's on my screen", ap), { kind: 'unmatched_approval', text: "what's on my screen" });
  const q = { question: { options: ['my-proj-123', 'shop-staging', 'Create a new project'] } };
  assert.deepEqual(parseVoiceIntent('shop staging', q), { kind: 'answer', text: 'shop-staging' });
  assert.deepEqual(parseVoiceIntent('the second one', q), { kind: 'answer', text: 'shop-staging' });
  assert.deepEqual(parseVoiceIntent('option 3', q), { kind: 'answer', text: 'Create a new project' });
  assert.deepEqual(parseVoiceIntent('last', q), { kind: 'answer', text: 'Create a new project' });
  assert.deepEqual(parseVoiceIntent('use my proj 123 please', q), { kind: 'answer', text: 'my-proj-123' });
  assert.deepEqual(parseVoiceIntent('something else entirely', q), { kind: 'answer', text: 'something else entirely' });
  assert.deepEqual(parseVoiceIntent('Deploy this repo', {}), { kind: 'command', text: 'Deploy this repo' });
});

test('voice: speech text strips markdown, drops code and stays short', async () => {
  const { speechText, stripMarkdownForSpeech, splitSentences } = await load('voice.js');
  const s = stripMarkdownForSpeech('## Done\n**Deployed** `shop-api` to [Cloud Run](https://x.example).\n```bash\nrm -rf /\n```\nURL: https://shop.a.run.app');
  assert.ok(!/[*#`[\]]/.test(s), s);
  assert.ok(s.includes('Deployed shop-api to Cloud Run'), s);
  assert.ok(s.includes('(code omitted)'), s);
  assert.ok(s.includes('the link'), s);
  const long = 'This is a sentence that goes on. '.repeat(40);
  const out = speechText(long);
  assert.ok(out.length <= 600, String(out.length));
  assert.ok(out.endsWith('.'), out.slice(-20));
  const chunks = splitSentences(`${'Word '.repeat(100)}end. Short one. Another short one!`, 120);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 121, `${c.length}: ${c}`);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), `${'Word '.repeat(100)}end. Short one. Another short one!`.replace(/\s+/g, ' ').trim());
  assert.deepEqual(splitSentences(''), []);
  assert.equal(speechText(''), '');
});

// ------------------------------------------------------------------ WAV helpers

test('wav: header is canonical 16 kHz mono 16-bit PCM', async () => {
  const { encodeWav, floatTo16BitPCM } = await load('wav-recorder.js');
  const buf = encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -2, NaN]), 16000);
  const v = new DataView(buf);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 14);
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(str(12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(28, true), 32000);
  assert.equal(v.getUint16(32, true), 2);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(str(36, 4), 'data');
  assert.equal(v.getUint32(40, true), 14);
  assert.deepEqual([...floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2, NaN]))], [0, 32767, -32768, 32767, -32768, 0]);
  assert.equal(v.getInt16(44 + 2, true), 32767);
  assert.equal(v.getInt16(44 + 4, true), -32768);
  assert.equal(encodeWav(new Int16Array(0)).byteLength, 44);
});

test('wav: resampling averages to 16 kHz and is chunk-size independent', async () => {
  const { resample, StreamResampler, rms } = await load('wav-recorder.js');
  const n = 48000;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i += 1) sig[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
  const whole = resample(sig, 48000);
  assert.equal(whole.length, 16000);
  const r = new StreamResampler(48000);
  const parts = [];
  for (let i = 0; i < n; i += 777) parts.push(...r.push(sig.subarray(i, Math.min(n, i + 777))));
  parts.push(...r.flush());
  assert.equal(parts.length, whole.length);
  for (let i = 0; i < whole.length; i += 997) assert.ok(Math.abs(parts[i] - whole[i]) < 1e-6);
  // Averaging: a constant stays constant; groups of three are averaged.
  assert.ok(resample(new Float32Array(300).fill(0.25), 48000).every((x) => Math.abs(x - 0.25) < 1e-6));
  assert.deepEqual([...resample(new Float32Array([0, 0.3, 0.6, 1, 1, 1]), 48000)].map((x) => Math.round(x * 100) / 100), [0.3, 1]);
  const cd = resample(new Float32Array(44100), 44100);
  assert.ok(Math.abs(cd.length - 16000) <= 1, String(cd.length));
  const up = resample(new Float32Array(8000).fill(0.5), 8000);
  assert.ok(Math.abs(up.length - 16000) <= 2, String(up.length));
  assert.ok(up.every((x) => Math.abs(x - 0.5) < 1e-6));
  assert.ok(Math.abs(rms(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9);
  assert.equal(rms(new Float32Array(0)), 0);
  assert.throws(() => new StreamResampler(0));
});

test('wav: VAD stops after silence, on no speech, and at the cap', async () => {
  const { Vad } = await load('wav-recorder.js');
  const v = new Vad({ silenceMs: 1200, maxMs: 60000, noSpeechMs: 10000 });
  for (let i = 0; i < 20; i += 1) assert.equal(v.update(0.002, 50), null);
  for (let i = 0; i < 20; i += 1) assert.equal(v.update(0.2, 50), null);
  assert.equal(v.speech, true);
  let reason = null;
  let ms = 0;
  while (!reason && ms < 5000) {
    reason = v.update(0.003, 50);
    ms += 50;
  }
  assert.equal(reason, 'silence');
  assert.ok(ms >= 1200 && ms <= 1300, String(ms));
  const quiet = new Vad({ noSpeechMs: 1000 });
  let r2 = null;
  for (let i = 0; i < 30 && !r2; i += 1) r2 = quiet.update(0.001, 50);
  assert.equal(r2, 'nospeech');
  const loud = new Vad({ maxMs: 500, noSpeechMs: 0 });
  let r3 = null;
  for (let i = 0; i < 30 && !r3; i += 1) r3 = loud.update(0.3, 50);
  assert.equal(r3, 'max');
  // The noise floor adapts: steady background hum alone is not speech.
  const hum = new Vad({ noSpeechMs: 0 });
  for (let i = 0; i < 200; i += 1) hum.update(0.01, 50);
  assert.equal(hum.speech, false);
});

// ------------------------------------------------------------------ static page checks

const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
const appJs = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');

test('page: title, module script and no inline script or handlers', () => {
  assert.match(html, /<title>Claude Anywhere<\/title>/);
  // app.js, then the feature-3 loader (calls-ui.js: the calls panel and the voice enrollment view).
  const scripts = html.match(/<script\b[^>]*>/g) || [];
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.match(s, /type="module"/);
  assert.match(scripts[0], /src="app\.js"/);
  assert.match(scripts[1], /src="calls-ui\.js"/);
  assert.ok(!/<script\b[^>]*>[^<\s]/.test(html), 'inline script body');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler');
  assert.ok(!/javascript:/i.test(html));
  assert.match(html, /role="log"/);
  assert.match(html, /aria-live="polite"/);
});

test('page: only same-origin resources, and every referenced file exists', () => {
  const refs = [...html.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 3);
  for (const r of refs) {
    assert.ok(!/^[a-z]+:|^\/\//i.test(r), `external reference ${r}`);
    assert.ok(fs.existsSync(path.join(UI, r)), `missing ${r}`);
  }
  assert.ok(!/@import|url\(\s*['"]?(https?:|\/\/)/i.test(css), 'external CSS resource');
  for (const f of ['app.js', 'voice.js', 'markdown.js', 'wav-recorder.js', 'wav-worklet.js']) {
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|outerHTML\s*=|\beval\(|new Function\(/.test(src), `${f} uses an HTML/script sink`);
    assert.ok(!/fetch\(\s*['"`]https?:/.test(src), `${f} fetches an external URL`);
  }
  assert.ok(fs.existsSync(path.join(UI, 'wav-worklet.js')));
  assert.match(fs.readFileSync(path.join(UI, 'wav-recorder.js'), 'utf8'), /new URL\('\.\/wav-worklet\.js', import\.meta\.url\)/);
});

test('page: every element app.js looks up and every icon it uses exists', () => {
  const block = appJs.slice(appJs.indexOf('const ids = {'), appJs.indexOf('};', appJs.indexOf('const ids = {')));
  const ids = [...block.matchAll(/:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length > 40, String(ids.length));
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `index.html lacks #${id}`);
  const symbols = new Set([...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  for (const name of ['mic', 'send', 'stop', 'screen', 'gear', 'folder', 'check', 'x', 'spinner']) assert.ok(symbols.has(name), `missing icon ${name}`);
  const used = new Set([
    ...[...appJs.matchAll(/icon\('([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/icon: '([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/setIcon\([^,]+,\s*[^)]*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'/g)].flatMap((m) => [m[1], m[2]]),
  ]);
  const toolIconSrc = appJs.slice(appJs.indexOf('function toolIcon'), appJs.indexOf('function buildTool'));
  for (const m of toolIconSrc.matchAll(/'([a-z]+)'/g)) if (!['screen', 'mouse', 'keyboard', 'terminal', 'file', 'web', 'list_windows', 'focus_window', 'todowrite', 'ask_user', 'askuserquestion', 'notify_user'].includes(m[1]) || symbols.has(m[1])) used.add(m[1]);
  for (const name of used) assert.ok(symbols.has(name), `app.js uses icon "${name}" that index.html does not define`);
  for (const m of html.matchAll(/href="#i-([a-z0-9-]+)"/g)) assert.ok(symbols.has(m[1]), `index.html uses undefined icon ${m[1]}`);
});

test('page: themes, reduced motion and accent are defined in CSS', () => {
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /#d97757/i);
  assert.match(css, /body\s*{[^}]*background:/);
  assert.match(css, /:focus-visible/);
});

test('page: every UI module parses as an ES module', () => {
  for (const f of fs.readdirSync(TMP)) {
    if (!f.endsWith('.js')) continue;
    const r = spawnSync(process.execPath, ['--check', path.join(TMP, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

// ------------------------------------------------------------------ stub server

const { createStubServer, CSP } = require('./fixtures/ui-stub-server');

function request(port, { method = 'GET', path: p = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: host || `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    req.end();
  });
}

test('stub server: serves the UI with the daemon security headers', async (t) => {
  const s = await createStubServer({ stream: false });
  t.after(() => s.close());
  const page = await request(s.port);
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], CSP);
  assert.match(CSP, /script-src 'self';/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.text, /<title>Claude Anywhere<\/title>/);
  for (const [p, type] of [['/app.js', /^text\/javascript/], ['/app.css', /^text\/css/], ['/icon.svg', /^image\/svg\+xml/], ['/wav-worklet.js', /^text\/javascript/]]) {
    const r = await request(s.port, { path: p });
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], type, p);
  }
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%5c..%5cpackage.json']) {
    const r = await request(s.port, { path: p });
    assert.ok(r.status === 403 || r.status === 404, `${p} → ${r.status}`);
    assert.ok(!r.text.includes('"name": "claude-anywhere"'), p);
  }
  assert.equal((await request(s.port, { path: '/..%2fpackage.json' })).status, 403);
  assert.equal((await request(s.port, { path: '/.hidden' })).status, 404);
  assert.equal((await request(s.port, { host: 'evil.example' })).status, 403);
  assert.equal((await request(s.port, { path: '/nope.js' })).status, 404);
});

test('stub server: auth, origin checks and a snapshot with every item kind', async (t) => {
  const s = await createStubServer({ stream: false, token: 'tok' });
  t.after(() => s.close());
  const auth = { Authorization: 'Bearer tok' };
  assert.equal((await request(s.port, { path: '/api/state' })).status, 401);
  assert.equal((await request(s.port, { path: '/api/state', headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await request(s.port, { path: '/api/state?token=tok' })).status, 401, 'query token only for SSE');
  assert.equal((await request(s.port, { path: '/api/health' })).json.app, 'claude-anywhere');
  const st = (await request(s.port, { path: '/api/state', headers: auth })).json;
  const roles = new Set(st.messages.map((m) => m.role));
  for (const r of ['user', 'assistant', 'system', 'tool']) assert.ok(roles.has(r), r);
  const tools = st.messages.filter((m) => m.role === 'tool');
  assert.ok(tools.some((m) => m.status === 'running'));
  assert.ok(tools.some((m) => m.status === 'ok' && /^data:image\/png;base64,iVBOR/.test(m.image || '')));
  assert.equal(st.pending.approvals.length, 1);
  assert.equal(st.pending.questions.length, 1);
  assert.equal(st.config.voice.sttApiKey, '');
  const foreign = await request(s.port, { method: 'POST', path: '/api/interrupt', headers: { ...auth, Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  const own = await request(s.port, { method: 'POST', path: '/api/interrupt', headers: { ...auth, Origin: `http://127.0.0.1:${s.port}` } });
  assert.equal(own.status, 200);
});

test('stub server: SSE starts with a snapshot and streams the scripted turn', async (t) => {
  const s = await createStubServer({ token: 'tok' });
  t.after(() => s.close());
  const events = await new Promise((resolve, reject) => {
    const got = [];
    const req = http.get({ host: '127.0.0.1', port: s.port, path: '/api/events?token=tok', headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = (/^event: (.+)$/m.exec(block) || [])[1];
          const data = (/^data: (.+)$/m.exec(block) || [])[1];
          if (type) got.push({ type, data: JSON.parse(data) });
          if (type === 'result') {
            req.destroy();
            resolve(got);
          }
        }
      });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
    setTimeout(() => reject(new Error(`timed out; got ${got.map((e) => e.type).join(',')}`)), 8000).unref();
  });
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'snapshot');
  for (const ty of ['status', 'message', 'delta', 'tool_update', 'result']) assert.ok(types.includes(ty), ty);
  const deltas = events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');
  const final = events.filter((e) => e.type === 'message' && e.data.streaming === false).pop();
  assert.equal(final.data.text, deltas);
});

test('stub server: fake endpoints behave like the daemon contract', async (t) => {
  const s = await createStubServer({ stream: false, token: 'tok' });
  t.after(() => s.close());
  const h = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };
  const post = (p, body) => request(s.port, { method: 'POST', path: p, headers: h, body });
  assert.deepEqual((await post('/api/approval', { id: 'ap_1', decision: 'allow' })).json, { ok: true });
  assert.equal((await post('/api/approval', { id: 'ap_1', decision: 'allow' })).status, 404);
  assert.equal((await post('/api/approval', { id: 'x', decision: 'maybe' })).status, 400);
  assert.deepEqual((await post('/api/answer', { id: 'q_1', text: 'my-proj-123' })).json, { ok: true });
  const cfg = (await post('/api/config', { voice: { sttApiKey: 'sk-secret', handsFree: true } })).json;
  assert.equal(cfg.voice.sttApiKey, '');
  assert.equal(cfg.voice.sttApiKeySet, true);
  assert.equal(cfg.voice.handsFree, true);
  assert.equal((await post('/api/config', { bogus: 1 })).status, 400);
  assert.equal((await post('/api/mode', { mode: 'bridge' })).json.mode, 'bridge');
  assert.ok(Array.isArray((await request(s.port, { path: '/api/projects', headers: h })).json.projects));
  assert.equal((await post('/api/project', { dir: '/tmp/other-proj' })).json.project.name, 'other-proj');
  const wav = Buffer.alloc(44 + 3200);
  const stt = await request(s.port, { method: 'POST', path: '/api/stt?language=en-US', headers: { Authorization: 'Bearer tok', 'Content-Type': 'audio/wav' }, body: wav });
  assert.equal(stt.status, 200);
  assert.equal(typeof stt.json.text, 'string');
  const bad = await request(s.port, { method: 'POST', path: '/api/stt', headers: { Authorization: 'Bearer tok', 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(bad.status, 415);
  assert.equal((await post('/api/command', { text: 'hello' })).json.ok, true);
  assert.equal((await post('/api/command', { text: '' })).status, 400);
  assert.equal((await post('/api/tts', { text: 'hi' })).json.ok, true);
  assert.equal((await post('/api/tts/stop', {})).json.ok, true);
  assert.equal((await post('/api/session/new', {})).json.ok, true);
  assert.equal((await request(s.port, { path: '/api/state', headers: h })).json.messages.length, 0);
});

test('stub server: CLI prints its URL, and stays quiet under the bare test runner', async () => {
  const quiet = spawnSync(process.execPath, [STUB], { env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [STUB, '0', '--scenario=empty', '--token=abc'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c) => {
        out += c;
        const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=abc/.exec(out);
        if (m) resolve(m[0]);
      });
      child.on('exit', (code) => reject(new Error(`exited ${code}`)));
      setTimeout(() => reject(new Error('no URL printed')), 5000).unref();
    });
    const port = Number(new URL(url).port);
    const st = await request(port, { path: '/api/state', headers: { Authorization: 'Bearer abc' } });
    assert.equal(st.json.messages.length, 0);
  } finally {
    child.kill();
  }
});
