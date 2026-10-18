'use strict';

/**
 * Model catalog of the cloned voice and call audio (docs/CALLS-DESIGN.md §3.3).
 *
 * Every asset is a free model from the sherpa-onnx GitHub releases (k2-fsa/sherpa-onnx), pinned by
 * size and sha256 (measured 2026-10-18). Release assets can be replaced upstream, so a mismatch is
 * an actionable error ("upstream file changed; update Claude Anywhere"), never a silent accept.
 *
 * Layout on disk: <modelsRoot>/<asset id>/… with only the files the runtime needs (the `files`
 * roles plus `keep`); archives are unpacked through a staging folder and everything else (test
 * clips, fp32 duplicates) is dropped. `<modelsRoot>/<id>/.installed.json` records the verified
 * sha256, so status checks never re-hash hundreds of megabytes.
 *
 * Download sources, in order: ANYWHERE_CLONE_ASSET_BASE (a mirror with the same relative paths),
 * then the GitHub release. A file the user placed in <modelsRoot>/downloads/<name> by hand (for
 * locked-down networks) is used when its sha256 matches. Hugging Face is not used: it is often
 * blocked (it was in the research sandbox), and these GitHub assets are identical.
 */

const path = require('path');

const DEFAULT_ASSET_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/';

// uv (MIT/Apache-2.0, astral-sh/uv): only when no usable Python exists (or its venv module is
// broken). Its own python-build-standalone download goes to <state>/voice/python.
const UV_VERSION = '0.11.32';
const DEFAULT_UV_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/`;
const UV_ASSETS = Object.freeze({
  'linux:x64': { name: 'uv-x86_64-unknown-linux-gnu.tar.gz', sha256: 'aab924fd522efd06f1c5f3b93a243864fc453132c94b2dc49f1371b528a4b967' },
  'linux:arm64': { name: 'uv-aarch64-unknown-linux-gnu.tar.gz', sha256: '4d4fa08d95b06642e5800df6a22bd71455f23f988269e18da2847971d8c0bf31' },
  'darwin:x64': { name: 'uv-x86_64-apple-darwin.tar.gz', sha256: '77f5ca26c0de20e992a3677a174fe1121ee25c36f9b1434a863f75bf077a05eb' },
  'darwin:arm64': { name: 'uv-aarch64-apple-darwin.tar.gz', sha256: 'ed336d0ba49db8ef89b2b41fffa372ce63bd032f22a56f001c265891aec32829' },
  'win32:x64': { name: 'uv-x86_64-pc-windows-msvc.zip', sha256: 'acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984' },
  'win32:arm64': { name: 'uv-aarch64-pc-windows-msvc.zip', sha256: 'a7427ea0440bb826b6716d1837ff3d173b8e7d496cb09ee8f456b4e023a2fdcd' },
});

const MB = 1024 * 1024;

/**
 * @typedef {object} Asset
 * @property {string} id
 * @property {'tts'|'vocoder'|'vad'|'asr'|'spk'} kind
 * @property {string} path         release path under the asset base
 * @property {number} bytes        download size
 * @property {string} sha256       of the download
 * @property {'tar.bz2'|null} archive
 * @property {string|null} topDir  the archive's top folder
 * @property {Object<string,string>} files  role → path relative to the asset folder (a folder for data_dir)
 * @property {string[]} keep       other files kept (licenses, the bench reference)
 * @property {number} diskBytes    about the size on disk once unpacked and pruned
 * @property {string} license
 * @property {string} use
 * @property {string} [note]
 */

/** @type {Readonly<Object<string, Asset>>} */
const ASSETS = Object.freeze({
  'pocket-int8': Object.freeze({
    id: 'pocket-int8',
    kind: 'tts',
    engine: 'pocket',
    path: 'tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2',
    bytes: 98336520,
    sha256: '2f3b88823cbbb9bf0b2477ec8ae7b3fec417b3a87b6bb5f256dba66f2ad967cb',
    archive: 'tar.bz2',
    topDir: 'sherpa-onnx-pocket-tts-int8-2026-01-26',
    files: Object.freeze({
      lm_flow: 'lm_flow.int8.onnx',
      lm_main: 'lm_main.int8.onnx',
      encoder: 'encoder.onnx',
      decoder: 'decoder.int8.onnx',
      text_conditioner: 'text_conditioner.onnx',
      vocab_json: 'vocab.json',
      token_scores_json: 'token_scores.json',
    }),
    // bria.wav is the model's own sample voice, used only to time `bench` (never returned as audio).
    keep: Object.freeze(['LICENSE', 'README.md', 'test_wavs/bria.wav']),
    benchReference: 'test_wavs/bria.wav',
    diskBytes: 200 * MB,
    license: 'Kyutai Pocket TTS: code MIT, weights CC-BY-4.0 (see LICENSE in the folder)',
    note: "The archive's README also says \"non-commercial\", which conflicts with its CC-BY-4.0 LICENSE file: check Kyutai's model card before redistributing.",
    use: 'cloned voice (default)',
  }),
  'zipvoice-int8': Object.freeze({
    id: 'zipvoice-int8',
    kind: 'tts',
    engine: 'zipvoice',
    path: 'tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2',
    bytes: 109162785,
    sha256: '77219c8b40f4ee8d73a7f902305ff6c1128ef9b54461c41b4ca6ed890b6c2803',
    archive: 'tar.bz2',
    topDir: 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia',
    files: Object.freeze({
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      tokens: 'tokens.txt',
      lexicon: 'lexicon.txt',
      data_dir: 'espeak-ng-data',
    }),
    keep: Object.freeze(['test_wavs/news-female.wav', 'test_wavs/prompt.txt']),
    benchReference: 'test_wavs/news-female.wav',
    diskBytes: 152 * MB,
    license: 'ZipVoice: code Apache-2.0; weights not stated, trained on Emilia (CC-BY-NC-4.0 data): treat as non-commercial',
    note: 'Opt-in "quality voice": shown with its non-commercial note in the enrollment A/B.',
    use: 'quality cloned voice (opt-in)',
  }),
  'vocos-24k': Object.freeze({
    id: 'vocos-24k',
    kind: 'vocoder',
    path: 'vocoder-models/vocos_24khz.onnx',
    bytes: 54157409,
    sha256: 'bcb3b970e384161c4d634f0bb9e999ff1c471b34c9bc0b1049a5014065ed3cc0',
    archive: null,
    topDir: null,
    files: Object.freeze({ model: 'vocos_24khz.onnx' }),
    keep: Object.freeze([]),
    diskBytes: 52 * MB,
    license: 'Vocos: MIT',
    use: 'ZipVoice vocoder',
  }),
  'silero-vad': Object.freeze({
    id: 'silero-vad',
    kind: 'vad',
    path: 'asr-models/silero_vad.onnx',
    bytes: 643854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    archive: null,
    topDir: null,
    files: Object.freeze({ model: 'silero_vad.onnx' }),
    keep: Object.freeze([]),
    diskBytes: 1 * MB,
    license: 'Silero VAD: MIT',
    use: 'voice activity detection',
  }),
  'moonshine-base-int8': Object.freeze({
    id: 'moonshine-base-int8',
    kind: 'asr',
    asr: 'moonshine',
    path: 'asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2',
    bytes: 250807309,
    sha256: '21870cecaa2e44e4e2bf63e02d1072bed183ccd10284871353bd9d24dad14e5e',
    archive: 'tar.bz2',
    topDir: 'sherpa-onnx-moonshine-base-en-int8',
    files: Object.freeze({
      preprocessor: 'preprocess.onnx',
      encoder: 'encode.int8.onnx',
      uncached_decoder: 'uncached_decode.int8.onnx',
      cached_decoder: 'cached_decode.int8.onnx',
      tokens: 'tokens.txt',
    }),
    keep: Object.freeze(['LICENSE']),
    diskBytes: 274 * MB,
    license: 'Moonshine: MIT',
    use: 'speech recognition (default)',
  }),
  'whisper-tiny-en': Object.freeze({
    id: 'whisper-tiny-en',
    kind: 'asr',
    asr: 'whisper',
    path: 'asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2',
    bytes: 118071777,
    sha256: '2bd6cf965c8bb3e068ef9fa2191387ee63a9dfa2a4e37582a8109641c20005dd',
    archive: 'tar.bz2',
    topDir: 'sherpa-onnx-whisper-tiny.en',
    files: Object.freeze({
      encoder: 'tiny.en-encoder.int8.onnx',
      decoder: 'tiny.en-decoder.int8.onnx',
      tokens: 'tiny.en-tokens.txt',
    }),
    keep: Object.freeze([]),
    diskBytes: 99 * MB,
    license: 'Whisper: MIT',
    use: 'speech recognition (small)',
  }),
  'parakeet-v2-int8': Object.freeze({
    id: 'parakeet-v2-int8',
    kind: 'asr',
    asr: 'parakeet',
    path: 'asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    bytes: 482468385,
    sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
    archive: 'tar.bz2',
    topDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    files: Object.freeze({
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    }),
    keep: Object.freeze([]),
    diskBytes: 630 * MB,
    license: 'Parakeet TDT 0.6B v2: CC-BY-4.0',
    use: 'speech recognition (accurate)',
  }),
  'spk-3dspeaker': Object.freeze({
    id: 'spk-3dspeaker',
    kind: 'spk',
    // The upstream release tag really is spelled "recongition".
    path: 'speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
    bytes: 39593761,
    sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
    archive: null,
    topDir: null,
    files: Object.freeze({ model: '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx' }),
    keep: Object.freeze([]),
    diskBytes: 38 * MB,
    license: '3D-Speaker ERes2Net: Apache-2.0',
    use: 'speaker consistency (enrollment)',
  }),
});

/** Clone engines: their assets, default steps and output rate. */
const ENGINES = Object.freeze({
  pocket: Object.freeze({ id: 'pocket', assets: Object.freeze(['pocket-int8']), defaultSteps: 5, sampleRate: 24000, needsReferenceText: false }),
  zipvoice: Object.freeze({ id: 'zipvoice', assets: Object.freeze(['zipvoice-int8', 'vocos-24k']), defaultSteps: 3, sampleRate: 24000, needsReferenceText: true }),
});

/** Speech-recognition choices (calls.stt.model) → asset and sidecar model name. */
const STT = Object.freeze({
  moonshine: Object.freeze({ asset: 'moonshine-base-int8', model: 'moonshine' }),
  'whisper-tiny': Object.freeze({ asset: 'whisper-tiny-en', model: 'whisper' }),
  whisper: Object.freeze({ asset: 'whisper-tiny-en', model: 'whisper' }),
  parakeet: Object.freeze({ asset: 'parakeet-v2-int8', model: 'parakeet' }),
});

const DEFAULT_ENGINE = 'pocket';
const DEFAULT_STT = 'moonshine';

/** @returns {Asset} @throws on an unknown id */
function getAsset(id) {
  const a = Object.prototype.hasOwnProperty.call(ASSETS, id) ? ASSETS[id] : null;
  if (!a) {
    const e = new Error(`Unknown clone model asset "${id}"`);
    e.code = 'BAD_ASSET';
    throw e;
  }
  return a;
}

/** @returns {string} a known engine id ('pocket' for anything else) */
function engineId(engine) {
  return Object.prototype.hasOwnProperty.call(ENGINES, engine) ? engine : DEFAULT_ENGINE;
}

/** @returns {{asset:string, model:string}} the STT choice ('moonshine' for anything else) */
function sttChoice(stt) {
  return Object.prototype.hasOwnProperty.call(STT, stt) ? STT[stt] : STT[DEFAULT_STT];
}

/**
 * The asset base URLs to try, in order: the mirror (constructor option or
 * ANYWHERE_CLONE_ASSET_BASE), then the GitHub release.
 * @param {{base?:string, env?:object, defaultBase?:string}} [opts]
 * @returns {string[]}
 */
function assetBases({ base, env = process.env, defaultBase = DEFAULT_ASSET_BASE } = {}) {
  const out = [];
  for (const b of [base, env && env.ANYWHERE_CLONE_ASSET_BASE, defaultBase]) {
    const s = String(b || '').trim();
    if (!s) continue;
    const norm = s.endsWith('/') ? s : `${s}/`;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * The download URLs of an asset, in the order to try.
 * @param {string} id
 * @param {{base?:string, env?:object}} [opts]
 * @returns {string[]}
 */
function assetUrls(id, opts = {}) {
  const a = getAsset(id);
  return assetBases(opts).map((b) => `${b}${a.path}`);
}

/** @returns {string} the file name of the asset's download */
function downloadName(id) {
  return path.posix.basename(getAsset(id).path);
}

/**
 * Where an asset lives once installed.
 * @param {string} id
 * @param {string} root the models root (<state>/voice/clone-models)
 * @returns {{id:string, dir:string, marker:string, files:Object<string,string>, keep:string[], benchReference:string|null}}
 */
function assetPaths(id, root) {
  const a = getAsset(id);
  const dir = path.join(root, id);
  const files = {};
  for (const [role, rel] of Object.entries(a.files)) files[role] = path.join(dir, ...rel.split('/'));
  return {
    id,
    dir,
    marker: path.join(dir, '.installed.json'),
    files,
    keep: a.keep.map((rel) => path.join(dir, ...rel.split('/'))),
    benchReference: a.benchReference ? path.join(dir, ...a.benchReference.split('/')) : null,
  };
}

/**
 * The assets a configuration needs.
 * @param {object} [config] the full config, or {engine, stt, extras}
 * @returns {string[]} asset ids (each once, in install order: small and essential first)
 */
function requiredAssets(config = {}) {
  const c = config || {};
  const engine = engineId(c.engine || (c.voice && c.voice.clone && c.voice.clone.engine));
  const stt = sttChoice(c.stt || (c.calls && c.calls.stt && c.calls.stt.model));
  const ids = ['silero-vad', 'spk-3dspeaker', ...ENGINES.pocket.assets, stt.asset];
  // ZipVoice is opt-in; Pocket stays installed for live speech when ZipVoice is too slow (§3.2).
  if (engine === 'zipvoice') ids.push(...ENGINES.zipvoice.assets);
  for (const x of Array.isArray(c.extras) ? c.extras : []) if (Object.prototype.hasOwnProperty.call(ASSETS, x)) ids.push(x);
  return [...new Set(ids)];
}

/** @returns {number} the total download size of asset ids */
function totalBytes(ids) {
  return ids.reduce((n, id) => n + getAsset(id).bytes, 0);
}

/** @returns {number} about the disk space the asset ids need once unpacked */
function totalDiskBytes(ids) {
  return ids.reduce((n, id) => n + getAsset(id).diskBytes, 0);
}

/**
 * The `models.check` spec of asset ids: [{id, dir, files:[absolute paths]}].
 * @param {string[]} ids
 * @param {string} root
 */
function checkSpec(ids, root) {
  return ids.map((id) => {
    const p = assetPaths(id, root);
    return { id, dir: p.dir, files: Object.values(p.files) };
  });
}

/**
 * Parameters of the sidecar's `tts.load` for an engine.
 * @param {string} engine 'pocket' | 'zipvoice'
 * @param {string} root the models root
 * @param {{threads?:number, provider?:string, steps?:number}} [opts]
 */
function ttsLoadParams(engine, root, { threads = 2, provider = 'cpu', steps = 0 } = {}) {
  const e = ENGINES[engineId(engine)];
  const main = assetPaths(e.assets[0], root);
  const params = { engine: e.id, dir: main.dir, files: main.files, threads, provider, steps: steps > 0 ? steps : e.defaultSteps };
  if (e.id === 'zipvoice') params.vocoder = assetPaths('vocos-24k', root).files.model;
  return params;
}

/**
 * Parameters of the sidecar's `asr.load` for a calls.stt.model value.
 * @param {string} stt 'moonshine' | 'whisper-tiny' | 'parakeet'
 * @param {string} root
 * @param {{threads?:number, provider?:string}} [opts]
 */
function asrLoadParams(stt, root, { threads = 2, provider = 'cpu' } = {}) {
  const s = sttChoice(stt);
  const p = assetPaths(s.asset, root);
  return { model: s.model, dir: p.dir, files: p.files, threads, provider };
}

/** Parameters of the sidecar's `vad.load`. */
function vadLoadParams(root, { threshold = 0.5, minSilenceMs = 600, minSpeechMs = 250 } = {}) {
  return { model: assetPaths('silero-vad', root).files.model, threshold, minSilenceMs, minSpeechMs };
}

/** Parameters of the sidecar's `spk.load`. */
function spkLoadParams(root, { threads = 2, provider = 'cpu' } = {}) {
  return { model: assetPaths('spk-3dspeaker', root).files.model, threads, provider };
}

/**
 * The uv release asset for an OS and CPU.
 * @returns {{name:string, sha256:string, url:string, kind:'tar.gz'|'zip', exe:string}|null}
 */
function uvAsset(platform, arch, { base, env = process.env } = {}) {
  const a = UV_ASSETS[`${platform}:${arch}`];
  if (!a) return null;
  const b = String(base || (env && env.ANYWHERE_CLONE_UV_BASE) || DEFAULT_UV_BASE);
  return { ...a, url: `${b.endsWith('/') ? b : `${b}/`}${a.name}`, kind: a.name.endsWith('.zip') ? 'zip' : 'tar.gz', exe: platform === 'win32' ? 'uv.exe' : 'uv' };
}

module.exports = {
  DEFAULT_ASSET_BASE,
  DEFAULT_UV_BASE,
  UV_VERSION,
  UV_ASSETS,
  ASSETS,
  ENGINES,
  STT,
  DEFAULT_ENGINE,
  DEFAULT_STT,
  getAsset,
  engineId,
  sttChoice,
  assetBases,
  assetUrls,
  downloadName,
  assetPaths,
  requiredAssets,
  totalBytes,
  totalDiskBytes,
  checkSpec,
  ttsLoadParams,
  asrLoadParams,
  vadLoadParams,
  spkLoadParams,
  uvAsset,
};
