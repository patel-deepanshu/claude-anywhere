'use strict';

/*
 * Claude Anywhere macOS OCR: a standalone JXA (JavaScript for Automation) script that runs
 * Apple's Vision text recognizer (VNRecognizeTextRequest, macOS 10.15+) on an image file.
 *
 *   osascript -l JavaScript darwin-ocr.js <image.png> ['<json options>']
 *   osascript -l JavaScript darwin-ocr.js --probe
 *
 * Options (all optional): {"languages":["en-US","de-DE"], "fast":false, "correction":true,
 *   "minTextHeight":0.004, "words":true, "autoLanguage":true}
 *
 * Prints one ASCII-only JSON line (non-ASCII as \uXXXX, so no pipe encoding can garble it):
 *   {"ok":true,"engine":"vision","lines":[{"text":"For you","confidence":0.98,
 *     "box":[x,y,w,h],"words":[{"text":"For","start":0,"end":3,"box":[x,y,w,h]|null},...]}]}
 *   {"ok":false,"code":"UNSUPPORTED"|"BAD_ARGS"|"OCR_FAILED","error":"..."}
 * Boxes are Vision's normalized rectangles (0..1 of the image, origin at the BOTTOM-left);
 * src/os/ocr.js (parseVisionOutput) converts them to image pixels with a top-left origin. A word
 * box is null when Vision could not give one; ocr.js then splits the line box by characters.
 *
 * ObjC bridging notes (JXA): zero-argument methods are read as properties (alloc, init, results,
 * count, string, boundingBox), setters are called as methods (setRecognitionLevel(0)), enum values
 * are passed as numbers (VNRequestTextRecognitionLevelAccurate = 0, Fast = 1) because Vision ships
 * no BridgeSupport, CGRect results arrive as {origin:{x,y}, size:{width,height}}, and NSError**
 * arguments take Ref() (read back as ref[0]) or $() for "don't care".
 *
 * Written in conservative ES5. It touches ObjC, $ and Ref only through the env object handed to
 * recognize()/probe(), so Node can syntax-check it and unit-test it with fakes
 * (test/desktop-ocr.test.js); module.exports exists only under Node.
 */

/* global ObjC, $, Ref */

var VISION_LEVEL_ACCURATE = 0; // VNRequestTextRecognitionLevelAccurate
var VISION_LEVEL_FAST = 1; // VNRequestTextRecognitionLevelFast
var MAX_LANGUAGES = 8;

