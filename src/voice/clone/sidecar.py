#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Claude Anywhere voice sidecar, protocol v1 (docs/CALLS-DESIGN.md section 3.4).

One process covers cloned-voice TTS (Kyutai Pocket TTS or ZipVoice through sherpa-onnx), speech
recognition (Moonshine, Whisper tiny.en or Parakeet), voice activity detection (Silero), speaker
embeddings (3D-Speaker ERes2Net) and, through the optional audio_io.py plug-in, live call audio.
Everything runs locally; nothing here opens a network connection.

Run (the venv's python, never the user's packages):
    <venv python> -I -u -X utf8 sidecar.py --state <state dir> --models <models dir>

Transport: stdin/stdout, UTF-8 JSON, one object per line (at most 1 MB). Audio is never inline,
only file paths, which must lie under --state (inputs and outputs) or --models (model files).
    request   {"id": <int|str>, "op": "<name>", ...params}
    response  {"id", "ok": true, ...result} | {"id", "ok": false, "error", "code", "hint"?}
    event     {"event": "<name>", ...}            (no "ok"; may carry the "id" of a request)
At start the sidecar prints {"event":"ready","protocol":1,...} (the same fields as `hello`).

Safeguard (a): there is NO operation that takes a free audio path to clone from. The only way to
set the voice is `tts.setVoice {profileDir}`, which requires a folder directly under
<state>/voice/clone/profiles/ whose manifest.json says consent.verified is true and whose
reference.wav matches the manifest's sha256. `enroll.build` writes reference.wav only from takes
inside <state>/voice/clone/sessions/<id>/ and never writes the manifest (Node does, after the
consent check). `bench` uses the model's own bundled sample voice and returns only timings.

Fake mode (ANYWHERE_CLONE_FAKE=1 or --fake) imports neither numpy nor sherpa-onnx: TTS writes a
deterministic tone (length proportional to the text), ASR returns the text of <wav>.txt, speaker
embeddings come from a speaker key (the text of <wav>.spk, else the take's folder name; a JSON
number array in <wav>.spk is used as the embedding itself), so tests run with any python3.

Live audio plug-in (audio_io.py next to this file, owned by the call-audio builder):
    def register(host) -> dict      # op name -> handler(params: dict, ctx) -> dict | None
