'use strict';

// OCR (src/os/ocr.js, src/os/darwin-ocr.js, src/os/win32-ocr.ps1) and its MCP tools (src/mcp/tools-ocr.js).
// Everything runs without a display: engines are faked through the context hooks, the JXA script runs
// against a fake ObjC bridge, the PowerShell script's JSON writer runs under pwsh when it is installed,
// and the real-tesseract tests skip unless tesseract and ImageMagick are present.
// ANYWHERE_LIVE_OCR=1 with DISPLAY (Xvfb + a window manager) and Chromium adds the full round trip:
// find_text on a real page, click the result, and let the page report what was hit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ocr = require('../src/os/ocr');
const png = require('../src/os/png');
const darwinOcr = require('../src/os/darwin-ocr');
const toolsOcr = require('../src/mcp/tools-ocr');

const ROOT = path.join(__dirname, '..');
const PS1 = path.join(ROOT, 'src', 'os', 'win32-ocr.ps1');
const JXA = path.join(ROOT, 'src', 'os', 'darwin-ocr.js');

function which(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-ocr-test-'));
}

/** A solid PNG of the given size (content is irrelevant to the fake engines). */
function blankPng(width, height, rgb = [255, 255, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return png.encode({ width, height, data });
}

/** A fake system for ocr.js: which/exists/run answer from tables, every run is recorded. */
function fakeCtx({ platform = 'linux', isWSL = false, env = {}, tools = [], files = [], responses = {}, tmpdir } = {}) {
  const calls = [];
  const which = (n) => (tools.includes(n) ? (n.includes('/') ? n : `/usr/bin/${n}`) : null);
  const exists = (p) => files.includes(p);
  const run = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const name = path.basename(String(cmd));
    let r = responses[name];
    if (typeof r === 'function') r = await r(args, opts, calls);
    if (r === undefined) r = { code: 1, stderr: `no fake response for ${name}` };
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...r };
  };
  return { platform, isWSL, env, which, exists, run, tmpdir: tmpdir || os.tmpdir(), cache: new Map(), calls };
}

// ---------------------------------------------------------------- captured engine output samples

// tesseract 5.3.4 --psm 11 tsv (excerpt of a real run on a Chromium page under Xvfb).
const TSV_PSM11 = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '1\t1\t0\t0\t0\t0\t0\t0\t1600\t1000\t-1\t',
  '2\t1\t1\t0\t0\t0\t31\t273\t77\t14\t-1\t',
  '5\t1\t9\t1\t1\t1\t31\t273\t54\t11\t96.993034\tWorked',
  '5\t1\t9\t1\t1\t2\t92\t276\t16\t8\t96.913254\ton',
  '5\t1\t10\t1\t1\t1\t142\t273\t52\t11\t96.348419\tViewed',
  '5\t1\t13\t1\t1\t1\t378\t273\t25\t11\t96.88\tFor',
  '5\t1\t13\t1\t1\t2\t409\t276\t21\t11\t96.71\tyou',
  '5\t1\t14\t1\t1\t1\t465\t273\t53\t11\t96.878365\tStarred',
  '5\t1\t20\t1\t1\t1\t144\t352\t16\t10\t96.894554\tFix',
  '5\t1\t20\t1\t1\t2\t167\t352\t28\t13\t96.486778\tlogin',
  '5\t1\t20\t1\t1\t3\t205\t353\t53\t9\t96.757942\ttimeout',
  '5\t1\t21\t1\t1\t1\t292\t352\t12\t9\t95.026611\tIN',
  '5\t1\t21\t1\t1\t2\t311\t352\t70\t9\t96.868828\tPROGRESS',
  '5\t1\t22\t1\t1\t1\t355\t397\t42\t9\t79.366257\tToDo',
  '5\t1\t23\t1\t1\t1\t0\t192\t3\t56\t95.1\t|',
].join('\n');

// tesseract --psm 6 of the same screen: block mode, confidence 0 on some real words, symbol noise.
const TSV_PSM6 = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t1\t5\t1\t1\t31\t273\t54\t11\t0.000000\tWorked',
  '5\t1\t1\t5\t1\t2\t205\t265\t18\t29\t0.000000\t~—',
  '5\t1\t1\t1\t1\t1\t28\t352\t59\t10\t91.5\tABC-123',
  '5\t1\t1\t1\t1\t2\t144\t352\t16\t10\t95.903786\tFix',
  '5\t1\t1\t1\t1\t5\t355\t397\t18\t9\t74.771484\tTO',
  '5\t1\t1\t1\t1\t6\t379\t397\t18\t9\t89.445984\tDO',
  '5\t1\t1\t1\t1\t7\t53\t552\t32\t11\t95.683311\tDark',
  '5\t1\t1\t1\t1\t8\t91\t552\t41\t14\t95.683311\tpanel:Settings',
].join('\n');

// darwin-ocr.js output (Vision boxes: normalized, origin bottom-left) for a 1000x500 image.
const VISION_OUT =
  'some osascript noise\n' +
  JSON.stringify({
    ok: true,
    engine: 'vision',
    lines: [
      {
        text: 'For you',
        confidence: 0.98,
        box: [0.1, 0.8, 0.2, 0.04],
        words: [
          { text: 'For', start: 0, end: 3, box: [0.1, 0.8, 0.08, 0.04] },
          { text: 'you', start: 4, end: 7, box: null },
        ],
      },
      { text: 'Caf\u00e9 \u65e5\u672c', confidence: 0.5, box: [0.5, 0.1, 0.3, 0.05] },
    ],
  }).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// win32-ocr.ps1 output (Windows PowerShell 5.1, Windows.Media.Ocr), ASCII-escaped by the script.
const WINDOWS_OUT =
  'WARNING: ignored\r\n' +
  '{"ok":true,"engine":"windows","language":"en-US","width":1920,"height":1080,"angle":null,"lines":[' +
  '{"text":"For you","words":[{"text":"For","x":378,"y":273,"w":25,"h":14},{"text":"you","x":409,"y":276,"w":21,"h":11}]},' +
  '{"text":"Caf\\u00e9 ABC-123","words":[{"text":"Caf\\u00e9","x":10,"y":500,"w":40,"h":12},{"text":"ABC-123","x":56,"y":500.5,"w":60,"h":12.25}]},' +
  '{"text":"","words":[]}]}\r\n';

// ---------------------------------------------------------------- darwin-ocr.js (JXA) against a fake ObjC bridge

function fakeJxa({ observations = [], performOk = true, errorText = 'The file could not be opened.', hasClass = true, wordBoxes = true } = {}) {
  const log = [];
  const nsString = (s) => ({ _js: s, isNil: () => false });
  const nsArray = (items) => ({ count: items.length, objectAtIndex: (i) => items[i], isNil: () => false });
  const rect = (x, y, w, h) => ({ origin: { x, y }, size: { width: w, height: h } });
  const req = {
    isNil: () => false,
    setRecognitionLevel: (v) => log.push(['setRecognitionLevel', v]),
    setUsesLanguageCorrection: (v) => log.push(['setUsesLanguageCorrection', v]),
    setRecognitionLanguages: (v) => log.push(['setRecognitionLanguages', v._js]),
    setAutomaticallyDetectsLanguage: (v) => log.push(['setAutomaticallyDetectsLanguage', v]),
    setMinimumTextHeight: (v) => log.push(['setMinimumTextHeight', v]),
    results: null,
  };
  const obs = observations.map((o) => ({
    isNil: () => false,
    boundingBox: rect(...o.box),
    topCandidates: (n) => {
      log.push(['topCandidates', n]);
      return nsArray([
        {
          string: nsString(o.text),
          confidence: o.confidence,
          boundingBoxForRangeError: (range, err) => {
            log.push(['boundingBoxForRangeError', range.location, range.length, err && err._nil === true]);
            if (!wordBoxes) throw new Error('unrecognized selector');
            const n2 = o.text.length;
            return { isNil: () => false, boundingBox: rect(o.box[0] + (o.box[2] * range.location) / n2, o.box[1], (o.box[2] * range.length) / n2, o.box[3]) };
          },
        },
      ]);
    },
  }));
  function $(v) {
    if (arguments.length === 0) return { _nil: true, isNil: () => true };
    return { _js: v, isNil: () => false };
  }
  $.NSURL = { fileURLWithPath: (p) => (log.push(['fileURLWithPath', p]), { url: p }) };
  $.NSDictionary = {
    get dictionary() {
      log.push(['NSDictionary.dictionary']);
      return { dict: true };
    },
  };
  $.NSArray = { arrayWithObject: (o) => ({ arr: [o] }) };
  $.NSMakeRange = (location, length) => ({ location, length });
  if (hasClass) {
    $.VNRecognizeTextRequest = {
      alloc: {
        get init() {
          return req;
        },
      },
    };
  }
  $.VNImageRequestHandler = {
    alloc: {
      initWithURLOptions: (url, opts) => {
        log.push(['initWithURLOptions', url.url, opts]);
        return {
          performRequestsError: (arr, err) => {
            log.push(['performRequestsError', arr.arr[0] === req]);
            if (!performOk) {
              err[0] = { isNil: () => false, localizedDescription: nsString(errorText) };
              return false;
            }
            req.results = nsArray(obs);
            return true;
          },
        };
      },
    },
  };
  const ObjC = {
    import: (name) => log.push(['import', name]),
    unwrap: (v) => (v && Object.prototype.hasOwnProperty.call(v, '_js') ? v._js : v),
  };
  const Ref = () => [];
  return { env: { ObjC, $, Ref }, log, req };
}