function asciiJson(value) {
  var s = JSON.stringify(value === undefined ? null : value);
  return s.replace(/[\u007f-￿]/g, function (c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

function failure(code, message) {
  return { ok: false, code: code, error: String(message) };
}

function isNil(v) {
  if (v === null || v === undefined) return true;
  try {
    return typeof v.isNil === 'function' && v.isNil() === true;
  } catch (e) {
    return true;
  }
}

/** NSString (or JS string) -> JS string; '' for nil. */
function str(env, v) {
  if (typeof v === 'string') return v;
  if (isNil(v)) return '';
  try {
    var s = env.ObjC.unwrap(v);
    if (typeof s === 'string') return s;
  } catch (e) {
    /* fall through */
  }
  try {
    if (typeof v.js === 'string') return v.js;
  } catch (e2) {
    /* ignore */
  }
  return '';
}

function finite(v, dflt) {
  var n = Number(v);
  return isFinite(n) ? n : dflt;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** CGRect struct -> [x, y, w, h] (normalized, bottom-left origin), or null when unusable. */
function boxOf(r) {
  if (!r || !r.origin || !r.size) return null;
  var x = Number(r.origin.x);
  var y = Number(r.origin.y);
  var w = Number(r.size.width);
  var h = Number(r.size.height);
  if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
  return [round6(x), round6(y), round6(w), round6(h)];
}

function count(arr) {
  if (isNil(arr)) return 0;
  var n = Number(arr.count);
  return isFinite(n) && n > 0 ? n : 0;
}

/** An NSRange for a struct argument: $.NSMakeRange when the bridge has it, else a plain struct object. */
function makeRange(env, location, length) {
  try {
    if (typeof env.$.NSMakeRange === 'function') return env.$.NSMakeRange(location, length);
  } catch (e) {
    /* plain object below */
  }
  return { location: location, length: length };
}

/**
 * Words of a recognized line with their own boxes (VNRecognizedText boundingBoxForRange:error:).
 * Offsets are UTF-16 code units, the unit both NSString ranges and JS strings use.
 */
function wordsOf(env, candidate, text) {
  var out = [];
  var re = /\S+/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var box = null;
    try {
      var obs = candidate.boundingBoxForRangeError(makeRange(env, m.index, m[0].length), env.$());
      if (!isNil(obs)) box = boxOf(obs.boundingBox);
    } catch (e) {
      box = null;
    }
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length, box: box });
  }
  return out;
}

function parseOptions(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  var o;
  try {
    o = JSON.parse(String(raw));
  } catch (e) {
    throw new Error('options must be JSON: ' + e.message);
  }
  return o && typeof o === 'object' ? o : {};
}

function languageList(v) {
  var out = [];
  if (!v || typeof v.length !== 'number' || typeof v === 'string') return out;
  for (var i = 0; i < v.length && out.length < MAX_LANGUAGES; i++) {
    var s = String(v[i] || '').trim();
    if (/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(s)) out.push(s.replace(/_/g, '-'));
  }
  return out;
}

function importVision(env) {
  try {
    env.ObjC.import('Foundation');
    env.ObjC.import('Vision');
  } catch (e) {
    return failure('UNSUPPORTED', 'The Vision framework could not be loaded (' + (e && e.message) + '); it needs macOS 10.15 or newer.');
  }
  if (typeof env.$.VNRecognizeTextRequest === 'undefined' || env.$.VNRecognizeTextRequest === null) {
    return failure('UNSUPPORTED', 'This macOS has no VNRecognizeTextRequest; text recognition needs macOS 10.15 or newer.');
  }
  return null;
}

/** --probe: whether Vision text recognition exists here, and its languages. */
function probe(env) {
  var bad = importVision(env);
  if (bad) return bad;
  var languages = [];
  try {
    var req = env.$.VNRecognizeTextRequest.alloc.init;
    req.setRecognitionLevel(VISION_LEVEL_ACCURATE);
    var list = null;
    if (typeof req.supportedRecognitionLanguagesAndReturnError === 'function') {
      list = req.supportedRecognitionLanguagesAndReturnError(env.$()); // macOS 12+
    } else if (typeof env.$.VNRecognizeTextRequest.supportedRecognitionLanguagesForTextRecognitionLevelRevisionError === 'function') {
      list = env.$.VNRecognizeTextRequest.supportedRecognitionLanguagesForTextRecognitionLevelRevisionError(VISION_LEVEL_ACCURATE, 1, env.$());
    }
    for (var i = 0; i < count(list) && languages.length < 64; i++) languages.push(str(env, list.objectAtIndex(i)));
  } catch (e) {
    languages = [];
  }
  return { ok: true, engine: 'vision', available: true, languages: languages };
}

/**
 * Recognize the text in an image file.
 * @param {{ObjC:object, $:Function, Ref:Function}} env the JXA globals (or fakes under Node)
 * @param {string} path image file (PNG, JPEG, TIFF...)
 * @param {object} [opts] see the header
 * @returns {object} the JSON-ready result
 */
function recognize(env, path, opts) {
  var o = opts || {};
  if (typeof path !== 'string' || !path) return failure('BAD_ARGS', 'usage: darwin-ocr.js <image file> [json options]');
  var bad = importVision(env);
  if (bad) return bad;

  var url = env.$.NSURL.fileURLWithPath(path);
  // Vision declares the options dictionary nonnull: pass an empty one rather than nil.
  var handler = env.$.VNImageRequestHandler.alloc.initWithURLOptions(url, env.$.NSDictionary.dictionary);
  var req = env.$.VNRecognizeTextRequest.alloc.init; // no completion handler: results are read below
  req.setRecognitionLevel(o.fast === true ? VISION_LEVEL_FAST : VISION_LEVEL_ACCURATE);
  req.setUsesLanguageCorrection(o.correction !== false);
  var langs = languageList(o.languages);
  if (langs.length) req.setRecognitionLanguages(env.$(langs));
  else if (o.autoLanguage !== false) {
    try {
      // macOS 13+: pick the language per image; older systems lack the selector (ignored).
      if (typeof req.setAutomaticallyDetectsLanguage === 'function') req.setAutomaticallyDetectsLanguage(true);
    } catch (e) {
      /* older macOS */
    }
  }
  var minH = finite(o.minTextHeight, 0);
  if (minH > 0 && minH < 1) req.setMinimumTextHeight(minH);

  var err = env.Ref();
  var ok = handler.performRequestsError(env.$.NSArray.arrayWithObject(req), err);
  if (ok !== true && Number(ok) !== 1) {
    var why = '';
    try {
      if (err && !isNil(err[0])) why = str(env, err[0].localizedDescription);
    } catch (e) {
      why = '';
    }
    return failure('OCR_FAILED', 'Vision could not read the image' + (why ? ': ' + why : '') + ' (' + path + ')');
  }

  var results = req.results;
  var n = count(results);
  var lines = [];
  for (var i = 0; i < n; i++) {
    var obs = results.objectAtIndex(i);
    if (isNil(obs)) continue;
    var cands = obs.topCandidates(1);
    if (count(cands) < 1) continue;
    var top = cands.objectAtIndex(0);
    var text = str(env, top.string);
    if (!text || !/\S/.test(text)) continue;
    var box = boxOf(obs.boundingBox);
    if (!box) continue;
    var line = { text: text, confidence: round6(finite(top.confidence, 0)), box: box };
    if (o.words !== false) line.words = wordsOf(env, top, text);
    lines.push(line);
  }
  return { ok: true, engine: 'vision', lines: lines };
}

function jxaEnv() {
  return { ObjC: ObjC, $: $, Ref: Ref };
}

/** osascript entry point: the returned string is printed on stdout. */
// eslint-disable-next-line no-unused-vars
function run(argv) {
  var args = argv || [];
  var out;
  try {
    if (args[0] === '--probe') out = probe(jxaEnv());
    else out = recognize(jxaEnv(), args[0], parseOptions(args[1]));
  } catch (e) {
    out = failure('OCR_FAILED', (e && e.message) || String(e));
  }
  return asciiJson(out);
}

if (typeof module !== 'undefined' && module && module.exports) {
  module.exports = { run: run, recognize: recognize, probe: probe, wordsOf: wordsOf, boxOf: boxOf, asciiJson: asciiJson, languageList: languageList, parseOptions: parseOptions };
}