Handler keys may be "audio.<name>", "record.<name>", "tts.say", plus the lifecycle keys
"tts.stop" (called after the sidecar cancels synthesis) and "shutdown" (called once at exit).
Handlers run on the "audio" worker thread, except "audio.stop" and "tts.stop", which run on the
reader thread and must return within about 50 ms. Long work (playback, capture loops) belongs on
the plug-in's own threads; report progress with ctx.emit(...) / host.emit(...). See class Host.
"""

import sys
import os

sys.dont_write_bytecode = True  # never write __pycache__ into the (possibly read-only) package folder

# --- stdout hygiene: the protocol owns the original stdout; stray prints go to stderr. -------------
PROTO = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8", errors="replace", newline="\n")
os.dup2(2, 1)
sys.stdout = sys.stderr

import argparse  # noqa: E402
import array  # noqa: E402
import hashlib  # noqa: E402
import importlib.util  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import platform  # noqa: E402
import queue  # noqa: E402
import re  # noqa: E402
import signal  # noqa: E402
import struct  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# -I leaves the script's folder off sys.path; append it (after the stdlib) for audio_io's own imports.
if SCRIPT_DIR not in sys.path:
    sys.path.append(SCRIPT_DIR)

PROTOCOL = 1
MAX_LINE = 1024 * 1024
MAX_TEXT = 2000
MAX_WAV_BYTES = 200 * 1024 * 1024
MAX_REF_BYTES = 20 * 1024 * 1024
REF_RATE = 24000
PROFILE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ENGINE_FILES = {
    "pocket": ("lm_flow", "lm_main", "encoder", "decoder", "text_conditioner", "vocab_json", "token_scores_json"),
    "zipvoice": ("encoder", "decoder", "tokens", "lexicon", "data_dir"),
}
DEFAULT_FILES = {
    "pocket": {
        "lm_flow": "lm_flow.int8.onnx",
        "lm_main": "lm_main.int8.onnx",
        "encoder": "encoder.onnx",
        "decoder": "decoder.int8.onnx",
        "text_conditioner": "text_conditioner.onnx",
        "vocab_json": "vocab.json",
        "token_scores_json": "token_scores.json",
    },
    "zipvoice": {
        "encoder": "encoder.int8.onnx",
        "decoder": "decoder.int8.onnx",
        "tokens": "tokens.txt",
        "lexicon": "lexicon.txt",
        "data_dir": "espeak-ng-data",
    },
    "moonshine": {
        "preprocessor": "preprocess.onnx",
        "encoder": "encode.int8.onnx",
        "uncached_decoder": "uncached_decode.int8.onnx",
        "cached_decoder": "cached_decode.int8.onnx",
        "tokens": "tokens.txt",
    },
    "whisper": {"encoder": "tiny.en-encoder.int8.onnx", "decoder": "tiny.en-decoder.int8.onnx", "tokens": "tiny.en-tokens.txt"},
    "parakeet": {"encoder": "encoder.int8.onnx", "decoder": "decoder.int8.onnx", "joiner": "joiner.int8.onnx", "tokens": "tokens.txt"},
}
DEFAULT_STEPS = {"pocket": 5, "zipvoice": 3}
# The models' own sample voices: used only by `bench` to time synthesis (fixed paths, no params).
BENCH_REFERENCE = {
    "pocket": ("test_wavs/bria.wav", None),
    "zipvoice": ("test_wavs/news-female.wav", "test_wavs/prompt.txt"),
}
BENCH_TEXT = "Sure, give me a second while I pull that up for you."
WARMUP_TEXT = "Okay, one moment."
# Pocket TTS sometimes keeps generating after a very short sentence ("Okay." made 14 s of audio in
# 33 s on the test VM, 3 times in 4). sherpa-onnx reads a per-sentence frame cap from
# GenerationConfig.extra["max_frames"] (Pocket runs at 12.5 frames/s): allow 1.5 s + 0.09 s per
# character of the longest sentence, and retry once when a one-sentence text hits the cap.
POCKET_FPS = 12.5
HOOK_KEY_RE = re.compile(r"^(audio|record)\.[A-Za-z][A-Za-z0-9_]{0,40}$")
INLINE_HOOKS = ("audio.stop",)

FAKE = False
np = None  # numpy, in real mode
sherpa = None  # sherpa_onnx, in real mode
RUNTIME_ERROR = None


class SidecarError(Exception):
    """An error with a protocol code (MODEL_MISSING, PROFILE_INVALID, BAD_REQUEST, ...)."""

    def __init__(self, code, message, hint=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.hint = hint


def log(*parts):
    try:
        sys.stderr.write("[sidecar] " + " ".join(str(p) for p in parts) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


# ------------------------------------------------------------------------------------- protocol out

_write_lock = threading.Lock()


def _json_default(o):
    if np is not None:
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
    if isinstance(o, (set, tuple)):
        return list(o)
    return str(o)


def _clean_floats(o):
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _clean_floats(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean_floats(v) for v in o]
    return o


def write_obj(obj):
    try:
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_json_default, allow_nan=False)
    except ValueError:
        line = json.dumps(_clean_floats(obj), ensure_ascii=False, separators=(",", ":"), default=_json_default)
    if len(line) > MAX_LINE // 4 and len(line.encode("utf-8")) > MAX_LINE:
        rid = obj.get("id") if isinstance(obj, dict) else None
        line = json.dumps({"id": rid, "ok": False, "error": "The result is larger than 1 MB", "code": "INTERNAL"})
    with _write_lock:
        try:
            PROTO.write(line + "\n")
            PROTO.flush()
        except (BrokenPipeError, OSError, ValueError):
            # Node is gone: nothing left to serve.
            os._exit(0)


def emit(event, **fields):
    obj = {"event": event}
    obj.update(fields)
    write_obj(obj)


# ------------------------------------------------------------------------------------- paths

class Paths(object):
    state = ""
    models = ""
    profiles = ""
    sessions = ""
    tmp = ""


def _real(p):
    return os.path.realpath(os.path.abspath(p))


def _norm(p):
    return os.path.normcase(_real(p))


def is_inside(child, parent):
    c = _norm(child)
    p = _norm(parent)
    return c == p or c.startswith(p.rstrip("\\/") + os.sep)


def _need_str(params, key, what=None, required=True, max_len=4096):
    v = params.get(key)
    if v is None or v == "":
        if required:
            raise SidecarError("BAD_REQUEST", "Missing %s" % (what or key))
        return None
    if not isinstance(v, str) or len(v) > max_len or "\x00" in v:
        raise SidecarError("BAD_REQUEST", "Invalid %s" % (what or key))
    return v


def input_file(path, roots, what="file"):
    """An existing regular file inside one of `roots` (after resolving links)."""
    if not isinstance(path, str) or not path or "\x00" in path:
        raise SidecarError("BAD_REQUEST", "Invalid %s path" % what)
    real = _real(path)
    if not any(is_inside(real, r) for r in roots if r):
        raise SidecarError("BAD_REQUEST", "The %s must be inside the Claude Anywhere state folder" % what)
    if not os.path.isfile(real):
        raise SidecarError("BAD_REQUEST", "The %s does not exist: %s" % (what, os.path.basename(path)))
    return real


def output_file(path, exts=(".wav",), what="output"):
    """A writable path under --state whose folder exists and whose extension is allowed."""
    if not isinstance(path, str) or not path or "\x00" in path:
        raise SidecarError("BAD_REQUEST", "Invalid %s path" % what)
    full = os.path.abspath(path)
    parent = os.path.dirname(full)
    if not os.path.isdir(parent):
        raise SidecarError("BAD_REQUEST", "The %s folder does not exist" % what)
    if not is_inside(parent, Paths.state):
        raise SidecarError("BAD_REQUEST", "The %s must be inside the Claude Anywhere state folder" % what)
    if exts and not full.lower().endswith(tuple(exts)):
        raise SidecarError("BAD_REQUEST", "The %s must end with %s" % (what, " or ".join(exts)))
    if os.path.islink(full) or os.path.isdir(full):
        raise SidecarError("BAD_REQUEST", "The %s path is a link or a folder" % what)
    return os.path.join(_real(parent), os.path.basename(full))


def model_path(path, what="model file", want_dir=False):
    if not isinstance(path, str) or not path or "\x00" in path:
        raise SidecarError("BAD_REQUEST", "Invalid %s path" % what)
    real = _real(path)
    if not is_inside(real, Paths.models):
        raise SidecarError("BAD_REQUEST", "The %s must be inside the models folder" % what)
    ok = os.path.isdir(real) if want_dir else os.path.isfile(real)
    if not ok:
        raise SidecarError("MODEL_MISSING", "Missing %s: %s" % (what, os.path.basename(path)),
                           "Install the voice models: anywhere clone-voice install")
    return real


def tmp_path(suffix=".wav"):
    try:
        os.makedirs(Paths.tmp, mode=0o700, exist_ok=True)
    except OSError:
        pass
    return os.path.join(Paths.tmp, "sc-%d-%d-%s%s" % (os.getpid(), int(time.time() * 1000), os.urandom(3).hex(), suffix))


def write_private(path, data):
    """Write bytes atomically with mode 0600 (0700 folders are the caller's job)."""
    tmp = "%s.%d.%s.tmp" % (path, os.getpid(), os.urandom(3).hex())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------------------------- WAV

def parse_wav(data):
    """-> (fmt_tag, channels, rate, bits, pcm bytes). Accepts PCM 8/16/24/32-bit, float32, extensible."""
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise SidecarError("BAD_REQUEST", "Not a WAV file")
    off = 12
    fmt = None
    while off + 8 <= len(data):
        cid = data[off:off + 4]
        size = struct.unpack_from("<I", data, off + 4)[0]
        body = off + 8
        if cid == b"fmt " and body + 16 <= len(data):
            tag, ch, rate, _br, _ba, bits = struct.unpack_from("<HHIIHH", data, body)
            if tag == 0xFFFE and size >= 40 and body + 26 <= len(data):
                tag = struct.unpack_from("<H", data, body + 24)[0]
            fmt = (tag, ch, rate, bits)
        elif cid == b"data" and fmt:
            end = len(data) if size in (0, 0xFFFFFFFF) or body + size > len(data) else body + size
            tag, ch, rate, bits = fmt
            if ch < 1 or ch > 8 or rate < 4000 or rate > 192000:
                raise SidecarError("BAD_REQUEST", "Unsupported WAV format (%d channels, %d Hz)" % (ch, rate))
            if not ((tag == 1 and bits in (8, 16, 24, 32)) or (tag == 3 and bits == 32)):
                raise SidecarError("BAD_REQUEST", "Unsupported WAV encoding (format %d, %d bits)" % (tag, bits))
            return tag, ch, rate, bits, data[body:end]
        off = body + size + (size % 2)
    raise SidecarError("BAD_REQUEST", "The WAV file has no audio data")


def read_wav_bytes(path, limit=MAX_WAV_BYTES):
    size = os.path.getsize(path)
    if size > limit:
        raise SidecarError("BAD_REQUEST", "The audio file is too large (%d MB)" % (size // (1024 * 1024)))
    with open(path, "rb") as f:
        return f.read()


def wav_duration(path):
    tag, ch, rate, bits, pcm = parse_wav(read_wav_bytes(path))
    return len(pcm) / float(ch * (bits // 8) * rate), rate


def read_wav(path, limit=MAX_WAV_BYTES):
    """-> (mono float32 numpy array in [-1, 1], rate). Real mode only."""
    tag, ch, rate, bits, pcm = parse_wav(read_wav_bytes(path, limit))
    width = bits // 8
    n = len(pcm) // (width * ch) * (width * ch)
    pcm = pcm[:n]
    if tag == 3:
        x = np.frombuffer(pcm, dtype="<f4").astype(np.float32)
    elif bits == 8:
        x = (np.frombuffer(pcm, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif bits == 16:
        x = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    elif bits == 24:
        b = np.frombuffer(pcm, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        x = v.astype(np.float32) / float(1 << 23)
    else:
        x = np.frombuffer(pcm, dtype="<i4").astype(np.float32) / 2147483648.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return np.ascontiguousarray(np.clip(x, -1.0, 1.0), dtype=np.float32), rate


def wav_header(rate, nbytes):
    return struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + nbytes, b"WAVE", b"fmt ", 16, 1, 1, rate, rate * 2, 2, 16, b"data", nbytes)


def pcm16_from_float(x):
    if np is not None and isinstance(x, np.ndarray):
        return (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    a = array.array("h", (int(max(-1.0, min(1.0, v)) * 32767) for v in x))
    if sys.byteorder == "big":
        a.byteswap()
    return a.tobytes()


def write_wav(path, samples, rate):
    """16-bit mono WAV, atomically, mode 0600. `samples`: floats (numpy array or sequence)."""
    pcm = pcm16_from_float(samples)
    write_private(path, wav_header(rate, len(pcm)) + pcm)
    return len(pcm) // 2


def read_pcm16_mono(path):
    """Pure-python reader (fake mode): -> (array('h') mono, rate)."""
    tag, ch, rate, bits, pcm = parse_wav(read_wav_bytes(path))
    if tag != 1 or bits != 16:
        raise SidecarError("BAD_REQUEST", "Fake mode reads 16-bit PCM WAV only")
    a = array.array("h")
    a.frombytes(pcm[: len(pcm) // 2 * 2])
    if sys.byteorder == "big":
        a.byteswap()
    if ch > 1:
        a = array.array("h", a[0::ch])
    return a, rate


def resample(x, sr_in, sr_out):
    """Band-limited resampling through the FFT (offline clips; numpy only)."""
    if sr_in == sr_out or len(x) == 0:
        return x
    n_out = int(round(len(x) * float(sr_out) / sr_in))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float32)
    spec = np.fft.rfft(x.astype(np.float64))
    out_bins = n_out // 2 + 1
    new = np.zeros(out_bins, dtype=np.complex128)
    k = min(out_bins, len(spec))
    new[:k] = spec[:k]
    y = np.fft.irfft(new, n_out) * (float(n_out) / len(x))
    return y.astype(np.float32)


def trim_silence(x, rate, pad_s=0.15):
    frame = max(1, int(rate * 0.02))
    n = len(x) // frame
    if n < 3:
        return x
    rms = np.sqrt(np.mean(np.square(x[: n * frame].reshape(n, frame)), axis=1) + 1e-12)
    noise = float(np.percentile(rms, 10))
    speech = float(np.percentile(rms, 90))
    thr = max(noise * 3.16, 0.003, speech * 0.05)
    idx = np.nonzero(rms > thr)[0]
    if len(idx) == 0:
        return x
    pad = int(pad_s * rate)
    start = max(0, int(idx[0]) * frame - pad)
    end = min(len(x), (int(idx[-1]) + 1) * frame + pad)
    return x[start:end]


def normalize(x, target_dbfs=-20.0, peak_dbfs=-1.0):
    rms = float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0
    if rms < 1e-6:
        return x
    gain = (10 ** (target_dbfs / 20.0)) / rms
    peak = float(np.max(np.abs(x))) * gain
    limit = 10 ** (peak_dbfs / 20.0)
    if peak > limit:
        gain *= limit / peak
    return (x * gain).astype(np.float32)


# ------------------------------------------------------------------------------------- text

def clean_text(text, max_len=MAX_TEXT):
    if not isinstance(text, str):
        raise SidecarError("BAD_REQUEST", "text must be a string")
    t = re.sub(r"\s+", " ", text.replace("\x00", " ")).strip()
    if not t:
        raise SidecarError("BAD_REQUEST", "Nothing to speak")
    if len(t) > max_len:
        raise SidecarError("BAD_REQUEST", "The text is longer than %d characters" % max_len)
    return t


def split_clauses(text):
    """Clauses for live speech (§6.4): at . ! ?, at , ; : once 4+ words, and at 12 words."""
    words = re.sub(r"\s+", " ", str(text or "")).strip().split(" ")
    out, cur = [], []
    for w in words:
        if not w:
            continue
        cur.append(w)
        n = len(cur)
        if re.search(r"[.!?]['\")\]]*$", w) or (n >= 4 and re.search(r"[,;:]$", w)) or n >= 12:
            out.append(" ".join(cur))
            cur = []
    if cur:
        out.append(" ".join(cur))
    return out


def split_sentences(text):
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p for p in parts if p]


def pocket_max_frames(text):
    longest = max([len(x) for x in split_sentences(text)] or [len(text)])
    return int(max(25, min(600, math.ceil(POCKET_FPS * (1.5 + 0.09 * longest)))))


# ------------------------------------------------------------------------------------- engines

def _num(params, key, default, lo, hi, integer=False):
    v = params.get(key, default)
    if v is None:
        v = default
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise SidecarError("BAD_REQUEST", "%s must be a number" % key)
    v = max(lo, min(hi, v))
    return int(v) if integer else float(v)


def _provider(params):
    p = params.get("provider") or "cpu"
    if p not in ("cpu", "cuda", "coreml"):
        raise SidecarError("BAD_REQUEST", "provider must be cpu, cuda or coreml")
    return p


def resolve_files(kind, params, roles=None):
    """Model files from params.files (absolute, inside --models) or params.dir + default names."""
    names = DEFAULT_FILES[kind]
    files = params.get("files") if isinstance(params.get("files"), dict) else {}
    base = params.get("dir")
    out = {}
    missing = []
    for role in roles or names.keys():
        p = files.get(role)
        if not p:
            if not base:
                raise SidecarError("BAD_REQUEST", "Missing dir or files.%s" % role)
            p = os.path.join(base, *names[role].split("/"))
        try:
            out[role] = model_path(p, "%s %s" % (kind, role), want_dir=(role == "data_dir"))
        except SidecarError as e:
            if e.code != "MODEL_MISSING":
                raise
            missing.append(os.path.basename(str(p)))
    if missing:
        raise SidecarError("MODEL_MISSING", "The %s model is incomplete (missing %s)" % (kind, ", ".join(missing)),
                           "Install the voice models: anywhere clone-voice install")
    return out


def need_runtime():
    if FAKE:
        return
    if sherpa is None or np is None:
        raise SidecarError("RUNTIME_MISSING", "The voice runtime (sherpa-onnx) is not installed: %s" % (RUNTIME_ERROR or "import failed"),
                           "Reinstall it: anywhere clone-voice install")


class TtsEngine(object):
    def __init__(self, engine, files, vocoder, threads, provider, steps):
        self.engine = engine
        self.files = files
        self.vocoder = vocoder
        self.threads = threads
        self.provider = provider
        self.steps = steps
        self.sample_rate = REF_RATE
        self.tts = None

    def load(self):
        if FAKE:
            return
        f = self.files
        if self.engine == "pocket":
            m = sherpa.OfflineTtsModelConfig(
                pocket=sherpa.OfflineTtsPocketModelConfig(
                    lm_flow=f["lm_flow"], lm_main=f["lm_main"], encoder=f["encoder"], decoder=f["decoder"],
                    text_conditioner=f["text_conditioner"], vocab_json=f["vocab_json"], token_scores_json=f["token_scores_json"]),
                num_threads=self.threads, provider=self.provider)
        else:
            m = sherpa.OfflineTtsModelConfig(
                zipvoice=sherpa.OfflineTtsZipvoiceModelConfig(
                    tokens=f["tokens"], encoder=f["encoder"], decoder=f["decoder"], vocoder=self.vocoder,
                    data_dir=f["data_dir"], lexicon=f["lexicon"]),
                num_threads=self.threads, provider=self.provider)
        cfg = sherpa.OfflineTtsConfig(model=m, max_num_sentences=1)
        if not cfg.validate():
            raise SidecarError("MODEL_MISSING", "The %s model files are not valid" % self.engine, "Reinstall: anywhere clone-voice install --force")
        self.tts = sherpa.OfflineTts(cfg)
        self.sample_rate = int(self.tts.sample_rate)

    def generate(self, text, ref, steps=None, speed=None, on_chunk=None, cancel=None):
        """-> (samples, rate, first_chunk_ms, cancelled). ref: {"samples", "rate", "text"}."""
        t0 = time.perf_counter()
        state = {"first": None, "index": 0, "cancelled": False}

        if FAKE:
            return fake_tone(text, self.sample_rate, on_chunk, cancel, t0)

        def cb(samples, _progress):
            if state["first"] is None:
                state["first"] = (time.perf_counter() - t0) * 1000.0
            if on_chunk is not None:
                try:
                    on_chunk(samples, state["index"])
                except Exception as e:  # a consumer must not break synthesis
                    log("chunk consumer failed:", e)
            state["index"] += 1
            if cancel is not None and cancel.is_set():
                state["cancelled"] = True
                return 0
            return 1

        g = sherpa.GenerationConfig()
        g.reference_audio = ref["samples"]
        g.reference_sample_rate = int(ref["rate"])
        if self.engine == "zipvoice":
            g.reference_text = ref.get("text") or ""
        n = steps if steps else self.steps
        if n:
            g.num_steps = int(n)
        if speed:
            g.speed = float(speed)
        cap = None
        if self.engine == "pocket":
            cap = pocket_max_frames(text)
            try:
                g.extra = {"max_frames": str(cap)}
            except Exception:  # an older runtime without extra: no cap
                cap = None
        audio = self.tts.generate(text, g, callback=cb)
        samples = np.asarray(audio.samples, dtype=np.float32)
        rate = int(audio.sample_rate)
        stopped = state["cancelled"] or bool(cancel is not None and cancel.is_set())
        if cap and not stopped and len(split_sentences(text)) <= 1 and len(samples) >= 0.9 * cap * rate / POCKET_FPS:
            # It ran to the cap: babble after the words. Sampling is random, so one retry usually ends cleanly.
            log("pocket hit the frame cap (%d frames) for %d characters; retrying once" % (cap, len(text)))
            again = self.tts.generate(text, g)
            other = np.asarray(again.samples, dtype=np.float32)
            if 0 < len(other) < len(samples):
                samples = other
        return samples, rate, state["first"], stopped


def fake_tone(text, rate, on_chunk, cancel, t0):
    """A deterministic tone: 0.06 s per character (0.3-30 s), one chunk per sentence."""
    seconds = max(0.3, min(30.0, 0.06 * len(text)))
    freq = 220.0 + int(hashlib.sha1(text.encode("utf-8")).hexdigest()[:4], 16) % 200
    total = int(seconds * rate)
    sentences = split_sentences(text) or [text]
    weights = [max(1, len(s)) for s in sentences]
    out = array.array("f")
    first = None
    done = 0
    cancelled = False
    for i, w in enumerate(weights):
        n = total - done if i == len(weights) - 1 else int(total * w / float(sum(weights)))
        chunk = array.array("f", (0.3 * math.sin(2 * math.pi * freq * (done + k) / rate) for k in range(n)))
        done += n
        out.extend(chunk)
        if first is None:
            first = (time.perf_counter() - t0) * 1000.0
        if on_chunk is not None:
            on_chunk(chunk, i)
        if cancel is not None and cancel.is_set():
            cancelled = True
            break
    return out, rate, first, cancelled


class AsrEngine(object):
    def __init__(self, model, files, threads, provider):
        self.model = model
        self.files = files
        self.threads = threads
        self.provider = provider
        self.rec = None

    def load(self):
        if FAKE:
            return
        f = self.files
        if self.model == "moonshine":
            self.rec = sherpa.OfflineRecognizer.from_moonshine(
                preprocessor=f["preprocessor"], encoder=f["encoder"], uncached_decoder=f["uncached_decoder"],
                cached_decoder=f["cached_decoder"], tokens=f["tokens"], num_threads=self.threads, provider=self.provider)
        elif self.model == "whisper":
            self.rec = sherpa.OfflineRecognizer.from_whisper(
                encoder=f["encoder"], decoder=f["decoder"], tokens=f["tokens"], language="en", task="transcribe",
                num_threads=self.threads, provider=self.provider)
        else:
            self.rec = sherpa.OfflineRecognizer.from_transducer(
                encoder=f["encoder"], decoder=f["decoder"], joiner=f["joiner"], tokens=f["tokens"],
                num_threads=self.threads, provider=self.provider, model_type="nemo_transducer")
        # Warm the graph once (the first decode is several times slower).
        self.transcribe(np.zeros(8000, dtype=np.float32), 16000)

    def transcribe(self, samples, rate):
        if FAKE:
            return ""
        st = self.rec.create_stream()
        st.accept_waveform(int(rate), samples)
        self.rec.decode_stream(st)
        return str(st.result.text or "").strip()


def new_vad(model, threshold=0.5, min_silence_ms=600, min_speech_ms=250, rate=16000, max_speech_s=20.0):
    cfg = sherpa.VadModelConfig()
    cfg.silero_vad.model = model
    cfg.silero_vad.threshold = float(threshold)
    cfg.silero_vad.min_silence_duration = float(min_silence_ms) / 1000.0
    cfg.silero_vad.min_speech_duration = float(min_speech_ms) / 1000.0
    cfg.silero_vad.max_speech_duration = float(max_speech_s)
    cfg.silero_vad.window_size = 512
    cfg.sample_rate = int(rate)
    cfg.num_threads = 1
    return sherpa.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)


def vad_segments(model, x, rate, threshold, min_silence_ms, min_speech_ms):
    if rate != 16000:
        x = resample(x, rate, 16000)
    vad = new_vad(model, threshold, min_silence_ms, min_speech_ms, 16000)
    segs = []
    win = 512
    for i in range(0, len(x), win):
        vad.accept_waveform(x[i:i + win])
        while not vad.empty():
            f = vad.front
            segs.append((f.start, f.start + len(f.samples)))
            vad.pop()
    vad.flush()
    while not vad.empty():
        f = vad.front
        segs.append((f.start, f.start + len(f.samples)))
        vad.pop()
    return [(a / 16000.0, b / 16000.0) for a, b in segs], x


def fake_embedding(path):
    """Fake mode: a 64-dim unit vector from the speaker key (see the module docstring)."""
    key = os.path.basename(os.path.dirname(path)) or "speaker"
    spk = path + ".spk"
    if os.path.isfile(spk):
        with open(spk, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        try:
            v = json.loads(raw)
            if isinstance(v, list) and v and all(isinstance(x, (int, float)) for x in v):
                return _unit([float(x) for x in v])
        except ValueError:
            pass
        key = raw or key
    dim = 64
    base = [0.0] * dim
    base[int(hashlib.sha256(key.encode("utf-8")).hexdigest(), 16) % dim] = 1.0
    h = hashlib.sha256(os.path.basename(path).encode("utf-8")).digest() * 2
    return _unit([b + ((h[i] / 255.0) - 0.5) * 0.04 for i, b in enumerate(base)])


def _unit(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _cos(a, b):
    n = min(len(a), len(b))
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(x * x for x in a[:n])) or 1.0
    nb = math.sqrt(sum(x * x for x in b[:n])) or 1.0
    return dot / (na * nb)


# ------------------------------------------------------------------------------------- state

class State(object):
    def __init__(self):
        self.tts = None  # TtsEngine
        self.voice = None  # {"samples", "rate", "text", "seconds", "sha256", "profile", "engine"}
        self.asr = None  # AsrEngine
        self.vad = None  # {"model", "threshold", "minSilenceMs", "minSpeechMs"}
        self.spk = None  # sherpa SpeakerEmbeddingExtractor (or "fake")
        self.spk_dim = 0
        self.tts_lock = threading.Lock()
        self.asr_lock = threading.Lock()
        self.spk_lock = threading.Lock()
        self.active = {}  # request id -> Ctx
        self.active_lock = threading.Lock()
        self.hooks = {}
        self.audio_io = {"available": False}
        self.shutting_down = False


S = State()


class Ctx(object):
    """Per-request context handed to op handlers and plug-in hooks."""

    def __init__(self, rid, op):
        self.id = rid
        self.op = op
        self.cancel = threading.Event()
        self.host = HOST

    def emit(self, event, **fields):
        obj = {"event": event, "id": self.id}
        obj.update(fields)
        write_obj(obj)


# ------------------------------------------------------------------------------------- the host API

class Host(object):
    """What audio_io.py may use. Synthesis always uses the consented voice set by tts.setVoice."""

    protocol = PROTOCOL
    SidecarError = SidecarError

    @property
    def fake(self):
        return FAKE

    @property
    def state_dir(self):
        return Paths.state

    @property
    def models_dir(self):
        return Paths.models

    @property
    def numpy(self):
        return np

    def emit(self, event, **fields):
        emit(event, **fields)

    def log(self, *parts):
        log(*parts)

    def tts_ready(self):
        return S.tts is not None and S.voice is not None

    def tts_sample_rate(self):
        return S.tts.sample_rate if S.tts is not None else REF_RATE

    def synthesize(self, text, on_chunk=None, cancel=None, speed=None, steps=None):
        """Speak `text` in the enrolled voice. on_chunk(samples, index) gets float32 audio as it is made
        (numpy arrays; array('f') in fake mode). Returns {samples, sampleRate, firstChunkMs, totalMs, cancelled}."""
        return synthesize(clean_text(text), on_chunk=on_chunk, cancel=cancel, speed=speed, steps=steps)

    def split_clauses(self, text):
        return split_clauses(text)

    def asr_ready(self):
        return S.asr is not None

    def transcribe(self, samples, rate):
        """Text of mono float32 audio (fake mode: env ANYWHERE_CLONE_FAKE_TRANSCRIPT or "")."""
        if FAKE:
            return os.environ.get("ANYWHERE_CLONE_FAKE_TRANSCRIPT", "")
        if S.asr is None:
            raise SidecarError("MODEL_MISSING", "Speech recognition is not loaded (asr.load first)")
        with S.asr_lock:
            return S.asr.transcribe(samples, rate)

    def vad_model(self):
        return S.vad["model"] if S.vad else None

    def new_vad(self, threshold=0.5, min_silence_ms=600, min_speech_ms=250, sample_rate=16000):
        """A fresh sherpa VoiceActivityDetector (None in fake mode or before vad.load)."""
        if FAKE or not S.vad:
            return None
        return new_vad(S.vad["model"], threshold, min_silence_ms, min_speech_ms, sample_rate)

    def resample(self, samples, rate_in, rate_out):
        return resample(samples, rate_in, rate_out)

    def read_wav(self, path):
        return read_wav(input_file(path, [Paths.state], "audio file"))

    def write_wav(self, path, samples, rate):
        return write_wav(output_file(path), samples, rate)

    def output_path(self, path, exts=(".wav",)):
        return output_file(path, exts)

    def tmp_path(self, suffix=".wav"):
        return tmp_path(suffix)

    def cancel_tts(self):
        return cancel_tts()


HOST = Host()


def synthesize(text, on_chunk=None, cancel=None, speed=None, steps=None):
    t0 = time.perf_counter()
    with S.tts_lock:
        eng, voice = S.tts, S.voice
        if eng is None:
            raise SidecarError("MODEL_MISSING", "The cloned voice engine is not loaded (tts.load first)")
        if voice is None:
            raise SidecarError("PROFILE_INVALID", "No voice is set (tts.setVoice with a verified profile first)",
                               "Record your voice first: /anywhere:clone-voice")
        if cancel is not None and cancel.is_set():
            raise SidecarError("CANCELLED", "Synthesis was stopped")
        samples, rate, first, cancelled = eng.generate(text, voice, steps=steps, speed=speed, on_chunk=on_chunk, cancel=cancel)
    return {
        "samples": samples,
        "sampleRate": rate,
        "firstChunkMs": int(round(first)) if first is not None else None,
        "totalMs": int(round((time.perf_counter() - t0) * 1000)),
        "cancelled": bool(cancelled),
    }


def cancel_tts():
    n = 0
    with S.active_lock:
        for ctx in S.active.values():
            if ctx.op in ("tts.synthesize", "tts.say", "warmup") and not ctx.cancel.is_set():
                ctx.cancel.set()
                n += 1
    return n


# ------------------------------------------------------------------------------------- profiles

def _posix_private(path, what):
    if os.name != "posix":
        return
    st = os.stat(path)
    if hasattr(os, "getuid") and st.st_uid != os.getuid():
        raise SidecarError("PROFILE_INVALID", "The voice profile %s belongs to another user" % what)
    if st.st_mode & 0o022:
        raise SidecarError("PROFILE_INVALID", "The voice profile %s is writable by other users" % what,
                           "Record your voice again: /anywhere:clone-voice")


def _plain_tree(root, what):
    """The voice/clone/<what> folder must be the real folder under --state, not a link elsewhere."""
    if os.path.exists(root) and _norm(root) != os.path.normcase(os.path.abspath(root)):
        raise SidecarError("PROFILE_INVALID" if what == "profiles" else "BAD_REQUEST",
                           "The voice %s folder is a link; refusing to use it" % what)


def profile_dir(path, create=False):
    """A folder directly under <state>/voice/clone/profiles/ (never a link)."""
    if not isinstance(path, str) or not path or "\x00" in path:
        raise SidecarError("PROFILE_INVALID", "Invalid profile folder")
    full = os.path.abspath(path)
    name = os.path.basename(full.rstrip("\\/"))
    if not PROFILE_NAME_RE.match(name):
        raise SidecarError("PROFILE_INVALID", "Invalid profile name")
    if create:
        try:
            os.makedirs(Paths.profiles, mode=0o700, exist_ok=True)
        except OSError:
            pass
    if not os.path.isdir(Paths.profiles):
        raise SidecarError("PROFILE_INVALID", "No voice profile exists", "Record your voice first: /anywhere:clone-voice")
    _plain_tree(Paths.profiles, "profiles")
    if _norm(os.path.dirname(full.rstrip("\\/"))) != _norm(Paths.profiles):
        raise SidecarError("PROFILE_INVALID", "Voice profiles must be in the Claude Anywhere profiles folder")
    target = os.path.join(_real(Paths.profiles), name)
    if os.path.islink(target):
        raise SidecarError("PROFILE_INVALID", "The voice profile folder is a link")
    if create and not os.path.isdir(target):
        os.makedirs(target, mode=0o700)
    if not os.path.isdir(target):
        raise SidecarError("PROFILE_INVALID", "No voice profile named %s" % name, "Record your voice first: /anywhere:clone-voice")
    return target


def load_profile(path):
    """Validate a profile (consent verified, reference sha256) and read its reference clip."""
    d = profile_dir(path)
    _posix_private(d, "folder")
    man_path = os.path.join(d, "manifest.json")
    ref_path = os.path.join(d, "reference.wav")
    for p, what in ((man_path, "manifest"), (ref_path, "reference clip")):
        if os.path.islink(p) or not os.path.isfile(p):
            raise SidecarError("PROFILE_INVALID", "The voice profile has no %s" % what, "Record your voice again: /anywhere:clone-voice")
        _posix_private(p, what)
    if os.path.getsize(man_path) > 1024 * 1024:
        raise SidecarError("PROFILE_INVALID", "The voice profile manifest is too large")
    try:
        with open(man_path, "r", encoding="utf-8") as f:
            man = json.load(f)
    except (ValueError, OSError) as e:
        raise SidecarError("PROFILE_INVALID", "The voice profile manifest is unreadable: %s" % e)
    if not isinstance(man, dict) or man.get("version") != 1:
        raise SidecarError("PROFILE_INVALID", "Unsupported voice profile manifest")
    consent = man.get("consent")
    if not isinstance(consent, dict) or consent.get("verified") is not True or not isinstance(consent.get("verifiedAt"), str) or not consent.get("verifiedAt"):
        raise SidecarError("PROFILE_INVALID", "The voice profile has no verified consent", "Record your voice again: /anywhere:clone-voice")
    ref = man.get("reference")
    if not isinstance(ref, dict) or ref.get("file") != "reference.wav" or not isinstance(ref.get("sha256"), str) or not SHA256_RE.match(ref.get("sha256")):
        raise SidecarError("PROFILE_INVALID", "The voice profile manifest has no reference checksum")
    if os.path.getsize(ref_path) > MAX_REF_BYTES:
        raise SidecarError("PROFILE_INVALID", "The reference clip is too large")
    with open(ref_path, "rb") as f:
        data = f.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != ref["sha256"]:
        raise SidecarError("PROFILE_INVALID", "The reference clip does not match the voice profile (changed after enrollment)",
                           "Record your voice again: /anywhere:clone-voice")
    text = ref.get("text") if isinstance(ref.get("text"), str) else ""
    txt_path = os.path.join(d, "reference.txt")
    if not text and os.path.isfile(txt_path) and not os.path.islink(txt_path) and os.path.getsize(txt_path) < 64 * 1024:
        with open(txt_path, "r", encoding="utf-8") as f:
            text = f.read().strip()
    tag, ch, rate, bits, pcm = parse_wav(data)
    seconds = len(pcm) / float(ch * (bits // 8) * rate)
    if seconds < 2.0 or seconds > 60.0:
        raise SidecarError("PROFILE_INVALID", "The reference clip is %.1f s long (2-60 s expected)" % seconds)
    samples = None
    if not FAKE:
        samples, rate = read_wav(ref_path, MAX_REF_BYTES)
    return {
        "samples": samples,
        "rate": rate,
        "text": text,
        "seconds": seconds,
        "sha256": digest,
        "profile": os.path.basename(d),
        "engine": man.get("engine") if isinstance(man.get("engine"), str) else None,
    }


# ------------------------------------------------------------------------------------- ops

def op_hello(p, ctx):
    return hello_info()


def hello_info():
    providers = ["cpu"]
    if not FAKE and sherpa is not None:
        v = str(getattr(sherpa, "__version__", ""))
        if "cuda" in v:
            providers.append("cuda")
        if sys.platform == "darwin":
            providers.append("coreml")
    return {
        "protocol": PROTOCOL,
        "pid": os.getpid(),
        "python": platform.python_version(),
        "executable": sys.executable,
        "sherpa": "fake" if FAKE else (str(getattr(sherpa, "__version__", "")) if sherpa is not None else None),
        "numpy": None if FAKE or np is None else str(np.__version__),
        "runtimeError": None if FAKE else RUNTIME_ERROR,
        "platform": sys.platform,
        "machine": platform.machine(),
        "providers": providers,
        "fake": FAKE,
        "ops": sorted(set(OPS.keys()) | set(k for k in S.hooks if k != "shutdown")),
        "audioIo": S.audio_io,
        "loaded": {
            "tts": S.tts.engine if S.tts else None,
            "voice": S.voice["profile"] if S.voice else None,
            "asr": S.asr.model if S.asr else None,
            "vad": bool(S.vad),
            "spk": bool(S.spk),
        },
    }


def op_models_check(p, ctx):
    assets = p.get("assets")
    if not isinstance(assets, list) or len(assets) > 64:
        raise SidecarError("BAD_REQUEST", "assets must be a list")
    missing = []
    for a in assets:
        if not isinstance(a, dict):
            raise SidecarError("BAD_REQUEST", "Each asset must be an object")
        aid = str(a.get("id") or "")
        files = a.get("files") if isinstance(a.get("files"), list) else []
        d = a.get("dir")
        if isinstance(d, str) and d and not os.path.isdir(d):
            missing.append({"id": aid, "file": d})
            continue
        for f in files[:200]:
            if not isinstance(f, str) or not (os.path.isfile(f) or os.path.isdir(f)):
                missing.append({"id": aid, "file": f if isinstance(f, str) else None})
    return {"missing": missing, "complete": not missing}


def op_tts_load(p, ctx):
    need_runtime()
    engine = p.get("engine") or "pocket"
    if engine not in ENGINE_FILES:
        raise SidecarError("BAD_REQUEST", "engine must be pocket or zipvoice")
    files = resolve_files(engine, p, ENGINE_FILES[engine])
    vocoder = None
    if engine == "zipvoice":
        vocoder = model_path(_need_str(p, "vocoder", "vocoder path"), "vocoder")
    threads = _num(p, "threads", 2, 1, 16, True)
    steps = _num(p, "steps", 0, 0, 64, True) or DEFAULT_STEPS[engine]
    eng = TtsEngine(engine, files, vocoder, threads, _provider(p), steps)
    t0 = time.perf_counter()
    try:
        eng.load()
    except SidecarError:
        raise
    except Exception as e:
        raise SidecarError("MODEL_MISSING", "Could not load the %s model: %s" % (engine, e), "Reinstall: anywhere clone-voice install --force")
    with S.tts_lock:
        S.tts = eng
    return {"loadMs": int((time.perf_counter() - t0) * 1000), "sampleRate": eng.sample_rate, "engine": engine, "steps": steps, "threads": threads}


def op_tts_set_voice(p, ctx):
    voice = load_profile(p.get("profileDir"))
    if S.tts is not None and S.tts.engine == "zipvoice" and not voice["text"]:
        raise SidecarError("PROFILE_INVALID", "The quality voice needs the reference text (reference.txt)")
    with S.tts_lock:
        S.voice = voice
    return {"seconds": round(voice["seconds"], 3), "engine": S.tts.engine if S.tts else voice["engine"], "profile": voice["profile"], "sha256": voice["sha256"]}


def op_tts_synthesize(p, ctx):
    text = clean_text(p.get("text"))
    out = output_file(_need_str(p, "out", "output path"))
    speed = _num(p, "speed", 1.0, 0.5, 2.0) if p.get("speed") is not None else None
    steps = _num(p, "steps", 0, 0, 64, True) if p.get("steps") is not None else None

    def on_chunk(samples, index):
        ctx.emit("tts.chunk", index=index, samples=len(samples))

    r = synthesize(text, on_chunk=on_chunk, cancel=ctx.cancel, speed=speed, steps=steps)
    if r["cancelled"]:
        raise SidecarError("CANCELLED", "Synthesis was stopped")
    write_wav(out, r["samples"], r["sampleRate"])
    n = len(r["samples"])
    return {
        "out": out,
        "audioMs": int(round(n * 1000.0 / r["sampleRate"])),
        "firstChunkMs": r["firstChunkMs"],
        "totalMs": r["totalMs"],
        "sampleRate": r["sampleRate"],
        "engine": S.tts.engine,
    }


def op_warmup(p, ctx):
    text = clean_text(p.get("text") or WARMUP_TEXT, 200)
    r = synthesize(text, cancel=ctx.cancel)
    return {"ms": r["totalMs"], "firstChunkMs": r["firstChunkMs"]}


def op_tts_stop(p, ctx):
    n = cancel_tts()
    hook = S.hooks.get("tts.stop")
    if hook is not None:
        try:
            hook(p, ctx)
        except Exception as e:
            log("audio_io tts.stop failed:", e)
    return {"stopped": n}


def op_asr_load(p, ctx):
    need_runtime()
    model = p.get("model") or "moonshine"
    if model not in ("moonshine", "whisper", "parakeet"):
        raise SidecarError("BAD_REQUEST", "model must be moonshine, whisper or parakeet")
    files = resolve_files(model, p)
    eng = AsrEngine(model, files, _num(p, "threads", 2, 1, 16, True), _provider(p))
    t0 = time.perf_counter()
    try:
        eng.load()
    except Exception as e:
        raise SidecarError("MODEL_MISSING", "Could not load the %s model: %s" % (model, e), "Reinstall: anywhere clone-voice install --force")
    with S.asr_lock:
        S.asr = eng
    return {"loadMs": int((time.perf_counter() - t0) * 1000), "model": model}


def _transcribe_long(x, rate):
    """Moonshine and Whisper work on short clips: split audio over 28 s (VAD when loaded)."""
    if len(x) <= rate * 28:
        # Moonshine returns an empty text for a clip that starts with about 0.8 s of room tone or 1.5 s of
        # digital silence (measured): trim the non-speech ends first (a clip with no speech stays as it is).
        y = trim_silence(x, rate, 0.25)
        return S.asr.transcribe(y if len(y) >= int(rate * 0.3) else x, rate)
    pieces = []
    if S.vad:
        segs, x16 = vad_segments(S.vad["model"], x, rate, 0.5, 500, 250)
        for a, b in segs:
            pieces.append(S.asr.transcribe(x16[int(a * 16000):int(b * 16000)], 16000))
    else:
        step = rate * 25
        for i in range(0, len(x), step):
            pieces.append(S.asr.transcribe(x[i:i + step], rate))
    return " ".join(t for t in pieces if t).strip()


def op_asr_transcribe(p, ctx):
    wav = input_file(_need_str(p, "wav", "wav path"), [Paths.state], "audio file")
    t0 = time.perf_counter()
    if FAKE:
        if S.asr is None:
            raise SidecarError("MODEL_MISSING", "Speech recognition is not loaded (asr.load first)")
        seconds, _rate = wav_duration(wav)
        text = ""
        side = wav + ".txt"
        if os.path.isfile(side):
            with open(side, "r", encoding="utf-8") as f:
                text = f.read().strip()
        return {"text": text, "ms": int((time.perf_counter() - t0) * 1000), "seconds": round(seconds, 3)}
    if S.asr is None:
        raise SidecarError("MODEL_MISSING", "Speech recognition is not loaded (asr.load first)")
    x, rate = read_wav(wav)
    with S.asr_lock:
        text = _transcribe_long(x, rate)
    return {"text": text, "ms": int((time.perf_counter() - t0) * 1000), "seconds": round(len(x) / float(rate), 3)}


def op_vad_load(p, ctx):
    need_runtime()
    model = model_path(_need_str(p, "model", "VAD model path"), "VAD model")
    S.vad = {
        "model": model,
        "threshold": _num(p, "threshold", 0.5, 0.05, 0.99),
        "minSilenceMs": _num(p, "minSilenceMs", 600, 50, 5000, True),
        "minSpeechMs": _num(p, "minSpeechMs", 250, 50, 5000, True),
    }
    if not FAKE:
        new_vad(model)  # load once to fail early on a bad file
    return {"loaded": True}


def op_vad_segments(p, ctx):
    if not S.vad:
        raise SidecarError("MODEL_MISSING", "Voice activity detection is not loaded (vad.load first)")
    wav = input_file(_need_str(p, "wav", "wav path"), [Paths.state], "audio file")
    if FAKE:
        seconds, _ = wav_duration(wav)
        return {"segments": [{"start": 0.0, "end": round(seconds, 3)}], "voicedSeconds": round(seconds, 3), "seconds": round(seconds, 3)}
    x, rate = read_wav(wav)
    segs, _x16 = vad_segments(
        S.vad["model"], x, rate,
        _num(p, "threshold", S.vad["threshold"], 0.05, 0.99),
        _num(p, "minSilenceMs", S.vad["minSilenceMs"], 50, 5000, True),
        _num(p, "minSpeechMs", S.vad["minSpeechMs"], 50, 5000, True))
    return {
        "segments": [{"start": round(a, 3), "end": round(b, 3)} for a, b in segs],
        "voicedSeconds": round(sum(b - a for a, b in segs), 3),
        "seconds": round(len(x) / float(rate), 3),
    }


def op_spk_load(p, ctx):
    need_runtime()
    model = model_path(_need_str(p, "model", "speaker model path"), "speaker model")
    t0 = time.perf_counter()
    if FAKE:
        S.spk, S.spk_dim = "fake", 64
    else:
        cfg = sherpa.SpeakerEmbeddingExtractorConfig(model=model, num_threads=_num(p, "threads", 2, 1, 16, True), provider=_provider(p))
        if not cfg.validate():
            raise SidecarError("MODEL_MISSING", "The speaker model is not valid", "Reinstall: anywhere clone-voice install --force")
        ex = sherpa.SpeakerEmbeddingExtractor(cfg)
        with S.spk_lock:
            S.spk, S.spk_dim = ex, int(ex.dim)
    return {"loadMs": int((time.perf_counter() - t0) * 1000), "dim": S.spk_dim}


def _embed(path):
    if FAKE:
        return fake_embedding(path)
    x, rate = read_wav(path)
    if len(x) < rate * 0.5:
        raise SidecarError("BAD_REQUEST", "%s is shorter than 0.5 s" % os.path.basename(path))
    with S.spk_lock:
        st = S.spk.create_stream()
        st.accept_waveform(rate, x)
        st.input_finished()
        if not S.spk.is_ready(st):
            raise SidecarError("BAD_REQUEST", "%s is too short for a speaker embedding" % os.path.basename(path))
        v = np.asarray(S.spk.compute(st), dtype=np.float64)
    n = float(np.linalg.norm(v)) or 1.0
    return (v / n).tolist()


def op_spk_consistency(p, ctx):
    if not S.spk:
        raise SidecarError("MODEL_MISSING", "The speaker model is not loaded (spk.load first)")
    wavs = p.get("wavs")
    if not isinstance(wavs, list) or not wavs or len(wavs) > 64:
        raise SidecarError("BAD_REQUEST", "wavs must be a list of 1-64 paths")
    paths = [input_file(w, [Paths.state], "take") for w in wavs]
    probe = input_file(p["probe"], [Paths.state], "probe") if p.get("probe") else None
    embs = []
    for path in paths:
        if ctx.cancel.is_set():
            raise SidecarError("CANCELLED", "Stopped")
        embs.append(_embed(path))
    dim = len(embs[0])
    centroid = _unit([sum(e[i] for e in embs) / len(embs) for i in range(dim)])
    scores = [round(_cos(e, centroid), 4) for e in embs]
    out = _need_str(p, "centroidOut", required=False)
    cfile = output_file(out, (".json",), "centroid") if out else tmp_path(".json")
    write_private(cfile, json.dumps({"dim": dim, "count": len(embs), "centroid": [round(x, 7) for x in centroid]}).encode("utf-8"))
    res = {"centroid": cfile, "scores": scores, "mean": round(sum(scores) / len(scores), 4), "min": min(scores), "dim": dim}
    if p.get("matrix") is True:
        # Every pairwise cosine (the enrollment's consent-anchored and mixed-speaker checks, §2.6).
        res["matrix"] = [[round(_cos(a, b), 4) for b in embs] for a in embs]
    if probe:
        res["probe"] = round(_cos(_embed(probe), centroid), 4)
    return res


def op_spk_similarity(p, ctx):
    if not S.spk:
        raise SidecarError("MODEL_MISSING", "The speaker model is not loaded (spk.load first)")
    wav = input_file(_need_str(p, "wav", "wav path"), [Paths.state], "audio file")
    cfile = input_file(_need_str(p, "centroid", "centroid path"), [Paths.state], "centroid")
    try:
        with open(cfile, "r", encoding="utf-8") as f:
            c = json.load(f)["centroid"]
        if not isinstance(c, list) or not c:
            raise ValueError("empty")
    except (ValueError, KeyError, OSError, TypeError) as e:
        raise SidecarError("BAD_REQUEST", "The centroid file is not valid: %s" % e)
    return {"score": round(_cos(_embed(wav), [float(x) for x in c]), 4)}


def _session_dir(path):
    if not isinstance(path, str) or not path:
        raise SidecarError("BAD_REQUEST", "Missing sessionDir")
    _plain_tree(Paths.sessions, "sessions")
    real = _real(path)
    if _norm(os.path.dirname(real)) != _norm(Paths.sessions) or not os.path.isdir(real):
        raise SidecarError("BAD_REQUEST", "Takes must come from an enrollment session folder (voice/clone/sessions/<id>)")
    return real


def _pick_takes(items, min_s, max_s):
    """items: [(index, seconds, snr)] -> indices, best SNR first, 10-15 s in total (3-4 takes)."""
    chosen, total = [], 0.0
    for idx, secs, _snr in sorted(items, key=lambda t: (-t[2], t[0])):
        if len(chosen) >= 4 or total >= min_s:
            break
        if total + secs > max_s and chosen:
            continue
        chosen.append(idx)
        total += secs
    return sorted(chosen), total


def op_enroll_build(p, ctx):
    session = _session_dir(p.get("sessionDir"))
    takes = p.get("takes")
    if not isinstance(takes, list) or not takes or len(takes) > 40:
        raise SidecarError("BAD_REQUEST", "takes must be a list of 1-40 takes")
    prof = profile_dir(p.get("profileDir"), create=True)
    min_s = _num(p, "minSeconds", 10.0, 3.0, 30.0)
    max_s = max(min_s, _num(p, "maxSeconds", 15.0, 3.0, 40.0))
    gap = _num(p, "gapMs", 250, 0, 1000, True) / 1000.0
    consent_data = None
    if p.get("consentWav"):
        consent_data = read_wav_bytes(input_file(p.get("consentWav"), [session], "consent take"), 10 * 1024 * 1024)
        parse_wav(consent_data)
    loaded = []
    for i, t in enumerate(takes):
        if not isinstance(t, dict):
            raise SidecarError("BAD_REQUEST", "Each take must be an object")
        wav = input_file(t.get("wav"), [session], "take")
        text = t.get("text") if isinstance(t.get("text"), str) else ""
        snr = t.get("snr") if isinstance(t.get("snr"), (int, float)) and not isinstance(t.get("snr"), bool) else 0.0
        if FAKE:
            a, rate = read_pcm16_mono(wav)
            loaded.append({"i": i, "pcm": a, "rate": rate, "seconds": len(a) / float(rate), "text": text[:500], "snr": float(snr)})
        else:
            x, rate = read_wav(wav)
            x = trim_silence(resample(x, rate, REF_RATE), REF_RATE)
            loaded.append({"i": i, "x": x, "rate": REF_RATE, "seconds": len(x) / float(REF_RATE), "text": text[:500], "snr": float(snr)})
    chosen, _total = _pick_takes([(t["i"], t["seconds"], t["snr"]) for t in loaded], min_s, max_s)
    use = [t for t in loaded if t["i"] in chosen]
    seconds = sum(t["seconds"] for t in use) + gap * (len(use) - 1)
    if seconds < 3.0:
        raise SidecarError("BAD_REQUEST", "Not enough speech for a reference clip (%.1f s)" % seconds, "Record the lines again.")
    ref_path = os.path.join(prof, "reference.wav")
    if FAKE:
        rate = use[0]["rate"]
        pcm = array.array("h")
        for k, t in enumerate(use):
            if k:
                pcm.extend(array.array("h", [0]) * int(gap * rate))
            pcm.extend(t["pcm"])
        if sys.byteorder == "big":
            pcm.byteswap()
        data = pcm.tobytes()
        write_private(ref_path, wav_header(rate, len(data)) + data)
        seconds = len(data) / 2.0 / rate
    else:
        silence = np.zeros(int(gap * REF_RATE), dtype=np.float32)
        parts = []
        for k, t in enumerate(use):
            if k:
                parts.append(silence)
            parts.append(t["x"])
        y = normalize(np.concatenate(parts))
        write_wav(ref_path, y, REF_RATE)
        seconds = len(y) / float(REF_RATE)
    ref_text = " ".join(t["text"].strip() for t in use if t["text"].strip())
    write_private(os.path.join(prof, "reference.txt"), ref_text.encode("utf-8"))
    consent_copied = False
    if consent_data is not None:
        write_private(os.path.join(prof, "consent.wav"), consent_data)
        consent_copied = True
    return {
        "referenceSeconds": round(seconds, 3),
        "refText": ref_text,
        "sha256": sha256_file(ref_path),
        "used": chosen,
        "sampleRate": use[0]["rate"] if FAKE else REF_RATE,
        "files": {"reference": ref_path, "text": os.path.join(prof, "reference.txt"), "consent": os.path.join(prof, "consent.wav") if consent_copied else None},
    }


def op_bench(p, ctx):
    """Time synthesis per (threads, steps) with the model's own sample voice; returns timings only."""
    need_runtime()
    engine = p.get("engine") or "pocket"
    if engine not in ENGINE_FILES:
        raise SidecarError("BAD_REQUEST", "engine must be pocket or zipvoice")
    files = resolve_files(engine, p, ENGINE_FILES[engine])
    vocoder = model_path(_need_str(p, "vocoder", "vocoder path"), "vocoder") if engine == "zipvoice" else None
    base = os.path.dirname(files["encoder"])
    ref_rel, text_rel = BENCH_REFERENCE[engine]
    ref_file = model_path(os.path.join(base, *ref_rel.split("/")), "bench reference")
    threads_list = p.get("threads") if isinstance(p.get("threads"), list) else [1, 2, 4]
    steps_list = p.get("steps") if isinstance(p.get("steps"), list) else ([2, 3] if engine == "zipvoice" else [0])
    threads_list = [int(max(1, min(16, t))) for t in threads_list if isinstance(t, (int, float)) and not isinstance(t, bool)][:6] or [2]
    steps_list = [int(max(0, min(64, s))) for s in steps_list if isinstance(s, (int, float)) and not isinstance(s, bool)][:6] or [0]
    text = clean_text(p.get("text") or BENCH_TEXT, 300)
    if FAKE:
        ref = {"samples": None, "rate": REF_RATE, "text": ""}
    else:
        x, rate = read_wav(ref_file)
        x = x[: rate * 12]
        ref_text = ""
        if text_rel:
            tfile = os.path.join(base, *text_rel.split("/"))
            if os.path.isfile(tfile):
                with open(tfile, "r", encoding="utf-8") as f:
                    for line in f:
                        name, _sep, rest = line.strip().partition(" ")
                        if name == os.path.basename(ref_file):
                            ref_text = rest.strip()
        ref = {"samples": x, "rate": rate, "text": ref_text}
    runs = []
    for t in threads_list:
        if ctx.cancel.is_set():
            raise SidecarError("CANCELLED", "The benchmark was stopped")
        eng = TtsEngine(engine, files, vocoder, t, _provider(p), DEFAULT_STEPS[engine])
        t0 = time.perf_counter()
        eng.load()
        load_ms = int((time.perf_counter() - t0) * 1000)
        if not FAKE:
            eng.generate(WARMUP_TEXT, ref)  # warm up
        for s in steps_list:
            if ctx.cancel.is_set():
                raise SidecarError("CANCELLED", "The benchmark was stopped")
            t1 = time.perf_counter()
            if FAKE:
                audio_s = max(0.3, 0.06 * len(text))
                total_s = audio_s * (0.3 + 0.05 * t + 0.02 * (s or DEFAULT_STEPS[engine]))
                first = total_s * 0.4 * 1000
            else:
                samples, rate_out, first, _c = eng.generate(text, ref, steps=s or None, cancel=ctx.cancel)
                total_s = time.perf_counter() - t1
                audio_s = len(samples) / float(rate_out) if len(samples) else 0.0
            run = {
                "engine": engine,
                "threads": t,
                "steps": s or DEFAULT_STEPS[engine],
                "rtf": round(total_s / audio_s, 3) if audio_s > 0 else None,
                "firstChunkMs": int(first) if first is not None else None,
                "audioMs": int(audio_s * 1000),
                "loadMs": load_ms,
            }
            runs.append(run)
            ctx.emit("bench.progress", **run)
        del eng
    ok = [r for r in runs if r["rtf"] is not None]
    best = min(ok, key=lambda r: (r["rtf"], r["threads"])) if ok else None
    return {"runs": runs, "best": best, "cpus": os.cpu_count()}


def op_cancel(p, ctx):
    target = p.get("target")
    with S.active_lock:
        c = S.active.get(target)
    if c is not None:
        c.cancel.set()
    return {"cancelled": c is not None}


def op_shutdown(p, ctx):
    S.shutting_down = True
    return {"bye": True}


OPS = {
    "hello": op_hello,
    "models.check": op_models_check,
    "tts.load": op_tts_load,
    "tts.setVoice": op_tts_set_voice,
    "tts.synthesize": op_tts_synthesize,
    "tts.stop": op_tts_stop,
    "warmup": op_warmup,
    "asr.load": op_asr_load,
    "asr.transcribe": op_asr_transcribe,
    "vad.load": op_vad_load,
    "vad.segments": op_vad_segments,
    "spk.load": op_spk_load,
    "spk.consistency": op_spk_consistency,
    "spk.similarity": op_spk_similarity,
    "enroll.build": op_enroll_build,
    "bench": op_bench,
    "cancel": op_cancel,
    "shutdown": op_shutdown,
}
INLINE = {"hello", "models.check", "tts.stop", "cancel", "shutdown"}
LANE_OF = {
    "tts.load": "tts", "tts.setVoice": "tts", "tts.synthesize": "tts", "warmup": "tts", "bench": "tts",
    "asr.load": "asr", "asr.transcribe": "asr", "vad.load": "asr", "vad.segments": "asr",
    "spk.load": "spk", "spk.consistency": "spk", "spk.similarity": "spk", "enroll.build": "spk",
}
AUDIO_OPS_WITHOUT_PLUGIN = ("audio.devices", "audio.start", "audio.stop", "tts.say", "record.start", "record.stop")


# ------------------------------------------------------------------------------------- dispatch

class Lane(threading.Thread):
    def __init__(self, name):
        threading.Thread.__init__(self, name="lane-" + name)
        self.daemon = True
        self.q = queue.Queue()

    def submit(self, fn):
        self.q.put(fn)

    def run(self):
        while True:
            fn = self.q.get()
            try:
                fn()
            except Exception:  # run_request reports its own errors; this is a last resort
                log(traceback.format_exc())


LANES = {}


def lane(name):
    ln = LANES.get(name)
    if ln is None:
        ln = Lane(name)
        LANES[name] = ln
        ln.start()
    return ln


def respond_error(rid, code, message, hint=None):
    obj = {"id": rid, "ok": False, "error": str(message)[:2000], "code": code}
    if hint:
        obj["hint"] = hint
    write_obj(obj)


def run_request(ctx, params, fn):
    rid = ctx.id
    try:
        if ctx.cancel.is_set():
            raise SidecarError("CANCELLED", "The request was cancelled before it started")
        result = fn(params, ctx)
        out = {"id": rid, "ok": True}
        if isinstance(result, dict):
            for k, v in result.items():
                if k not in ("id", "ok"):
                    out[k] = v
        write_obj(out)
    except SidecarError as e:
        respond_error(rid, e.code, e.message, e.hint)
    except MemoryError:
        respond_error(rid, "INTERNAL", "Out of memory")
    except Exception as e:
        log(traceback.format_exc())
        respond_error(rid, "INTERNAL", "%s: %s" % (type(e).__name__, e))
    finally:
        with S.active_lock:
            if S.active.get(rid) is ctx:
                del S.active[rid]


def hook_handler(op):
    hook = S.hooks.get(op)
    if hook is None:
        return None

    def call(params, ctx):
        r = hook(params, ctx)
        return r if isinstance(r, dict) else {}

    return call


def dispatch(line):
    try:
        req = json.loads(line)
    except ValueError:
        emit("protocol.error", message="Request is not JSON")
        return
    if not isinstance(req, dict):
        emit("protocol.error", message="Request must be an object")
        return
    rid = req.get("id")
    if isinstance(rid, bool) or not isinstance(rid, (int, str)) or (isinstance(rid, str) and len(rid) > 64):
        emit("protocol.error", message="Request id must be an integer or a short string")
        return
    op = req.get("op")
    if not isinstance(op, str):
        respond_error(rid, "BAD_REQUEST", "Missing op")
        return
    params = {k: v for k, v in req.items() if k not in ("id", "op")}
    fn = OPS.get(op)
    where = None
    if fn is not None:
        where = None if op in INLINE else LANE_OF.get(op, "misc")
    else:
        fn = hook_handler(op)
        if fn is not None:
            where = None if op in INLINE_HOOKS else "audio"
        elif op in AUDIO_OPS_WITHOUT_PLUGIN or op.startswith("audio.") or op.startswith("record."):
            respond_error(rid, "AUDIO_BACKEND", "Live call audio is not available (%s)" % (S.audio_io.get("error") or "audio_io.py is not installed"),
                          "Update Claude Anywhere; live call audio comes with the calls feature.")
            return
        else:
            respond_error(rid, "BAD_REQUEST", "Unknown op %s" % op)
            return
    ctx = Ctx(rid, op)
    with S.active_lock:
        if rid in S.active:
            ctx = None
        else:
            S.active[rid] = ctx
    if ctx is None:
        respond_error(rid, "BAD_REQUEST", "Request id %s is already in use" % rid)
        return
    if where is None:
        run_request(ctx, params, fn)
    else:
        lane(where).submit(lambda: run_request(ctx, params, fn))


def load_plugin():
    path = os.path.join(SCRIPT_DIR, "audio_io.py")
    if os.environ.get("ANYWHERE_CLONE_NO_AUDIO_IO") == "1" or not os.path.isfile(path):
        S.audio_io = {"available": False}
        return
    try:
        spec = importlib.util.spec_from_file_location("audio_io", path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["audio_io"] = mod
        spec.loader.exec_module(mod)
        reg = mod.register(HOST) if hasattr(mod, "register") else None
        hooks = {}
        if isinstance(reg, dict):
            for k, v in reg.items():
                if not callable(v):
                    continue
                if HOOK_KEY_RE.match(k) or k in ("tts.say", "tts.stop", "shutdown"):
                    hooks[k] = v
                else:
                    log("audio_io: ignoring hook %r (only audio.*, record.*, tts.say, tts.stop, shutdown)" % k)
        S.hooks = hooks
        S.audio_io = {"available": True, "ops": sorted(k for k in hooks if k not in ("tts.stop", "shutdown"))}
    except Exception as e:
        log("audio_io failed to load:", traceback.format_exc())
        S.hooks = {}
        S.audio_io = {"available": False, "error": "%s: %s" % (type(e).__name__, e)}


_exit_once = threading.Lock()


def finish(code=0, drain_s=1.5):
    if not _exit_once.acquire(False):
        return
    S.shutting_down = True
    cancel_tts()
    # Let short requests finish, then answer the rest so the client never waits on a dead process.
    deadline = time.time() + drain_s
    while time.time() < deadline:
        with S.active_lock:
            busy = [c for c in S.active.values() if c.op != "shutdown"]
        if not busy:
            break
        time.sleep(0.02)
    with S.active_lock:
        left = [c for c in S.active.values() if c.op != "shutdown"]
        S.active.clear()
    for c in left:
        respond_error(c.id, "SHUTDOWN", "The voice sidecar is shutting down")
    hook = S.hooks.get("shutdown")
    if hook is not None:
        try:
            hook({}, Ctx(None, "shutdown"))
        except Exception as e:
            log("audio_io shutdown failed:", e)
    try:
        PROTO.flush()
    except Exception:
        pass
    try:
        sys.stderr.flush()
    except Exception:
        pass
    os._exit(code)


def read_loop():
    stdin = sys.stdin.buffer
    while True:
        raw = stdin.readline(MAX_LINE + 2)
        if not raw:
            break
        if len(raw) > MAX_LINE and not raw.endswith(b"\n"):
            while True:  # drop the rest of an oversized line
                more = stdin.readline(MAX_LINE)
                if not more or more.endswith(b"\n"):
                    break
            emit("protocol.error", message="Request line is longer than 1 MB")
            continue
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        dispatch(line)
        if S.shutting_down:
            break
    finish(0)


def main(argv=None):
    global FAKE, np, sherpa, RUNTIME_ERROR
    ap = argparse.ArgumentParser(description="Claude Anywhere voice sidecar (protocol v1)")
    ap.add_argument("--state", required=True, help="the Claude Anywhere state folder")
    ap.add_argument("--models", required=True, help="the clone models folder")
    ap.add_argument("--fake", action="store_true", help="test mode without numpy and sherpa-onnx")
    args = ap.parse_args(argv)
    FAKE = bool(args.fake or os.environ.get("ANYWHERE_CLONE_FAKE") == "1")
    Paths.state = _real(args.state)
    Paths.models = _real(args.models)
    Paths.profiles = os.path.join(Paths.state, "voice", "clone", "profiles")
    Paths.sessions = os.path.join(Paths.state, "voice", "clone", "sessions")
    Paths.tmp = os.path.join(Paths.state, "run", "voice-tmp")
    if not os.path.isdir(Paths.state):
        sys.stderr.write("The state folder does not exist: %s\n" % args.state)
        return 2
    if not FAKE:
        try:
            import numpy as _np
            import sherpa_onnx as _sherpa
            np, sherpa = _np, _sherpa
        except Exception as e:  # reported in ready/hello; ops that need it fail with RUNTIME_MISSING
            RUNTIME_ERROR = "%s: %s" % (type(e).__name__, e)
            log("runtime import failed:", RUNTIME_ERROR)
    load_plugin()

    def on_signal(signum, _frame):
        finish(0)

    for name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), on_signal)
            except (ValueError, OSError):
                pass
    info = {"event": "ready"}
    info.update(hello_info())
    write_obj(info)
    try:
        read_loop()
    except KeyboardInterrupt:
        finish(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