test('darwin-ocr.js: valid JavaScript, ES5-style JXA script with a run() entry point', () => {
  const r = spawnSync(process.execPath, ['--check', JXA], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const src = fs.readFileSync(JXA, 'utf8');
  assert.match(src, /function run\(argv\)/);
  assert.match(src, /ObjC\.import\('Vision'\)/);
  assert.doesNotMatch(src, /=>|\blet\b|\bconst\b|`/, 'the JXA script stays ES5 (no arrows, let/const or template literals)');
});

test('darwin-ocr.js: Vision request is configured and read through the ObjC bridge', () => {
  const f = fakeJxa({
    observations: [
      { text: 'For you', confidence: 0.98, box: [0.1, 0.8, 0.2, 0.04] },
      { text: '  ', confidence: 0.9, box: [0.1, 0.1, 0.1, 0.1] },
      { text: 'ABC-123', confidence: 0.75, box: [0.5, 0.5, 0.2, 0.05] },
    ],
  });
  const out = darwinOcr.recognize(f.env, '/tmp/shot.png', { minTextHeight: 0.004 });
  assert.equal(out.ok, true);
  assert.equal(out.engine, 'vision');
  assert.equal(out.lines.length, 2, 'blank observations are dropped');
  assert.deepEqual(out.lines[0].box, [0.1, 0.8, 0.2, 0.04]);
  assert.equal(out.lines[0].confidence, 0.98);
  assert.deepEqual(
    out.lines[0].words.map((w) => [w.text, w.start, w.end]),
    [['For', 0, 3], ['you', 4, 7]],
  );
  assert.ok(out.lines[0].words.every((w) => Array.isArray(w.box) && w.box.length === 4));
  const names = f.log.map((e) => e[0]);
  assert.ok(names.includes('import'));
  assert.deepEqual(f.log.find((e) => e[0] === 'setRecognitionLevel'), ['setRecognitionLevel', 0], 'accurate = 0');
  assert.deepEqual(f.log.find((e) => e[0] === 'setUsesLanguageCorrection'), ['setUsesLanguageCorrection', true]);
  assert.deepEqual(f.log.find((e) => e[0] === 'setMinimumTextHeight'), ['setMinimumTextHeight', 0.004]);
  assert.deepEqual(f.log.find((e) => e[0] === 'setAutomaticallyDetectsLanguage'), ['setAutomaticallyDetectsLanguage', true]);
  assert.deepEqual(f.log.find((e) => e[0] === 'initWithURLOptions'), ['initWithURLOptions', '/tmp/shot.png', { dict: true }], 'a non-nil options dictionary');
  assert.deepEqual(f.log.find((e) => e[0] === 'performRequestsError'), ['performRequestsError', true]);
  assert.deepEqual(f.log.find((e) => e[0] === 'topCandidates'), ['topCandidates', 1]);
  assert.deepEqual(f.log.find((e) => e[0] === 'boundingBoxForRangeError'), ['boundingBoxForRangeError', 0, 3, true], 'range struct + $() for the error');
});

test('darwin-ocr.js: options, failures and the osascript entry point', () => {
  const fast = fakeJxa({ observations: [] });
  darwinOcr.recognize(fast.env, '/x.png', { fast: true, correction: false, languages: ['en-US', 'de_DE', 'bad tag!'] });
  assert.deepEqual(fast.log.find((e) => e[0] === 'setRecognitionLevel'), ['setRecognitionLevel', 1]);
  assert.deepEqual(fast.log.find((e) => e[0] === 'setUsesLanguageCorrection'), ['setUsesLanguageCorrection', false]);
  assert.deepEqual(fast.log.find((e) => e[0] === 'setRecognitionLanguages'), ['setRecognitionLanguages', ['en-US', 'de-DE']]);
  assert.equal(fast.log.find((e) => e[0] === 'setAutomaticallyDetectsLanguage'), undefined, 'explicit languages turn auto-detection off');

  const broken = fakeJxa({ performOk: false });
  const bad = darwinOcr.recognize(broken.env, '/missing.png', {});
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'OCR_FAILED');
  assert.match(bad.error, /could not be opened/);

  const old = fakeJxa({ hasClass: false });
  assert.equal(darwinOcr.recognize(old.env, '/x.png', {}).code, 'UNSUPPORTED');
  assert.equal(darwinOcr.recognize(old.env, '', {}).code, 'BAD_ARGS');

  const noWordBoxes = fakeJxa({ observations: [{ text: 'a b', confidence: 1, box: [0, 0, 1, 1] }], wordBoxes: false });
  const nb = darwinOcr.recognize(noWordBoxes.env, '/x.png', {});
  assert.deepEqual(nb.lines[0].words.map((w) => w.box), [null, null], 'a word without its own box is left for ocr.js to split');

  // run() with the JXA globals: ASCII-only JSON on stdout.
  const g = fakeJxa({ observations: [{ text: 'Caf\u00e9', confidence: 0.9, box: [0, 0, 0.5, 0.5] }] });
  Object.assign(global, { ObjC: g.env.ObjC, $: g.env.$, Ref: g.env.Ref });
  try {
    const s = darwinOcr.run(['/x.png', '{"words":false}']);
    assert.match(s, /^[\x20-\x7e]+$/);
    const j = JSON.parse(s);
    assert.equal(j.lines[0].text, 'Caf\u00e9');
    assert.equal(j.lines[0].words, undefined);
    assert.equal(JSON.parse(darwinOcr.run(['/x.png', '{not json'])).code, 'OCR_FAILED');
  } finally {
    delete global.ObjC;
    delete global.$;
    delete global.Ref;
  }
});

// ---------------------------------------------------------------- win32-ocr.ps1

test('win32-ocr.ps1: pure ASCII, Windows PowerShell 5.1 WinRT OCR pipeline', () => {
  const src = fs.readFileSync(PS1);
  assert.ok(src.every((b) => b < 0x80), 'Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page');
  const text = src.toString('utf8');
  for (const needle of [
    '[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]',
    'System.Runtime.WindowsRuntime',
    "IAsyncOperation`1'",
    'MakeGenericMethod',
    '[System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream',
    '[Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync',
    'GetSoftwareBitmapAsync',
    'TryCreateFromUserProfileLanguages()',
    'BoundingRect',
    'MaxImageDimension',
  ]) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
  assert.doesNotMatch(text, /\?\?|\?\.|::new\(/, 'no PowerShell 7-only syntax');
});

const PWSH = which('pwsh');

test('win32-ocr.ps1: parses, refuses PowerShell 7, and writes culture-proof ASCII JSON', { skip: !PWSH && 'pwsh is not installed' }, () => {
  const parse = spawnSync(
    PWSH,
    ['-NoProfile', '-NonInteractive', '-Command', `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${PS1}',[ref]$t,[ref]$e);$e.Count`],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(parse.stdout.trim(), '0', parse.stderr);

  const probe = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', PS1, '-Probe'], { encoding: 'utf8', timeout: 60000 });
  const pj = ocr.lastJson(probe.stdout);
  assert.equal(pj.ok, false);
  assert.equal(pj.code, 'UNSUPPORTED');
  assert.match(pj.error, /Windows PowerShell 5\.1/);
  const usage = ocr.lastJson(spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', PS1], { encoding: 'utf8', timeout: 60000 }).stdout);
  assert.equal(usage.code, 'BAD_ARGS');

  // Dot-sourcing defines the functions without running: feed fake OcrLine/OcrWord objects under de-DE.
  const dir = tmpDir();
  try {
    const script = path.join(dir, 't.ps1');
    fs.writeFileSync(
      script,
      [
        `. '${PS1}'`,
        "[System.Threading.Thread]::CurrentThread.CurrentCulture = 'de-DE'",
        "$w1 = [pscustomobject]@{ Text = 'Caf' + [char]0xE9; BoundingRect = [pscustomobject]@{ X = 10.5; Y = 20; Width = 30.25; Height = 14 } }",
        "$w2 = [pscustomobject]@{ Text = 'say \"hi\"\\x'; BoundingRect = [pscustomobject]@{ X = 44; Y = 20; Width = 28; Height = 14 } }",
        "$l = [pscustomobject]@{ Text = 'Caf' + [char]0xE9 + ' say'; Words = @($w1, $w2) }",
        "Write-OcrJson (ConvertTo-OcrResultJson 'de-DE' 1920 1080 $null @($l))",
        "Write-OcrJson (New-OcrFailure 'NO_LANGUAGE' 'none' 'add one')",
      ].join('\n'),
    );
    const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', timeout: 60000 });
    const out = r.stdout.trim().split(/\r?\n/);
    assert.equal(out.length, 2, r.stderr);
    assert.match(out[0], /^[\x20-\x7e]+$/, 'ASCII only');
    assert.match(out[0], /"x":10\.5,/, 'invariant decimal point under de-DE');
    const parsed = ocr.parseWindowsOutput(out[0]);
    assert.equal(parsed.language, 'de-DE');
    assert.equal(parsed.lines[0].words[0].text, 'Caf\u00e9');
    assert.equal(parsed.lines[0].words[1].text, 'say "hi"\\x');
    assert.deepEqual(parsed.lines[0].bounds, { x: 10.5, y: 20, width: 61.5, height: 14 });
    assert.throws(() => ocr.parseWindowsOutput(out[1]), (e) => e.code === 'NO_LANGUAGE' && e.hint === 'add one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- parsers

test('parseTesseractTsv: words of level 5 with boxes and confidence; box edges trimmed', () => {
  const words = ocr.parseTesseractTsv(TSV_PSM11, { pass: 11 });
  assert.equal(words.length, 13);
  assert.deepEqual(words[0], { text: 'Worked', x: 31, y: 273, w: 54, h: 11, conf: 96.993034, pass: 11, block: 9, par: 1, line: 1 });
  const glued = ocr.parseTesseractTsv('5\t1\t1\t1\t1\t1\t0\t0\t50\t10\t90\t|Settings|');
  assert.equal(glued[0].text, 'Settings');
  assert.deepEqual(ocr.parseTesseractTsv('garbage\n5\t1\t1\t1\t1\t1\tx\t0\t1\t1\t90\ta'), []);
});

test('mergeWords + groupLines: passes merge by confidence, UI labels on one row stay apart', () => {
  const words = [...ocr.parseTesseractTsv(TSV_PSM11, { pass: 11 }), ...ocr.parseTesseractTsv(TSV_PSM6, { pass: 6 })];
  const merged = ocr.mergeWords(words);
  const texts = merged.map((w) => w.text);
  assert.equal(texts.filter((t) => t === 'Worked').length, 1, 'duplicates collapse');
  assert.equal(merged.find((w) => w.text === 'Worked').conf, 96.993034, 'the confident reading wins');
  assert.ok(!texts.includes('~—') && !texts.includes('|'), 'symbol noise and box edges are dropped');
  assert.ok(texts.includes('ABC-123'), 'a word only one pass saw is kept');
  assert.ok(texts.includes('TO') && texts.includes('DO') && !texts.includes('ToDo'), 'the more confident split wins');
  const lines = ocr.groupLines(merged).map((l) => l.words.map((w) => w.text).join(' '));
  assert.ok(lines.includes('Worked on'));
  assert.ok(lines.includes('Viewed'));
  assert.ok(lines.includes('For you'));
  assert.ok(lines.includes('Fix login timeout'), 'a row with a big gap splits into separate lines');
  assert.ok(lines.includes('IN PROGRESS'));
  assert.ok(lines.includes('TO DO'));
  assert.ok(!lines.some((l) => l.includes('timeout IN')));
});

test('parseVisionOutput: normalized bottom-left boxes become top-left pixels; missing word boxes are split from the line', () => {
  const { lines } = ocr.parseVisionOutput(VISION_OUT, 1000, 500);
  assert.equal(lines.length, 2);
  const l = lines[0];
  assert.equal(l.text, 'For you');
  assert.equal(l.confidence, 0.98);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  near(l.bounds.x, 100);
  near(l.bounds.y, (1 - 0.8 - 0.04) * 500);
  near(l.bounds.width, 200);
  near(l.bounds.height, 20);
  near(l.words[0].bounds.width, 80);
  near(l.words[1].bounds.x, 100 + (200 * 4) / 7);
  near(l.words[1].bounds.width, (200 * 3) / 7);
  assert.equal(lines[1].text, 'Caf\u00e9 \u65e5\u672c');
  assert.equal(lines[1].words.length, 1, 'a line without words becomes one word');
  const quirk = ocr.parseVisionOutput({ ok: true, lines: [{ text: 'ab cd', confidence: 1, box: [0, 0, 1, 0.1], words: [{ text: 'ab', start: 0, end: 2, box: [0, 0, 1, 0.1] }, { text: 'cd', start: 3, end: 5, box: [0, 0, 1, 0.1] }] }] }, 100, 100);
  assert.deepEqual(quirk.lines[0].words.map((w) => [w.bounds.x, w.bounds.width]), [[0, 40], [60, 40]], 'whole-line word boxes are split by characters');
  assert.throws(() => ocr.parseVisionOutput('{"ok":false,"code":"UNSUPPORTED","error":"old macOS"}', 1, 1), (e) => e.code === 'UNSUPPORTED');
  assert.throws(() => ocr.parseVisionOutput('nothing', 1, 1), (e) => e.code === 'OCR_FAILED');
});

test('parseWindowsOutput: words with BoundingRect pixels, line bounds are their union, no confidence', () => {
  const { lines, language } = ocr.parseWindowsOutput(WINDOWS_OUT);
  assert.equal(language, 'en-US');
  assert.equal(lines.length, 2, 'empty lines are dropped');
  assert.deepEqual(lines[0].bounds, { x: 378, y: 273, width: 52, height: 14 });
  assert.equal(lines[0].confidence, null);
  assert.equal(lines[1].text, 'Caf\u00e9 ABC-123');
  assert.deepEqual(lines[1].words[1].bounds, { x: 56, y: 500.5, width: 60, height: 12.25 });
  assert.throws(() => ocr.parseWindowsOutput('{"ok":false,"code":"NO_LANGUAGE","error":"none"}'), (e) => /Add-WindowsCapability/.test(e.hint));
});

test('parseTesseractLangs and lastJson', () => {
  assert.deepEqual(ocr.parseTesseractLangs('List of available languages in "/usr/share/tesseract-ocr/5/tessdata/" (3):\neng\nosd\nchi_sim\n'), ['eng', 'osd', 'chi_sim']);
  assert.deepEqual(ocr.parseTesseractLangs('Error opening data file\n'), []);
  assert.deepEqual(ocr.lastJson('x\n{"a":1}\n{"b":2}\nnoise\n'), { b: 2 });
  assert.equal(ocr.lastJson('{broken'), null);
});

// ---------------------------------------------------------------- matching

function line(text, x, y, opts = {}) {
  const ch = opts.ch || 8;
  let cx = x;
  const words = text.split(' ').map((t) => {
    const w = { text: t, shot: { x: cx, y, width: t.length * ch, height: 12 }, confidence: opts.conf == null ? 0.9 : opts.conf };
    cx += (t.length + 1) * ch;
    return w;
  });
  return { text, words, shot: { x, y, width: cx - ch - x, height: 12 }, confidence: opts.conf == null ? 0.9 : opts.conf };
}

test('normalizeText and the OCR-aware edit distance', () => {
  assert.equal(ocr.normalizeText('  For\u00a0\u00a0YOU\u200b '), 'for you');
  assert.equal(ocr.normalizeText('\u201cDon\u2019t\u201d \u2014 \uff21\uff22\uff23'), '"don\'t" - abc');
  assert.equal(ocr.levenshtein('login', 'logn'), 1);
  assert.equal(ocr.levenshtein('abc-123', 'abc-i23'), 1, '1 read as i');
  assert.equal(ocr.levenshtein('abc-123', 'abc-o23', 5) > 5, true, 'o is not a look-alike of 1');
  assert.equal(ocr.levenshtein('abc-123', 'abc-124', 5) > 5, true, 'never another digit');
  assert.equal(ocr.levenshtein('abc-123', 'abc-12', 5) > 5, true, 'never a dropped digit');
  assert.equal(ocr.levenshtein('settings', 'setings', 2), 1);
  assert.deepEqual([1, 2, 3, 7, 8, 20].map(ocr.allowedDistance), [0, 0, 1, 1, 2, 2]);
});

test('matchText: exact, contains, fuzzy; digits are never fuzzed; boxes cover the matched words only', () => {
  const lines = [
    line('Worked on', 10, 10),
    line('For you', 200, 10),
    line('ABC-123', 10, 50),
    line('Fix login timeout', 100, 50),
    line('ABC-124', 10, 90),
    line('Dark panel:Settings and notifications', 10, 130),
    line('Your work', 10, 170),
  ];
  const m1 = ocr.matchText(lines, 'for YOU', { boxKey: 'shot' });
  assert.equal(m1[0].text, 'For you');
  assert.equal(m1[0].match, 'exact');
  assert.equal(m1[0].score, 1);
  assert.deepEqual(m1[0].box, { x: 200, y: 10, width: 56, height: 12 });
  assert.equal(m1[0].confidence, 0.9);

  const key = ocr.matchText(lines, 'ABC-123', { boxKey: 'shot' });
  assert.deepEqual(key.map((m) => m.text), ['ABC-123'], 'ABC-124 is not a near miss');
  assert.deepEqual(ocr.matchText(lines, 'ABC-12', { boxKey: 'shot' }), [], 'a prefix of a number is not a match');
  assert.deepEqual(ocr.matchText(lines, 'ABC-125', { boxKey: 'shot' }), []);

  const login = ocr.matchText(lines, 'login', { boxKey: 'shot' });
  assert.equal(login[0].match, 'exact', 'a whole word inside a line');
  assert.deepEqual(login[0].box, { x: 132, y: 50, width: 40, height: 12 }, 'just the word inside the line');
  assert.equal(login[0].line, 'Fix login timeout');
  assert.equal(ocr.matchText(lines, 'login', { boxKey: 'shot', exact: true }).length, 1);
  const logi = ocr.matchText(lines, 'logi', { boxKey: 'shot' });
  assert.equal(logi[0].match, 'contains');
  assert.ok(logi[0].score < login[0].score);
  assert.equal(ocr.matchText(lines, 'logi', { boxKey: 'shot', exact: true }).length, 0, 'exact takes whole words only');

  const typo = ocr.matchText(lines, 'Fix logn timeout', { boxKey: 'shot' });
  assert.equal(typo[0].match, 'fuzzy');
  assert.equal(typo[0].text, 'Fix login timeout');
  assert.equal(ocr.matchText(lines, 'Fix logn timeout', { boxKey: 'shot', exact: true }).length, 0);
  assert.equal(ocr.matchText(lines, 'login timeout Fix', { boxKey: 'shot' }).length, 0, 'word order matters');

  const part = ocr.matchText(lines, 'Settings', { boxKey: 'shot' });
  assert.equal(part[0].match, 'contains');
  assert.equal(part[0].text, 'panel:Settings');
  assert.ok(part[0].box.x > 58 && part[0].box.width < 112, 'narrowed to the matching part of a glued word');

  const dark = ocr.matchText(lines, 'Dark panel', { boxKey: 'shot', exact: true });
  assert.equal(dark.length, 0, 'exact does not reach into a glued word');
  const colon = ocr.matchText([line('Settings: Account', 10, 300)], 'settings', { boxKey: 'shot', exact: true });
  assert.equal(colon[0].text, 'Settings:', 'punctuation at a word edge does not block an exact match');
  assert.equal(colon[0].score, 0.97);

  const you = ocr.matchText(lines, 'you', { boxKey: 'shot' });
  assert.equal(you[0].text, 'you', 'the whole word ranks above "Your"');
  assert.ok(you.some((m) => m.text === 'Your'));
  assert.equal(ocr.matchText(lines, 'o', { boxKey: 'shot', limit: 2 }).length, 2);
  assert.deepEqual(ocr.matchText(lines, '   ', { boxKey: 'shot' }), []);
});

test('readingOrder: rows top to bottom, left to right within a row', () => {
  const lines = [line('B', 300, 101), line('A', 10, 99), line('C', 10, 140), line('top', 500, 20)];
  assert.deepEqual(ocr.readingOrder(lines, 'shot').map((l) => l.text), ['top', 'A', 'B', 'C']);
});

// ---------------------------------------------------------------- image preparation

test('normalizePolarity: light-on-dark boxes flip to dark-on-light, dark-on-light text stays', () => {
  const W = 64;
  const H = 32;
  const gray = new Uint8Array(W * H).fill(250);
  // Left half: a dark box (30) with light "strokes" (220); right half: dark strokes (20) on white.
  for (let y = 0; y < H; y++) for (let x = 0; x < 32; x++) gray[y * W + x] = 30;
  for (let y = 8; y < 24; y++) for (const x of [8, 9, 16, 17, 24]) gray[y * W + x] = 220;
  for (let y = 8; y < 24; y++) for (const x of [40, 41, 48, 56]) gray[y * W + x] = 20;
  ocr.normalizePolarity(gray, W, H, 8);
  assert.ok(gray[12 * W + 12] > 200, 'dark box background became light');
  assert.ok(gray[12 * W + 8] < 60, 'its light strokes became dark');
  assert.ok(gray[12 * W + 44] > 200, 'white page stays white');
  assert.ok(gray[12 * W + 40] < 60, 'dark text stays dark');
});

test('darkRegions + darkComposite + mapDarkWords: text in dark boxes gets its own clean, inverted pass', () => {
  const W = 160;
  const H = 96;
  const gray = new Uint8Array(W * H).fill(250);
  // A dark button (16..95 x 16..47) with light text strokes, and an empty black area (112..159 x 0..95).
  for (let y = 16; y < 48; y++) for (let x = 16; x < 96; x++) gray[y * W + x] = 40;
  for (let y = 26; y < 38; y++) for (let x = 28; x < 84; x += 5) gray[y * W + x] = 230;
  for (let y = 0; y < H; y++) for (let x = 112; x < W; x++) gray[y * W + x] = 0;
  const raw = gray.slice();
  const map = ocr.polarityMap(gray, W, H, 8);
  const regions = ocr.darkRegions(map, W, H);
  assert.equal(regions.length, 1, 'the empty black area holds no text: no region');
  const r = regions[0];
  assert.ok(r.x <= 28 && r.x + r.width >= 84 && r.y <= 26 && r.y + r.height >= 38, JSON.stringify(r));
  assert.ok(r.x + r.width <= 112, 'the region stays out of the empty black area');
  const comp = ocr.darkComposite(raw, W, H, regions);
  assert.equal(comp.bands.length, 1);
  const b = comp.bands[0];
  const at = (sx, sy) => comp.gray[(b.top + sy - r.y) * comp.width + comp.pad + sx - r.x];
  // Inverted, the box is 215 gray: its levels are stretched so it becomes white (255 / 215 gain).
  assert.equal(at(28, 30), Math.round((255 - 230) * (255 / 215)), 'light strokes become dark');
  assert.ok(at(28, 30) < 60);
  assert.equal(at(30, 30), 255, 'the dark box becomes white');
  assert.equal(comp.gray[0], 255, 'padding is white');
  // A word read in the composite at 2x maps back into the 2x main image.
  const words = ocr.mapDarkWords([{ text: 'Create', x: (comp.pad + 12) * 2, y: (b.top + 10) * 2, w: 40, h: 20, conf: 90 }, { text: 'gap', x: 0, y: 0, w: 4, h: 4, conf: 90 }], comp, 2);
  assert.deepEqual(words.map((w) => [w.text, w.x, w.y, w.w, w.h]), [['Create', (r.x + 12) * 2, (r.y + 10) * 2, 40, 20]], 'words outside any band are dropped');
  assert.equal(ocr.darkComposite(raw, W, H, []), null);
});

test('resizeGray, encodePgm and prepareImage geometry', () => {
  const g = new Uint8Array([0, 255, 255, 0]);
  const big = ocr.resizeGray(g, 2, 2, 4, 4);
  assert.equal(big.length, 16);
  assert.equal(big[0], 0);
  assert.equal(big[3], 255);
  const pgm = ocr.encodePgm(new Uint8Array([1, 2, 3, 4, 5, 6]), 3, 2);
  assert.equal(pgm.toString('ascii', 0, 11), 'P5\n3 2\n255\n');
  assert.deepEqual([...pgm.subarray(11)], [1, 2, 3, 4, 5, 6]);

  const buf = blankPng(400, 300);
  const hdr = png.readHeader(buf);
  const t = ocr.prepareImage(buf, hdr, { x: 100, y: 50, width: 200, height: 100 }, { engine: 'tesseract', pixelScale: 1 });
  assert.equal(t.kind, 'pgm');
  assert.deepEqual([t.width, t.height, t.sx, t.offset.x, t.offset.y], [400, 200, 2, 100, 50], 'small regions are read at 2x');
  const hi = ocr.prepareImage(buf, hdr, null, { engine: 'tesseract', pixelScale: 2 });
  assert.deepEqual([hi.width, hi.sx], [400, 1], 'HiDPI captures are not upscaled');
  const v = ocr.prepareImage(buf, hdr, null, { engine: 'vision', pixelScale: 1 });
  assert.equal(v.data, buf, 'Vision gets the original PNG untouched');
  const capped = ocr.prepareImage(buf, hdr, null, { engine: 'windows', upscale: 4, maxSide: 1000 });
  assert.deepEqual([capped.width, capped.height], [1000, 750], 'never beyond the engine maximum');
});

// ---------------------------------------------------------------- engines: plan, probe, run (faked)

test('enginePlan: native engine first, tesseract as fallback, ANYWHERE_OCR_ENGINE override', () => {
  assert.deepEqual(ocr.enginePlan({ platform: 'darwin' }), ['vision', 'tesseract']);
  assert.deepEqual(ocr.enginePlan({ platform: 'win32' }), ['windows', 'tesseract']);
  assert.deepEqual(ocr.enginePlan({ platform: 'linux', isWSL: true }), ['windows', 'tesseract']);
  assert.deepEqual(ocr.enginePlan({ platform: 'linux' }), ['tesseract']);
  assert.deepEqual(ocr.enginePlan({ platform: 'darwin', env: { ANYWHERE_OCR_ENGINE: 'tesseract' } }), ['tesseract']);
  assert.deepEqual(ocr.enginePlan({ platform: 'darwin', env: { ANYWHERE_OCR_ENGINE: 'none' } }), []);
  assert.deepEqual(ocr.enginePlan({ platform: 'linux', env: { ANYWHERE_OCR_ENGINE: 'bogus' } }), ['tesseract']);
  assert.deepEqual(ocr.bcp47List('en-US, de ,eng+deu,zh-Hans'), ['en-US', 'de', 'zh-Hans']);
  assert.equal(ocr.tesseractLanguage('deu+fra', ['eng', 'deu']), 'deu');
  assert.equal(ocr.tesseractLanguage('de-DE', ['deu', 'eng']), 'eng');
  assert.equal(ocr.tesseractLanguage('', ['chi_sim']), 'chi_sim');
  assert.deepEqual(ocr.tesseractPasses({ ANYWHERE_OCR_PSM: '11, 6' }), [11, 6]);
  assert.deepEqual(ocr.tesseractPasses({ ANYWHERE_OCR_PSM: 'x' }), ocr.DEFAULT_PASSES);
});

test('available: no engine gives {engine: null, hint} with the install command', async () => {
  const apt = fakeCtx({ tools: ['apt-get'] });
  const a = await ocr.available({}, apt);
  assert.equal(a.engine, null);
  assert.match(a.hint, /sudo apt install tesseract-ocr/);
  assert.match(a.hint, /screenshot/);
  const dnf = await ocr.available({}, fakeCtx({ tools: ['dnf'] }));
  assert.match(dnf.hint, /sudo dnf install tesseract/);
  const noLang = fakeCtx({ tools: ['tesseract', 'apt-get'], responses: { tesseract: { stdout: 'List of available languages in "/x" (1):\nosd\n' } } });
  const nl = await ocr.available({}, noLang);
  assert.equal(nl.engine, null);
  assert.match(nl.hint, /tesseract-ocr-eng/);
  const off = await ocr.available({}, fakeCtx({ env: { ANYWHERE_OCR_ENGINE: 'off' } }));
  assert.equal(off.engine, null);
  assert.match(off.hint, /turned off/);
  const mac = await ocr.available({}, fakeCtx({ platform: 'darwin', tools: ['osascript'], responses: { osascript: { stdout: '{"ok":false,"code":"UNSUPPORTED","error":"old"}' } } }));
  assert.equal(mac.engine, null);
  assert.match(mac.hint, /macOS 10\.15/);
  assert.match(mac.hint, /brew install tesseract/);
});

test('available: probes are cached, and a miss is re-checked', async () => {
  let n = 0;
  const ctx = fakeCtx({ tools: ['tesseract'], responses: { tesseract: () => (n++, { stdout: 'List of available languages in "/x" (1):\neng\n' }) } });
  assert.equal((await ocr.available({}, ctx)).engine, 'tesseract');
  assert.equal((await ocr.available({}, ctx)).engine, 'tesseract');
  assert.equal(n, 1);
  await ocr.available({ refresh: true }, ctx);
  assert.equal(n, 2);
  // Concurrent callers share one probe.
  const slow = fakeCtx({ tools: ['tesseract'], responses: { tesseract: async () => (n++, await new Promise((r) => setTimeout(r, 30)), { stdout: 'List of available languages in "/x" (1):\neng\n' }) } });
  const before = n;
  const all = await Promise.all([ocr.available({}, slow), ocr.available({}, slow), ocr.available({}, slow)]);
  assert.deepEqual(all.map((a) => a.engine), ['tesseract', 'tesseract', 'tesseract']);
  assert.equal(n - before, 1);
});

function tsvFor(words) {
  return ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext', ...words.map((w, i) => `5\t1\t1\t1\t1\t${i + 1}\t${w[1]}\t${w[2]}\t${w[3]}\t${w[4]}\t${w[5] || 95}\t${w[0]}`)].join('\n');
}

test('recognize (tesseract): parallel single-thread passes on a PGM, boxes mapped back to the PNG', async () => {
  const seen = [];
  const ctx = fakeCtx({
    tools: ['tesseract'],
    responses: {
      tesseract: (args, opts) => {
        if (args[0] === '--list-langs') return { stdout: 'List of available languages in "/x" (2):\neng\nosd\n' };
        seen.push({ args, opts, head: fs.readFileSync(args[0]).toString('ascii', 0, 2) });
        // The 200x100 region is read at 2x: "For you" at prepared (40, 20) 112x24.
        return { stdout: tsvFor([['For', 40, 20, 48, 24], ['you', 104, 20, 48, 24]]) };
      },
    },
  });
  const res = await ocr.recognize({ png: blankPng(400, 300), region: { x: 100, y: 50, width: 200, height: 100 } }, ctx);
  assert.equal(res.engine, 'tesseract');
  assert.equal(res.language, 'eng');
  assert.deepEqual(seen.map((s) => s.args[s.args.indexOf('--psm') + 1]).sort(), ['11', '3', '6']);
  for (const s of seen) {
    assert.equal(s.head, 'P5');
    assert.equal(s.opts.env.OMP_THREAD_LIMIT, '1');
    assert.deepEqual(s.args.slice(1, 4), ['stdout', '-l', 'eng']);
    assert.equal(s.args[s.args.length - 1], 'tsv');
  }
  assert.equal(res.lines.length, 1);
  assert.equal(res.lines[0].text, 'For you');
  assert.deepEqual(res.lines[0].bounds, { x: 120, y: 60, width: 56, height: 12 });
  assert.deepEqual(res.lines[0].words[1].bounds, { x: 152, y: 60, width: 24, height: 12 });
  assert.equal(res.lines[0].confidence, 0.95);
  assert.equal(fs.existsSync(path.dirname(seen[0].args[0])), false, 'temp files are removed');
});

test('recognize: no engine returns {engine: null, hint}; a failing engine hands over to the next', async () => {
  const none = await ocr.recognize({ png: blankPng(10, 10) }, fakeCtx({ tools: ['apt-get'] }));
  assert.equal(none.engine, null);
  assert.deepEqual(none.lines, []);
  assert.match(none.hint, /tesseract-ocr/);

  const dir = tmpDir();
  try {
    const ctx = fakeCtx({
      platform: 'linux',
      isWSL: true,
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      tools: ['powershell.exe', 'tesseract'],
      responses: {
        'powershell.exe': (args) => (args.includes('-Probe') ? { stdout: '{"ok":true,"engine":"windows","available":true,"language":"en-US","languages":["en-US"],"maxDimension":10000}' } : { code: 1, stdout: 'garbage', stderr: 'boom' }),
        tesseract: (args) => (args[0] === '--list-langs' ? { stdout: 'List of available languages in "/x" (1):\neng\n' } : { stdout: tsvFor([['Hello', 4, 4, 40, 10]]) }),
      },
      tmpdir: dir,
    });
    ctx.wslTemp = null;
    const res = await ocr.recognize({ png: blankPng(400, 300), upscale: 1 }, ctx);
    assert.equal(res.engine, 'tesseract');
    assert.match(res.notes.join(' '), /windows: Windows OCR failed/);
    assert.equal(ctx.cache.has('windows'), false, 'the failed engine is probed again next time');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recognize (Windows from WSL): staged script and image, Windows paths through wslpath -w', async () => {
  const dir = tmpDir();
  const winTemp = path.join(dir, 'wintemp');
  fs.mkdirSync(winTemp);
  try {
    const runs = [];
    const ctx = fakeCtx({
      platform: 'linux',
      isWSL: true,
      tools: ['powershell.exe', 'wslpath'],
      files: ['/mnt/c'],
      responses: {
        wslpath: (args) => ({ stdout: `C:\\Temp${args[1].slice(winTemp.length).replace(/\//g, '\\')}\n` }),
        'powershell.exe': (args, opts) => {
          const script = args[args.indexOf('-File') + 1];
          runs.push({ args, opts, script });
          if (args.includes('-Probe')) return { stdout: '{"ok":true,"engine":"windows","available":true,"language":"en-US","languages":["en-US"],"maxDimension":10000}' };
          return { stdout: WINDOWS_OUT };
        },
      },
      tmpdir: dir,
    });
    ctx.wslTemp = winTemp;
    const res = await ocr.recognize({ png: blankPng(1920, 1080), lang: 'de-DE' }, ctx);
    assert.equal(res.engine, 'windows');
    assert.deepEqual(res.lines[0].bounds, { x: 378, y: 273, width: 52, height: 14 }, 'a full HD capture is read at native size');
    const main = runs[runs.length - 1];
    assert.deepEqual(main.args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.match(main.script, /^C:\\Temp\\claude-anywhere-ocr-[^\\]+\\win32-ocr\.ps1$/);
    assert.match(main.args[main.args.indexOf('-ImagePath') + 1], /^C:\\Temp\\claude-anywhere-ocr-[^\\]+\\image\.png$/);
    assert.equal(main.args[main.args.indexOf('-Language') + 1], 'de-DE');
    assert.equal(main.opts.cwd, '/mnt/c');
    assert.deepEqual(fs.readdirSync(winTemp), [], 'the staged files are removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recognize (Vision on macOS): osascript runs darwin-ocr.js, boxes come back in pixels', async () => {
  const runs = [];
  const ctx = fakeCtx({
    platform: 'darwin',
    tools: ['osascript'],
    responses: {
      osascript: (args) => {
        runs.push(args);
        if (args.includes('--probe')) return { stdout: '{"ok":true,"engine":"vision","available":true,"languages":["en-US"]}' };
        return { stdout: VISION_OUT };
      },
    },
  });
  const res = await ocr.recognize({ png: blankPng(1000, 500) }, ctx);
  assert.equal(res.engine, 'vision');
  assert.deepEqual(res.lines[0].bounds, { x: 100, y: 80, width: 200, height: 20 });
  const main = runs[runs.length - 1];
  assert.deepEqual(main.slice(0, 3), ['-l', 'JavaScript', ocr.VISION_SCRIPT]);
  const opts = JSON.parse(main[4]);
  assert.equal(opts.correction, true);
  assert.ok(opts.minTextHeight > 0 && opts.minTextHeight < 0.05);
});

test('wslToWindowsPath / windowsToWslPath without wslpath', async () => {
  const ctx = fakeCtx({ env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' } });
  assert.equal(await ocr.wslToWindowsPath('/mnt/c/Users/me/x.png', ctx), 'C:\\Users\\me\\x.png');
  assert.equal(await ocr.wslToWindowsPath('/tmp/a/x.png', ctx), '\\\\wsl.localhost\\Ubuntu-22.04\\tmp\\a\\x.png');
  assert.equal(await ocr.windowsToWslPath('C:\\Users\\me\\AppData\\Local\\Temp', ctx), '/mnt/c/Users/me/AppData/Local/Temp');
});

// ---------------------------------------------------------------- Computer integration (fake Computer)

function fakeComputer({ lastShot = { width: 1229, height: 768 }, displays = [{ x: 0, y: 0, width: 1600, height: 1000 }], native = { width: 1600, height: 1000 } } = {}) {
  const calls = [];
  return {
    calls,
    async screenInfo() {
      return {
        displays: displays.map((d, i) => ({ index: i, ...d, scale: 1, primary: i === 0, lastShot: i === 0 ? lastShot : null })),
        lastShot: lastShot ? { display: 0, ...lastShot } : null,
      };
    },
    async screenshot(opts) {
      calls.push(opts);
      const shotW = lastShot && opts.display === 0 ? lastShot.width : displays[opts.display].width;
      const k = native.width / shotW; // native px per shot px
      const r = opts.region;
      const w = Math.round(r.width * k);
      const h = Math.round(r.height * k);
      return { png: blankPng(4, 4), width: w, height: h, display: opts.display, region: { ...r }, scale: (r.width * (displays[opts.display].width / shotW)) / w };
    },
  };
}

test('scanScreen/findText: native region capture, image pixels mapped to screenshot space', async () => {
  const comp = fakeComputer();
  let got;
  const recognize = async (o) => {
    got = o;
    // "For you" at native (400, 280) 52x14, "ABC-123" at native (30, 352) 58x10.
    return {
      engine: 'tesseract',
      lines: [
        { text: 'For you', bounds: { x: 400, y: 280, width: 52, height: 14 }, confidence: 0.97, words: [{ text: 'For', bounds: { x: 400, y: 280, width: 25, height: 14 }, confidence: 0.97 }, { text: 'you', bounds: { x: 431, y: 280, width: 21, height: 14 }, confidence: 0.97 }] },
        { text: 'ABC-123', bounds: { x: 30, y: 352, width: 58, height: 10 }, confidence: 0.92, words: [{ text: 'ABC-123', bounds: { x: 30, y: 352, width: 58, height: 10 }, confidence: 0.92 }] },
      ],
    };
  };
  const m = await ocr.findText(comp, { text: 'for you' }, { recognize });
  assert.deepEqual(comp.calls[0], { display: 0, region: { x: 0, y: 0, width: 1229, height: 768 }, maxWidth: ocr.MAX_SIDE, maxHeight: ocr.MAX_SIDE }, 'always a region shot: the mapping is left alone');
  assert.ok(Math.abs(got.pixelScale - 1) < 1e-9);
  const k = 1229 / 1600;
  assert.equal(m.length, 1);
  assert.equal(m[0].text, 'For you');
  assert.equal(m[0].display, 0);
  assert.equal(m[0].match, 'exact');
  // Within a pixel of the exact mapping (word boxes are rounded to whole screenshot pixels first).
  const want = { x: 400 * k, y: 280 * k, width: 52 * k, height: 14 * k, cx: (400 + 26) * k, cy: (280 + 7) * k };
  for (const key of Object.keys(want)) assert.ok(Math.abs(m[0].shot[key] - want[key]) <= 1, `${key}: ${m[0].shot[key]} vs ${want[key]}`);
  assert.ok(Object.values(m[0].shot).every(Number.isInteger));
  assert.equal(m.scan.engine, 'tesseract');
  assert.equal(m.scan.mapped, true);
  assert.equal(JSON.stringify(m).includes('scan'), false, 'the scan rides along without being serialized');

  // A region in screenshot space: the capture is still the whole display (exact mapping) and
  // recognize() gets the region in image pixels; results stay in whole-screenshot coordinates.
  const comp2 = fakeComputer();
  let got2;
  const m2 = await ocr.findText(
    comp2,
    { text: 'ABC-123', region: { x: 100, y: 200, width: 300, height: 100 } },
    {
      recognize: async (o) => {
        got2 = o;
        return { engine: 'tesseract', lines: [{ text: 'ABC-123', bounds: { x: 200, y: 300, width: 58, height: 10 }, confidence: 0.9, words: [] }] };
      },
    },
  );
  assert.deepEqual(comp2.calls[0].region, { x: 0, y: 0, width: 1229, height: 768 });
  const ky = 768 / 1000; // the downscaled screenshot's y scale differs a little from its x scale
  for (const [key, v] of Object.entries({ x: 100 / k, y: 200 / ky, width: 300 / k, height: 100 / ky })) assert.ok(Math.abs(got2.region[key] - v) < 1e-6, key);
  assert.deepEqual(m2.scan.region, { x: 100, y: 200, width: 300, height: 100 });
  assert.equal(m2[0].shot.x, Math.round(200 * k));
  assert.equal(m2[0].shot.y, Math.round(300 * ky));
  await assert.rejects(ocr.findText(comp2, { text: 'x', region: { x: 5000, y: 0, width: 10, height: 10 } }), (e) => e.code === 'OUT_OF_BOUNDS');
});

test('scanScreen: before any screenshot the shot space is the display logical space; HiDPI passes pixelScale', async () => {
  const comp = fakeComputer({ lastShot: null, displays: [{ x: 0, y: 0, width: 1440, height: 900 }], native: { width: 2880, height: 1800 } });
  let got;
  const scan = await ocr.scanScreen(comp, {}, { recognize: async (o) => ((got = o), { engine: 'vision', lines: [{ text: 'Hi', bounds: { x: 200, y: 100, width: 40, height: 20 }, confidence: 1, words: [] }] }) });
  assert.deepEqual(comp.calls[0].region, { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(got.region, undefined, 'the whole display is read');
  assert.equal(got.pixelScale, 2);
  assert.equal(scan.mapped, false);
  assert.equal(scan.lastDisplay, null);
  assert.deepEqual(scan.lines[0].shot, { x: 100, y: 50, width: 20, height: 10, cx: 110, cy: 55 });
});

test('findText: OCR_UNAVAILABLE without an engine, input checks', async () => {
  const comp = fakeComputer();
  await assert.rejects(
    ocr.findText(comp, { text: 'x' }, { recognize: async () => ({ engine: null, hint: 'sudo apt install tesseract-ocr' }) }),
    (e) => e.code === 'OCR_UNAVAILABLE' && /tesseract-ocr/.test(e.hint),
  );
  await assert.rejects(ocr.findText(comp, { text: '  ' }), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(ocr.findText(comp, { text: 'x', display: 3 }, { recognize: async () => ({ engine: 'x', lines: [] }) }), (e) => e.code === 'INVALID_INPUT' && /Display 3 does not exist/.test(e.message));
  await assert.rejects(ocr.findText({}, { text: 'x' }), (e) => e.code === 'INVALID_INPUT');
  const read = await ocr.readScreenText(comp, {}, { recognize: async () => ({ engine: 'windows', lines: [{ text: 'b', bounds: { x: 0, y: 500, width: 10, height: 10 }, confidence: null, words: [] }, { text: 'a', bounds: { x: 0, y: 10, width: 10, height: 10 }, confidence: null, words: [] }] }) });
  assert.deepEqual(read.lines.map((l) => l.text), ['a', 'b']);
  assert.equal(read.lines[0].words, undefined);
});

// ---------------------------------------------------------------- MCP tools

function toolSet(recognize, comp = fakeComputer()) {
  const posted = [];
  const lib = {
    ...ocr,
    findText: (c, o) => ocr.findText(c, o, { recognize }),
    readScreenText: (c, o) => ocr.readScreenText(c, o, { recognize }),
  };
  const tools = toolsOcr.createTools({ getComputer: async () => comp, postActivity: (p) => posted.push(p), deps: { ocr: lib } });
  return { tools: Object.fromEntries(tools.map((t) => [t.name, t])), posted, comp };
}

const SCREEN = {
  engine: 'tesseract',
  lines: [
    { text: 'Worked on', bounds: { x: 31, y: 273, width: 77, height: 11 }, confidence: 0.97, words: [{ text: 'Worked', bounds: { x: 31, y: 273, width: 54, height: 11 }, confidence: 0.97 }, { text: 'on', bounds: { x: 92, y: 276, width: 16, height: 8 }, confidence: 0.97 }] },
    { text: 'For you', bounds: { x: 378, y: 273, width: 52, height: 14 }, confidence: 0.97, words: [{ text: 'For', bounds: { x: 378, y: 273, width: 25, height: 11 }, confidence: 0.97 }, { text: 'you', bounds: { x: 409, y: 276, width: 21, height: 11 }, confidence: 0.97 }] },
    { text: 'ABC-123', bounds: { x: 28, y: 352, width: 59, height: 10 }, confidence: 0.92, words: [{ text: 'ABC-123', bounds: { x: 28, y: 352, width: 59, height: 10 }, confidence: 0.92 }] },
    { text: 'ABC-124', bounds: { x: 28, y: 397, width: 58, height: 10 }, confidence: 0.92, words: [{ text: 'ABC-124', bounds: { x: 28, y: 397, width: 58, height: 10 }, confidence: 0.92 }] },
  ],
};

test('tools-ocr: schemas and read-only annotations', () => {
  const { tools } = toolSet(async () => SCREEN);
  assert.deepEqual(Object.keys(tools), ['find_text', 'read_screen_text']);
  assert.deepEqual(tools.find_text.inputSchema.required, ['text']);
  assert.equal(tools.find_text.inputSchema.additionalProperties, false);
  for (const t of Object.values(tools)) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.properties.region.required.length, 4);
  }
});

test('find_text: click-ready centers, misses with suggestions, no engine is an error with the hint', async () => {
  const { tools, posted } = toolSet(async () => SCREEN);
  const res = await tools.find_text.handler({ text: 'For you' });
  assert.equal(res.isError, undefined);
  const text = res.content[0].text;
  const k = 1229 / 1600;
  assert.match(text, /^Found 1 match for "For you" on display 0 \(tesseract\)/);
  const c = /center \((\d+), (\d+)\)/.exec(text);
  assert.ok(c && Math.abs(c[1] - (378 + 26) * k) <= 1 && Math.abs(c[2] - (273 + 7) * k) <= 1, text);
  assert.match(text, /Coordinates are pixels of your latest screenshot of display 0/);
  assert.equal(posted[posted.length - 1].ok, true);

  const miss = await tools.find_text.handler({ text: 'ABC-125' });
  assert.equal(miss.isError, undefined);
  assert.match(miss.content[0].text, /No text matching "ABC-125"/);
  assert.match(miss.content[0].text, /Lines with similar words: "ABC-123" at/);

  const none = toolSet(async () => ({ engine: null, hint: 'Install Tesseract for on-screen text search: sudo apt install tesseract-ocr.' }));
  const r = await none.tools.find_text.handler({ text: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not available here\. Install Tesseract .*sudo apt install tesseract-ocr\. Take a screenshot/);

  await assert.rejects(tools.find_text.handler({ text: '' }), (e) => e.code === 'INVALID_INPUT');
  const failing = toolSet(async () => {
    throw Object.assign(new Error('tesseract crashed'), { code: 'OCR_FAILED' });
  });
  await assert.rejects(failing.tools.find_text.handler({ text: 'x' }), /tesseract crashed/);
  assert.equal(failing.posted[failing.posted.length - 1].ok, false);
});

test('find_text: another display than the latest screenshot asks for display in click', async () => {
  const comp = fakeComputer({ displays: [{ x: 0, y: 0, width: 1600, height: 1000 }, { x: 1600, y: 0, width: 1280, height: 1024 }] });
  const { tools } = toolSet(async () => SCREEN, comp);
  const res = await tools.find_text.handler({ text: 'For you', display: 1 });
  assert.match(res.content[0].text, /No screenshot of display 1 has been taken yet/);
  assert.match(res.content[0].text, /pass display: 1 to click/);
});

test('read_screen_text: lines in reading order with centers, truncated by maxLines', async () => {
  const { tools } = toolSet(async () => SCREEN);
  const res = await tools.read_screen_text.handler({ maxLines: 2 });
  const lines = res.content[0].text.split('\n');
  assert.match(lines[0], /^4 text lines on display 0 \(tesseract\), in reading order/);
  assert.match(lines[1], /^\(\d+, \d+\) \d+x\d+: Worked on$/);
  assert.match(lines[2], /: For you$/);
  assert.match(lines[3], /^\[2 more lines not shown/);
  const empty = toolSet(async () => ({ engine: 'vision', lines: [] }));
  assert.match((await empty.tools.read_screen_text.handler({})).content[0].text, /Apple Vision found no text/);
});

test('tools.js loads tools-ocr when it is listed in TOOL_MODULES', (t) => {
  const core = require('../src/mcp/tools');
  if (!core.TOOL_MODULES.includes('tools-ocr')) {
    t.skip('tools-ocr is not in TOOL_MODULES yet');
    return;
  }
  const names = core.createTools({ computer: async () => fakeComputer() }).map((x) => x.name);
  assert.ok(names.includes('find_text') && names.includes('read_screen_text'));
});

// ---------------------------------------------------------------- real tesseract (no display needed)

const TESSERACT = which('tesseract');
const CONVERT = which('convert');

test('real tesseract: light-on-dark text and UI labels are found with click-accurate boxes', { skip: !(TESSERACT && CONVERT) && 'needs tesseract and ImageMagick (convert)' }, async (t) => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'ui.png');
    const r = spawnSync(
      CONVERT,
      ['-size', '520x160', 'xc:white', '-fill', '#172b4d', '-pointsize', '16', '-annotate', '+20+40', 'For you', '-annotate', '+140+40', 'ABC-123 Fix login timeout',
        '-fill', '#1d2125', '-draw', 'rectangle 20,80 300,120', '-fill', '#c7d1db', '-annotate', '+36+106', 'Dark panel: Settings', file],
      { encoding: 'utf8', timeout: 30000 },
    );
    if (r.status !== 0) {
      t.skip(`ImageMagick could not render text: ${String(r.stderr).split('\n')[0]}`);
      return;
    }
    ocr._resetCache();
    const res = await ocr.recognize({ png: fs.readFileSync(file) });
    assert.equal(res.engine, 'tesseract');
    const find = (q) => ocr.matchText(res.lines, q, { boxKey: 'bounds' })[0];
    const inside = (m, x0, y0, x1, y1) => {
      const cx = m.box.x + m.box.width / 2;
      const cy = m.box.y + m.box.height / 2;
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    };
    const fy = find('For you');
    assert.ok(fy && fy.match === 'exact', JSON.stringify(res.lines.map((l) => l.text)));
    assert.ok(inside(fy, 20, 26, 90, 46), JSON.stringify(fy.box));
    const key = find('ABC-123');
    assert.ok(key && inside(key, 140, 26, 215, 46), JSON.stringify(key && key.box));
    const dark = find('Dark panel');
    assert.ok(dark, `light text on the dark box is read: ${JSON.stringify(res.lines.map((l) => l.text))}`);
    assert.ok(inside(dark, 20, 80, 300, 120), JSON.stringify(dark.box));
    assert.equal(ocr.matchText(res.lines, 'ABC-124', { boxKey: 'bounds' }).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- LIVE: Chromium under X11 (opt-in)

const CHROMIUM = process.env.ANYWHERE_LIVE_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LIVE =
  process.env.ANYWHERE_LIVE_OCR === '1' && process.platform === 'linux' && process.env.DISPLAY && TESSERACT && which('xdotool') && fs.existsSync(CHROMIUM);

test('LIVE: find_text on a Chromium page, click the result, the page reports the element', { skip: !LIVE && 'set ANYWHERE_LIVE_OCR=1 with DISPLAY, xdotool, tesseract and Chromium', timeout: 120000 }, async () => {
  const { getDriver } = require('../src/os/index');
  const { Computer } = require('../src/os/computer');
  const dir = tmpDir();
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(
    page,
    `<!doctype html><html><head><meta charset="utf-8"><title>OCR live</title><style>
body{margin:0;font-family:"DejaVu Sans",Arial,sans-serif} nav{display:flex;gap:28px;padding:16px 24px;font-size:15px}
.row{display:flex;gap:24px;padding:10px 24px;font-size:14px} .key{color:#0052cc}
button{margin:12px 24px;font-size:14px;padding:8px 16px;background:#0052cc;color:#fff;border:0}
.dark{background:#1d2125;color:#c7d1db;padding:12px 24px;margin:12px 24px;font-size:14px}</style></head><body>
<nav><span id="t-worked">Worked on</span><span id="t-foryou">For you</span><span id="t-starred">Starred</span></nav>
<div class="row"><span class="key" id="k1">ABC-123</span><span id="s1">Fix login timeout</span></div>
<button id="b1">Create issue</button><div class="dark" id="dk">Dark panel: Settings</div>
<script>document.addEventListener('click',(e)=>{document.title='clicked:'+(e.target.id||e.target.tagName)})</script></body></html>`,
  );
  const child = spawn(CHROMIUM, ['--no-sandbox', `--user-data-dir=${path.join(dir, 'prof')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-position=0,0', '--window-size=1200,800', `file://${page}`], { stdio: 'ignore', detached: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const title = () => {
    const r = spawnSync('xdotool', ['search', '--pid', String(child.pid), '--name', '.', 'getwindowname', '%@'], { encoding: 'utf8' });
    return String(r.stdout || '');
  };
  const driver = await getDriver();
  try {
    for (let i = 0; i < 60 && !/OCR live/.test(title()); i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 1000));
    const comp = new Computer({ driver, config: { failsafe: false, actionDelayMs: 50 } });
    await comp.screenshot({ display: 0 });
    for (const [text, id] of [['For you', 't-foryou'], ['ABC-123', 'k1'], ['Fix login timeout', 's1'], ['Create issue', 'b1'], ['Dark panel', 'dk']]) {
      const m = await ocr.findText(comp, { text });
      assert.ok(m.length, `"${text}" found: ${JSON.stringify(m.scan.lines.map((l) => l.text))}`);
      await comp.click({ x: m[0].shot.cx, y: m[0].shot.cy });
      await new Promise((r) => setTimeout(r, 300));
      assert.match(title(), new RegExp(`clicked:${id}\\b`), `click on "${text}" at (${m[0].shot.cx}, ${m[0].shot.cy}): ${title()}`);
    }
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL'); // Chromium and its helper processes
    } catch {
      child.kill('SIGKILL');
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (typeof driver.close === 'function') await driver.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
