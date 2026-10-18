# -*- coding: utf-8 -*-
"""Live call audio for the Claude Anywhere voice sidecar (docs/CALLS-DESIGN.md sections 5, 6.1, 6.5).

Loaded by sidecar.py as a plug-in: register(host) returns the handlers below. The host gives synthesis in
the enrolled (consented) voice only, speech recognition, Silero VAD and event output; this module never
clones from an audio file and never sends audio anywhere: capture goes to VAD and the local recognizer,
playback goes to the virtual microphone (or the speakers in speaker mode).

Ops (params -> result; events have no request id unless noted):
    audio.devices       {}  -> {inputs, outputs, loopbacks, defaults:{input, output}, backends:{...}, platform}
                        each device {name, id, backend, virtual, hostapi?, channels?}
    audio.start         {capture:{backend, device, app?}, playback:{backend, device}, vad:{threshold, minSilenceMs,
                         minSpeechMs, energyThreshold?}, bargeIn:{minSpeechMs, stopPlayback}|null, halfDuplex,
                         tailMs?, asr?:true, levelIntervalMs?:500} -> {started, vad:'silero'|'energy', capture, playback}
                        events: vad.start {t}, vad.end {t, ms}, asr.final {text, t0, t1, ms}, level {rms, peak, db, t},
                        barge_in {t, utteranceId}, audio.error {message, code, where}
    audio.stop          {}  -> {stopped}       (runs on the reader thread: returns at once)
    audio.play          {wav, utteranceId?, text?, playback?, wait?} -> {queued|played ...}   a WAV file under the
                        state folder (pre-rendered greeting or filler, the self-test phrase), queued like speech
    audio.status        {}  -> {session, player, recording}
    audio.defaultInput  {set?: name, uid?} -> {name, uid?, via}   (macOS CoreAudio; Linux pactl; Windows uses the
                        PowerShell host instead)
    tts.say             {text, utteranceId, wav?, speed?, interrupt?, playback?} -> {queued, utteranceId, position}
                        events playback.start {utteranceId, rate}, playback.end {utteranceId, interrupted,
                        playedChars, chars, playedMs, started, error?}
    tts.stop            (lifecycle hook after the sidecar's own tts.stop) stops playback within 100 ms, clears the queue
    record.start        {backend, device, app?, out, seconds?, wait?} -> {out, seconds, peak, rms} with wait, else
                        {recording:true}; event record.done {out, seconds, peak, rms} (peak/rms in dBFS)
    record.stop         {} -> {out, seconds, peak, rms}

Backends: capture  pulse (parec, or ffmpeg -f pulse), wasapi-loopback (python soundcard), device (sounddevice),
                   sck (ScreenCaptureKit through PyObjC, macOS 13+), file (tests only)
          playback pulse (pacat), device (sounddevice), file (tests only)
The test backends ("file") exist only in the sidecar's fake mode or with ANYWHERE_AUDIO_TEST_BACKENDS=1.

Also a small command line for the daemon's synchronous restore on exit (macOS):
    python -I audio_io.py get-default-input | set-default-input --name NAME [--uid UID] | devices
"""

import array
import json
import math
import os
import queue
import re
import shutil
import struct
import subprocess
import sys
import threading
import time

HOST = None
np = None  # numpy when the host has it (real mode)

CAPTURE_RATE = 16000
FRAME_MS = 20
FRAME_SAMPLES = CAPTURE_RATE * FRAME_MS // 1000  # 320
FRAME_BYTES = FRAME_SAMPLES * 2
OWN_ID = "claude-anywhere"
MAX_WAV_BYTES = 50 * 1024 * 1024
PULSE_NAME_RE = re.compile(r"^[A-Za-z0-9_.:@/+=-]{1,200}$")
VIRTUAL_RE = re.compile(
    r"blackhole|vb-?audio|cable (in|out)put|claude-anywhere|anywhere_(tts|mic|call)|monitor of|\.monitor$|loopback|"
    r"soundflower|virtual|stereo mix|aggregate|multi-output", re.I)
CAPTURE_BACKENDS = ("pulse", "wasapi-loopback", "device", "sck", "file")
PLAYBACK_BACKENDS = ("pulse", "device", "file")
WIN_HOSTAPI_ORDER = ("Windows WASAPI", "Windows DirectSound", "MME", "Windows WDM-KS")


class _LocalError(Exception):
    def __init__(self, code, message, hint=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.hint = hint


def _err(code, message, hint=None):
    cls = HOST.SidecarError if HOST is not None else _LocalError
    return cls(code, message, hint)


def _log(*parts):
    if HOST is not None:
        HOST.log("[audio_io]", *parts)
    else:
        sys.stderr.write("[audio_io] " + " ".join(str(p) for p in parts) + "\n")


def _emit(event, **fields):
    if HOST is not None:
        HOST.emit(event, **fields)


def _test_backends_allowed():
    return bool((HOST is not None and HOST.fake) or os.environ.get("ANYWHERE_AUDIO_TEST_BACKENDS") == "1")


# ------------------------------------------------------------------------------------------- PCM helpers

def floats_to_pcm16(x):
    if np is not None and isinstance(x, np.ndarray):
        return (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    a = array.array("h", (int(max(-1.0, min(1.0, float(v))) * 32767) for v in x))
    if sys.byteorder == "big":
        a.byteswap()
    return a.tobytes()


def pcm16_array(b):
    a = array.array("h")
    a.frombytes(b[: len(b) // 2 * 2])
    if sys.byteorder == "big":
        a.byteswap()
    return a


def pcm16_to_float(b):
    """Real mode: numpy float32; fake mode: the raw bytes (the fake recognizer ignores the samples)."""
    if np is None:
        return b
    return np.frombuffer(b[: len(b) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0


def pcm16_stats(b):
    """-> (rms, peak) in 0..1."""
    if not b:
        return 0.0, 0.0
    if np is not None:
        v = np.frombuffer(b[: len(b) // 2 * 2], dtype="<i2").astype(np.float32)
        if not len(v):
            return 0.0, 0.0
        return float(np.sqrt(np.mean(v * v))) / 32768.0, float(np.max(np.abs(v))) / 32768.0
    a = pcm16_array(b)
    if not len(a):
        return 0.0, 0.0
    s = 0
    pk = 0
    for v in a:
        s += v * v
        av = -v if v < 0 else v
        if av > pk:
            pk = av
    return math.sqrt(s / float(len(a))) / 32768.0, pk / 32768.0


def dbfs(x):
    return round(20.0 * math.log10(x), 1) if x > 1e-6 else -120.0


def wav_header(rate, nbytes, channels=1):
    return struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + nbytes, b"WAVE", b"fmt ", 16, 1, channels, rate,
                       rate * 2 * channels, 2 * channels, 16, b"data", nbytes)


def write_wav_private(path, pcm, rate):
    tmp = "%s.%d.%s.tmp" % (path, os.getpid(), os.urandom(3).hex())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(wav_header(rate, len(pcm)))
            f.write(pcm)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_wav_pcm16(path):
    """-> (rate, mono s16le bytes). PCM 16-bit or float32; the first channel of multichannel files."""
    size = os.path.getsize(path)
    if size > MAX_WAV_BYTES:
        raise _err("BAD_REQUEST", "The audio file is too large")
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise _err("BAD_REQUEST", "Not a WAV file: %s" % os.path.basename(path))
    off, fmt = 12, None
    while off + 8 <= len(data):
        cid = data[off:off + 4]
        n = struct.unpack_from("<I", data, off + 4)[0]
        body = off + 8
        if cid == b"fmt " and body + 16 <= len(data):
            tag, ch, rate, _br, _ba, bits = struct.unpack_from("<HHIIHH", data, body)
            if tag == 0xFFFE and n >= 26:
                tag = struct.unpack_from("<H", data, body + 24)[0]
            fmt = (tag, ch, rate, bits)
        elif cid == b"data" and fmt:
            end = len(data) if n in (0, 0xFFFFFFFF) or body + n > len(data) else body + n
            tag, ch, rate, bits = fmt
            raw = data[body:end]
            if tag == 1 and bits == 16:
                if ch == 1:
                    return rate, raw[: len(raw) // 2 * 2]
                a = pcm16_array(raw)
                mono = array.array("h", a[0::ch])
                if sys.byteorder == "big":
                    mono.byteswap()
                return rate, mono.tobytes()
            if tag == 3 and bits == 32:
                fa = array.array("f")
                fa.frombytes(raw[: len(raw) // 4 * 4])
                if sys.byteorder == "big":
                    fa.byteswap()
                return rate, floats_to_pcm16(fa[0::ch])
            raise _err("BAD_REQUEST", "Unsupported WAV encoding (format %d, %d bits)" % (tag, bits))
        off = body + n + (n % 2)
    raise _err("BAD_REQUEST", "The WAV file has no audio data")


def resample_pcm16_simple(pcm, rate_in, rate_out):
    """Linear resampling of s16le mono (numpy when present, else pure python; short clips only)."""
    if rate_in == rate_out or not pcm:
        return pcm
    if np is not None:
        x = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        n = int(round(len(x) * float(rate_out) / rate_in))
        y = np.interp(np.arange(n) * (float(rate_in) / rate_out), np.arange(len(x)), x)
        return np.clip(y, -32768, 32767).astype("<i2").tobytes()
    a = pcm16_array(pcm)
    n = int(round(len(a) * float(rate_out) / rate_in))
    step = float(rate_in) / rate_out
    out = array.array("h", (a[min(len(a) - 1, int(i * step))] for i in range(n)))
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()


class StreamResampler(object):
    """Streaming resampler for device audio (numpy): block mean for integer down-factors, else linear."""

    def __init__(self, rate_in, rate_out):
        self.rin = int(rate_in)
        self.rout = int(rate_out)
        self.step = float(self.rin) / self.rout
        self.integer = self.rin % self.rout == 0 and self.rin >= self.rout
        self.factor = self.rin // self.rout if self.integer else 1
        self.rest = np.zeros(0, dtype=np.float32)
        self.tail = None
        self.t = 0.0

    def process(self, x):
        x = np.asarray(x, dtype=np.float32).reshape(-1)
        if self.rin == self.rout:
            return x
        if self.integer:
            buf = np.concatenate([self.rest, x]) if len(self.rest) else x
            n = len(buf) // self.factor
            self.rest = buf[n * self.factor:]
            return buf[: n * self.factor].reshape(n, self.factor).mean(axis=1).astype(np.float32)
        buf = np.concatenate([self.tail, x]) if self.tail is not None else x
        if len(buf) < 2:
            self.tail = buf
            return np.zeros(0, dtype=np.float32)
        last = len(buf) - 1
        if self.t > last:
            self.t -= len(buf) - 1
            self.tail = buf[-1:]
            return np.zeros(0, dtype=np.float32)
        n = int(math.floor((last - self.t) / self.step)) + 1
        idx = self.t + self.step * np.arange(n)
        y = np.interp(idx, np.arange(len(buf)), buf).astype(np.float32)
        self.t = self.t + self.step * n - last
        self.tail = buf[-1:]
        return y


def _inside_state(path, must_exist=True):
    if not isinstance(path, str) or not path or "\x00" in path:
        raise _err("BAD_REQUEST", "Invalid file path")
    real = os.path.realpath(os.path.abspath(path))
    roots = [HOST.state_dir] if HOST is not None else []
    ok = False
    for r in roots:
        rr = os.path.normcase(os.path.realpath(r))
        if os.path.normcase(real) == rr or os.path.normcase(real).startswith(rr.rstrip("\\/") + os.sep):
            ok = True
    if not ok:
        raise _err("BAD_REQUEST", "Audio files must be inside the Claude Anywhere state folder")
    if must_exist and not os.path.isfile(real):
        raise _err("BAD_REQUEST", "The audio file does not exist: %s" % os.path.basename(path))
    return real


def _device_str(v, what):
    if v is None:
        return ""
    if not isinstance(v, str) or len(v) > 200 or "\x00" in v or "\n" in v or "\r" in v:
        raise _err("BAD_REQUEST", "Invalid %s device" % what)
    return v.strip()


def _which(names):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


def _pulse_env():
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    env["LANG"] = "C"
    return env


# ------------------------------------------------------------------------------------------- capture backends

class Capture(object):
    """Produces s16le mono frames at 16 kHz through read()."""
    kind = "base"

    def __init__(self, device="", app=""):
        self.device = device
        self.app = app
        self.q = queue.Queue(maxsize=1000)
        self.stopping = threading.Event()
        self.error = None
        self._acc = bytearray()

    def describe(self):
        return {"backend": self.kind, "device": self.device}

    def _push_pcm(self, pcm):
        self._acc.extend(pcm)
        while len(self._acc) >= FRAME_BYTES:
            frame = bytes(self._acc[:FRAME_BYTES])
            del self._acc[:FRAME_BYTES]
            try:
                self.q.put_nowait(frame)
            except queue.Full:  # the consumer is stuck: drop the oldest audio, keep the newest
                try:
                    self.q.get_nowait()
                    self.q.put_nowait(frame)
                except (queue.Empty, queue.Full):
                    pass

    def _push_float(self, x, rate, rs_holder):
        if rate != CAPTURE_RATE:
            if rs_holder.get("rs") is None:
                rs_holder["rs"] = StreamResampler(rate, CAPTURE_RATE)
            x = rs_holder["rs"].process(x)
        if len(x):
            self._push_pcm(floats_to_pcm16(x))

    def _fail(self, message, code="AUDIO_BACKEND"):
        if self.stopping.is_set():
            return
        self.error = (code, message)
        try:
            self.q.put_nowait(None)
        except queue.Full:
            pass

    def read(self, timeout=0.5):
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return b""

    def start(self):
        raise NotImplementedError

    def stop(self):
        self.stopping.set()


class _ProcCapture(Capture):
    def _spawn(self, argv, env=None):
        try:
            self.p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                      env=env, **_no_window())
        except OSError as e:
            raise _err("AUDIO_BACKEND", "Could not start %s: %s" % (os.path.basename(argv[0]), e))
        self.stderr_tail = []
        threading.Thread(target=self._read_err, name="capture-stderr", daemon=True).start()
        threading.Thread(target=self._read_out, name="capture-" + self.kind, daemon=True).start()

    def _read_err(self):
        try:
            for line in iter(self.p.stderr.readline, b""):
                self.stderr_tail.append(line.decode("utf-8", "replace").strip())
                del self.stderr_tail[:-10]
        except Exception:
            pass

    def _read_out(self):
        out = self.p.stdout
        try:
            while not self.stopping.is_set():
                b = out.read(4096)
                if not b:
                    break
                self._push_pcm(b)
        except Exception as e:
            self._fail("capture read failed: %s" % e)
            return
        if not self.stopping.is_set():
            time.sleep(0.05)
            code = self.p.poll()
            self._fail("%s stopped (exit %s): %s" % (os.path.basename(self.argv0), code, " / ".join(self.stderr_tail[-3:]) or "no output"))

    def stop(self):
        Capture.stop(self)
        p = getattr(self, "p", None)
        if p is not None and p.poll() is None:
            try:
                p.kill()
            except Exception:
                pass


class PulseCapture(_ProcCapture):
    kind = "pulse"

    def start(self):
        dev = self.device or "@DEFAULT_MONITOR@"
        if not PULSE_NAME_RE.match(dev):
            raise _err("BAD_REQUEST", "Invalid PulseAudio source name")
        parec = _which(["parec"])
        if parec:
            argv = [parec, "--device=" + dev, "--format=s16le", "--rate=%d" % CAPTURE_RATE, "--channels=1", "--raw",
                    "--latency-msec=30", "--client-name=" + OWN_ID, "--property=application.id=" + OWN_ID,
                    "--stream-name=Claude Anywhere call capture"]
        else:
            ff = _which(["ffmpeg"])
            if not ff:
                raise _err("AUDIO_BACKEND", "Neither parec nor ffmpeg is installed",
                           "Install the PulseAudio tools: sudo apt install pulseaudio-utils")
            argv = [ff, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", dev, "-ac", "1",
                    "-ar", str(CAPTURE_RATE), "-f", "s16le", "-"]
        self.argv0 = argv[0]
        self._spawn(argv, _pulse_env())


class FileCapture(Capture):
    """Tests: a 16-bit WAV under the state folder, fed in real time (or as fast as possible), then silence."""
    kind = "file"

    def __init__(self, device="", app="", realtime=True):
        Capture.__init__(self, device, app)
        self.realtime = realtime

    def start(self):
        if not _test_backends_allowed():
            raise _err("BAD_REQUEST", "The file capture backend is for tests only")
        path = _inside_state(self.device)
        rate, pcm = read_wav_pcm16(path)
        self.pcm = resample_pcm16_simple(pcm, rate, CAPTURE_RATE)
        threading.Thread(target=self._run, name="capture-file", daemon=True).start()

    def _run(self):
        t0 = time.monotonic()
        n = 0
        pos = 0
        silence = b"\x00" * FRAME_BYTES
        while not self.stopping.is_set():
            if pos < len(self.pcm):
                frame = self.pcm[pos:pos + FRAME_BYTES]
                pos += FRAME_BYTES
                if len(frame) < FRAME_BYTES:
                    frame = frame + silence[len(frame):]
            else:
                frame = silence
            self._push_pcm(frame)
            n += 1
            if self.realtime:
                delay = t0 + n * FRAME_MS / 1000.0 - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
            elif n % 10 == 0:
                time.sleep(0.001)


class SoundcardLoopback(Capture):
    """Windows: WASAPI loopback of the speakers (python soundcard). Our voice goes to CABLE Input, not here."""
    kind = "wasapi-loopback"

    def start(self):
        try:
            import soundcard as sc  # noqa
        except Exception as e:
            raise _err("AUDIO_BACKEND", "WASAPI loopback needs python soundcard: %s" % e, "Reinstall the voice runtime: anywhere clone-voice install --force")
        self.sc = sc
        spk = None
        if self.device:
            want = self.device.lower()
            for s in sc.all_speakers():
                if want in str(s.name).lower():
                    spk = s
                    break
            if spk is None:
                raise _err("DEVICE_NOT_FOUND", "No speaker named %s" % self.device)
        else:
            spk = sc.default_speaker()
        self.mic = sc.get_microphone(id=str(spk.name), include_loopback=True)
        self.device = str(spk.name)
        ready = threading.Event()
        threading.Thread(target=self._run, args=(ready,), name="capture-loopback", daemon=True).start()
        ready.wait(3.0)
        if self.error:
            raise _err(self.error[0], self.error[1])

    def _run(self, ready):
        try:
            with self.mic.recorder(samplerate=CAPTURE_RATE, channels=1, blocksize=FRAME_SAMPLES) as rec:
                ready.set()
                while not self.stopping.is_set():
                    data = rec.record(numframes=FRAME_SAMPLES)
                    x = np.asarray(data, dtype=np.float32)
                    if x.ndim > 1:
                        x = x[:, 0]
                    self._push_pcm(floats_to_pcm16(x))
        except Exception as e:
            self.error = ("AUDIO_BACKEND", "WASAPI loopback failed: %s" % e)
            ready.set()
            self._fail(self.error[1])


def _sounddevice():
    try:
        import sounddevice as sd  # noqa
        return sd
    except Exception as e:
        raise _err("AUDIO_BACKEND", "Audio devices need python sounddevice: %s" % e, "Reinstall the voice runtime: anywhere clone-voice install --force")


def _find_sd_device(sd, name, want_input):
    """Index of the device whose name contains `name` (WASAPI first on Windows), or the default."""
    devs = sd.query_devices()
    apis = sd.query_hostapis()
    key = "max_input_channels" if want_input else "max_output_channels"
    if not name:
        d = sd.default.device[0 if want_input else 1]
        if d is None or d < 0:
            raise _err("DEVICE_NOT_FOUND", "No default %s device" % ("input" if want_input else "output"))
        return int(d)
    want = name.lower()
    cands = [(i, d) for i, d in enumerate(devs) if d.get(key, 0) > 0 and want in str(d.get("name", "")).lower()]
    if not cands:
        raise _err("DEVICE_NOT_FOUND", "No %s device named %s" % ("input" if want_input else "output", name))

    def rank(item):
        api = apis[item[1]["hostapi"]]["name"] if 0 <= item[1].get("hostapi", -1) < len(apis) else ""
        order = WIN_HOSTAPI_ORDER.index(api) if api in WIN_HOSTAPI_ORDER else len(WIN_HOSTAPI_ORDER)
        exact = 0 if str(item[1].get("name", "")).lower().startswith(want) else 1
        return (order, exact, item[0])

    cands.sort(key=rank)
    return cands[0][0]


class DeviceCapture(Capture):
    """An input device through sounddevice (BlackHole 16ch, a physical mic in speaker mode)."""
    kind = "device"

    def start(self):
        sd = _sounddevice()
        idx = _find_sd_device(sd, self.device, True)
        info = sd.query_devices(idx)
        self.device = str(info.get("name", self.device))
        rate = int(info.get("default_samplerate") or 48000)
        holder = {}

        def cb(indata, frames, _time, status):
            if self.stopping.is_set():
                return
            try:
                self._push_float(indata[:, 0].copy(), rate, holder)
            except Exception as e:  # never raise into PortAudio
                _log("capture callback:", e)

        try:
            self.stream = sd.InputStream(device=idx, samplerate=rate, channels=1, dtype="float32", callback=cb, blocksize=int(rate * FRAME_MS / 1000))
            self.stream.start()
        except Exception as e:
            raise _err("AUDIO_BACKEND", "Could not open %s: %s" % (self.device, e))

    def stop(self):
        Capture.stop(self)
        s = getattr(self, "stream", None)
        if s is not None:
            try:
                s.abort()
                s.close()
            except Exception:
                pass


_SCK_OUTPUT_CLASS = None


class SckCapture(Capture):
    """macOS 13+: ScreenCaptureKit audio of the call browser (or of the whole display) through PyObjC.
    Needs the Screen Recording permission. Not verified on a Mac yet (design section 5.3)."""
    kind = "sck"

    def start(self):
        global _SCK_OUTPUT_CLASS
        try:
            import objc  # noqa
            import ScreenCaptureKit as SCK  # noqa
            import CoreMedia as CM  # noqa
            from Foundation import NSObject  # noqa
        except Exception as e:
            raise _err("AUDIO_BACKEND", "ScreenCaptureKit is not available: %s" % e,
                       "Use BlackHole 16ch as the capture device (calls.audio.capture = device:BlackHole 16ch)")
        self.CM = CM
        done = threading.Event()
        box = {}

        def on_content(content, error):
            box["content"], box["error"] = content, error
            done.set()

        SCK.SCShareableContent.getShareableContentWithCompletionHandler_(on_content)
        if not done.wait(8.0) or box.get("content") is None:
            raise _err("AUDIO_BACKEND", "ScreenCaptureKit gave no content (%s)" % (box.get("error") or "timeout"),
                       "Allow Screen Recording for the app that runs Claude Code (System Settings > Privacy & Security).")
        content = box["content"]
        displays = list(content.displays() or [])
        if not displays:
            raise _err("AUDIO_BACKEND", "ScreenCaptureKit found no display")
        apps = []
        want = (self.app or "").lower()
        if want:
            for a in content.applications() or []:
                nm = "%s %s" % (a.applicationName() or "", a.bundleIdentifier() or "")
                if want in nm.lower():
                    apps.append(a)
        if apps:
            filt = SCK.SCContentFilter.alloc().initWithDisplay_includingApplications_exceptingWindows_(displays[0], apps, [])
        else:
            filt = SCK.SCContentFilter.alloc().initWithDisplay_excludingWindows_(displays[0], [])
        cfg = SCK.SCStreamConfiguration.alloc().init()
        cfg.setCapturesAudio_(True)
        cfg.setSampleRate_(48000)
        cfg.setChannelCount_(1)
        cfg.setExcludesCurrentProcessAudio_(True)
        cfg.setWidth_(2)
        cfg.setHeight_(2)
        try:
            cfg.setMinimumFrameInterval_(CM.CMTimeMake(1, 1))
        except Exception:
            pass
        if _SCK_OUTPUT_CLASS is None:
            proto = objc.protocolNamed("SCStreamOutput")

            class AnywhereSckOutput(NSObject, protocols=[proto]):
                def stream_didOutputSampleBuffer_ofType_(self, stream, sbuf, kind):
                    sink = getattr(self, "sink", None)
                    if sink is not None and kind == 1:  # SCStreamOutputTypeAudio
                        sink(sbuf)

            _SCK_OUTPUT_CLASS = AnywhereSckOutput
        self.output = _SCK_OUTPUT_CLASS.alloc().init()
        holder = {}

        def sink(sbuf):
            try:
                bb = CM.CMSampleBufferGetDataBuffer(sbuf)
                n = CM.CMBlockBufferGetDataLength(bb)
                r = CM.CMBlockBufferCopyDataBytes(bb, 0, n, None)
                data = r[1] if isinstance(r, tuple) else r
                x = np.frombuffer(bytes(data), dtype=np.float32)
                self._push_float(x, 48000, holder)
            except Exception as e:
                _log("sck sample:", e)

        self.output.sink = sink
        self.stream = SCK.SCStream.alloc().initWithFilter_configuration_delegate_(filt, cfg, None)
        res = self.stream.addStreamOutput_type_sampleHandlerQueue_error_(self.output, 1, None, None)
        if isinstance(res, tuple) and not res[0]:
            raise _err("AUDIO_BACKEND", "ScreenCaptureKit refused the audio output: %s" % (res[1],))
        started = threading.Event()
        err = {}

        def on_start(error):
            err["e"] = error
            started.set()

        self.stream.startCaptureWithCompletionHandler_(on_start)
        if not started.wait(8.0) or err.get("e") is not None:
            raise _err("AUDIO_BACKEND", "ScreenCaptureKit did not start: %s" % (err.get("e") or "timeout"))

    def stop(self):
        Capture.stop(self)
        s = getattr(self, "stream", None)
        if s is not None:
            try:
                s.stopCaptureWithCompletionHandler_(lambda e: None)
            except Exception:
                pass


def make_capture(spec):
    if not isinstance(spec, dict):
        raise _err("BAD_REQUEST", "capture must be an object")
    backend = spec.get("backend")
    if backend not in CAPTURE_BACKENDS:
        raise _err("BAD_REQUEST", "capture.backend must be one of %s" % ", ".join(CAPTURE_BACKENDS))
    dev = _device_str(spec.get("device"), "capture")
    app = _device_str(spec.get("app"), "capture app")
    if backend == "pulse":
        return PulseCapture(dev, app)
    if backend == "file":
        return FileCapture(dev, app, realtime=spec.get("realtime", True) is not False)
    if np is None:
        raise _err("AUDIO_BACKEND", "The %s backend needs the voice runtime (numpy)" % backend)
    if backend == "wasapi-loopback":
        return SoundcardLoopback(dev, app)
    if backend == "sck":
        return SckCapture(dev, app)
    return DeviceCapture(dev, app)


# ------------------------------------------------------------------------------------------- playback backends

class Playback(object):
    """Paced writer: keeps at most `lead` seconds ahead of real time, so stopping is quick and the
    played position (for playedChars after barge-in) is known."""
    kind = "base"
    latency = 0.06

    def __init__(self, device="", lead=0.25):
        self.device = device
        self.lead = lead
        self.rate = 24000
        self.t0 = None
        self.written = 0
        self.lock = threading.RLock()

    def describe(self):
        return {"backend": self.kind, "device": self.device}

    def begin(self, rate):
        self.rate = int(rate)
        self.t0 = None
        self.written = 0

    def _raw_write(self, pcm):
        raise NotImplementedError

    def write(self, pcm, cancel=None):
        """Blocking, paced. False when cancelled or the device failed."""
        step = max(FRAME_BYTES, int(self.rate * 0.05) * 2)
        for i in range(0, len(pcm), step):
            piece = pcm[i:i + step]
            while True:
                if cancel is not None and cancel.is_set():
                    return False
                if self.t0 is None:
                    break
                ahead = self.written / float(self.rate) - (time.monotonic() - self.t0)
                if ahead <= self.lead:
                    break
                time.sleep(min(0.02, ahead - self.lead + 0.001))
            if self.t0 is None:
                self.t0 = time.monotonic()
            if not self._raw_write(piece):
                return False
            self.written += len(piece) // 2
        return True

    def played_samples(self):
        if self.t0 is None:
            return 0
        el = time.monotonic() - self.t0 - self.latency
        return int(max(0, min(self.written, el * self.rate)))

    def finish(self, cancel=None):
        """Wait until the written audio has been heard."""
        if self.t0 is None:
            return True
        end = self.t0 + self.written / float(self.rate) + self.latency
        while time.monotonic() < end:
            if cancel is not None and cancel.is_set():
                return False
            time.sleep(min(0.02, max(0.001, end - time.monotonic())))
        return True

    def abort(self):
        pass

    def close(self):
        self.abort()


class PulsePlayback(Playback):
    kind = "pulse"

    def __init__(self, device="", lead=0.25):
        Playback.__init__(self, device, lead)
        if self.device and not PULSE_NAME_RE.match(self.device):
            raise _err("BAD_REQUEST", "Invalid PulseAudio sink name")
        self.p = None
        self.p_rate = None

    def _spawn(self):
        pacat = _which(["pacat"])
        if not pacat:
            raise _err("AUDIO_BACKEND", "pacat is not installed", "Install the PulseAudio tools: sudo apt install pulseaudio-utils")
        argv = [pacat, "--playback", "--device=" + (self.device or "@DEFAULT_SINK@"), "--format=s16le", "--rate=%d" % self.rate,
                "--channels=1", "--raw", "--latency-msec=60", "--client-name=" + OWN_ID, "--property=application.id=" + OWN_ID,
                "--stream-name=Claude Anywhere voice"]
        try:
            self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, bufsize=0, env=_pulse_env())
        except OSError as e:
            raise _err("AUDIO_BACKEND", "Could not start pacat: %s" % e)
        self.p_rate = self.rate

    def begin(self, rate):
        Playback.begin(self, rate)
        with self.lock:
            if self.p is not None and (self.p.poll() is not None or self.p_rate != self.rate):
                self._kill()
            if self.p is None:
                self._spawn()

    def _raw_write(self, pcm):
        with self.lock:
            p = self.p
        if p is None:
            return False
        try:
            mv = memoryview(pcm)
            while len(mv):
                n = p.stdin.write(mv)
                if not n:
                    return False
                mv = mv[n:]
            return True
        except (BrokenPipeError, OSError, ValueError, AttributeError):
            return False

    def _kill(self):
        p, self.p = self.p, None
        if p is not None:
            try:
                p.kill()
            except Exception:
                pass
            try:
                p.stdin.close()
            except Exception:
                pass

    def abort(self):
        with self.lock:
            self._kill()  # drops what pacat and the server buffered; begin() starts a new one


class DevicePlayback(Playback):
    """An output device through sounddevice (CABLE Input, BlackHole 2ch, the speakers)."""
    kind = "device"
    latency = 0.08

    def __init__(self, device="", lead=0.25):
        Playback.__init__(self, device, lead)
        self.sd = _sounddevice()
        self.idx = _find_sd_device(self.sd, device, False)
        info = self.sd.query_devices(self.idx)
        self.device = str(info.get("name", device))
        self.dev_rate = int(info.get("default_samplerate") or 48000)
        self.buf = []
        self.buf_pos = 0
        self.stream = None
        self.rs = None

    def _open(self):
        if self.stream is not None:
            return

        def cb(outdata, frames, _time, status):
            out = outdata[:, 0]
            filled = 0
            with self.lock:
                while filled < frames and self.buf:
                    head = self.buf[0]
                    take = min(frames - filled, len(head) - self.buf_pos)
                    out[filled:filled + take] = head[self.buf_pos:self.buf_pos + take]
                    filled += take
                    self.buf_pos += take
                    if self.buf_pos >= len(head):
                        self.buf.pop(0)
                        self.buf_pos = 0
            if filled < frames:
                out[filled:] = 0.0

        kw = {}
        try:
            if sys.platform == "win32":
                kw["extra_settings"] = self.sd.WasapiSettings(auto_convert=True)
        except Exception:
            kw = {}
        try:
            self.stream = self.sd.OutputStream(device=self.idx, samplerate=self.dev_rate, channels=1, dtype="float32", callback=cb,
                                               blocksize=int(self.dev_rate * 0.02), **kw)
        except Exception:
            self.stream = self.sd.OutputStream(device=self.idx, samplerate=self.dev_rate, channels=1, dtype="float32", callback=cb,
                                               blocksize=int(self.dev_rate * 0.02))
        self.stream.start()

    def begin(self, rate):
        Playback.begin(self, rate)
        self.rs = StreamResampler(self.rate, self.dev_rate)
        self._open()

    def _raw_write(self, pcm):
        x = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        y = self.rs.process(x) if self.rs is not None else x
        with self.lock:
            self.buf.append(y)
        return True

    def abort(self):
        with self.lock:
            self.buf = []
            self.buf_pos = 0

    def close(self):
        self.abort()
        s, self.stream = self.stream, None
        if s is not None:
            try:
                s.abort()
                s.close()
            except Exception:
                pass


class FilePlayback(Playback):
    """Tests: appends what would be played to a WAV file under the state folder."""
    kind = "file"

    def __init__(self, device="", lead=0.25, realtime=True):
        Playback.__init__(self, device, lead)
        if not _test_backends_allowed():
            raise _err("BAD_REQUEST", "The file playback backend is for tests only")
        self.path = HOST.output_path(device) if HOST is not None else device
        self.realtime = realtime
        self.data = bytearray()
        self.file_rate = None
        self.latency = 0.0

    def begin(self, rate):
        Playback.begin(self, rate)
        if self.file_rate is None:
            self.file_rate = self.rate

    def write(self, pcm, cancel=None):
        if self.realtime:
            return Playback.write(self, pcm, cancel)
        if cancel is not None and cancel.is_set():
            return False
        if self.t0 is None:
            self.t0 = time.monotonic() - 3600.0  # everything counts as played at once
        self._raw_write(pcm)
        self.written += len(pcm) // 2
        return True

    def _raw_write(self, pcm):
        if self.file_rate != self.rate:
            pcm = resample_pcm16_simple(pcm, self.rate, self.file_rate)
        with self.lock:
            self.data.extend(pcm)
            self.dirty = True
        return True

    def _flush(self):
        with self.lock:
            if getattr(self, "dirty", False):
                self.dirty = False
                write_wav_private(self.path, bytes(self.data), self.file_rate or 24000)

    def finish(self, cancel=None):
        ok = Playback.finish(self, cancel)
        self._flush()
        return ok

    def abort(self):
        self._flush()

    def close(self):
        self._flush()


def make_playback(spec):
    if not isinstance(spec, dict):
        raise _err("BAD_REQUEST", "playback must be an object")
    backend = spec.get("backend")
    if backend not in PLAYBACK_BACKENDS:
        raise _err("BAD_REQUEST", "playback.backend must be one of %s" % ", ".join(PLAYBACK_BACKENDS))
    dev = _device_str(spec.get("device"), "playback")
    if backend == "pulse":
        return PulsePlayback(dev)
    if backend == "file":
        return FilePlayback(dev, realtime=spec.get("realtime", True) is not False)
    if np is None:
        raise _err("AUDIO_BACKEND", "The device backend needs the voice runtime (numpy)")
    return DevicePlayback(dev)


# ------------------------------------------------------------------------------------------- player

class Utterance(object):
    def __init__(self, uid, text=None, wav=None, speed=None):
        self.id = uid
        self.text = text or ""
        self.wav = wav
        self.speed = speed
        self.cancel = threading.Event()
        self.gen = 0
        self.marks = []  # [chars, samples written] per clause
        self.started = False
        self.ended = False
        self.rate = 24000
        self.done = threading.Event()
        self.result = None


class Player(object):
    """tts.say / audio.play queue: a synthesis thread renders clause by clause (in the enrolled voice) into
    a PCM queue; a writer thread plays it paced into the backend. stop() empties both at once."""

    def __init__(self):
        self.lock = threading.RLock()
        self.items = queue.Queue()
        self.out = queue.Queue()
        self.backend = None
        self.backend_key = None
        self.gen = 0
        self.playing = None
        self.synthesizing = None
        self.pending = 0
        self.last_end = 0.0
        self.threads = None

    def _ensure_threads(self):
        if self.threads is None:
            self.threads = [threading.Thread(target=self._synth_loop, name="audio-synth", daemon=True),
                            threading.Thread(target=self._write_loop, name="audio-play", daemon=True)]
            for t in self.threads:
                t.start()

    @property
    def active(self):
        return self.playing is not None or self.synthesizing is not None or self.pending > 0

    def set_backend(self, spec):
        key = (spec.get("backend"), spec.get("device") or "", spec.get("realtime", True) is not False)
        with self.lock:
            if self.backend is not None and self.backend_key == key:
                return self.backend
            nb = make_playback(spec)
            old, self.backend, self.backend_key = self.backend, nb, key
        if old is not None:
            self.stop("device_changed")
            try:
                old.close()
            except Exception:
                pass
        return nb

    def enqueue(self, u):
        if self.backend is None:
            raise _err("AUDIO_BACKEND", "No playback device: start the call audio first (audio.start) or pass playback")
        self._ensure_threads()
        with self.lock:
            u.gen = self.gen
            self.pending += 1
        self.items.put(u)
        return self.pending

    def _synth_loop(self):
        while True:
            u = self.items.get()
            if u is None:
                return
            with self.lock:
                self.pending = max(0, self.pending - 1)
                if u.gen != self.gen or u.ended:
                    continue
                self.synthesizing = u
            err = None
            try:
                if u.wav:
                    rate, pcm = read_wav_pcm16(u.wav)
                    u.rate = rate
                    u.marks.append([len(u.text), len(pcm) // 2])
                    self.out.put((u, "begin", rate))
                    step = int(rate * 0.1) * 2
                    for i in range(0, len(pcm), step):
                        if u.cancel.is_set() or u.gen != self.gen:
                            break
                        self.out.put((u, "pcm", (pcm[i:i + step], 0)))
                else:
                    if not HOST.tts_ready():
                        raise _err("PROFILE_INVALID", "The cloned voice is not loaded (tts.load and tts.setVoice first)",
                                   "Record your voice first: /anywhere:clone-voice")
                    u.rate = int(HOST.tts_sample_rate())
                    self.out.put((u, "begin", u.rate))
                    clauses = HOST.split_clauses(u.text) or [u.text]
                    for ci, clause in enumerate(clauses):
                        if u.cancel.is_set() or u.gen != self.gen:
                            break
                        u.marks.append([len(clause) + (1 if ci < len(clauses) - 1 else 0), 0])

                        def on_chunk(samples, _index, ci=ci, u=u):
                            if u.gen == self.gen and not u.cancel.is_set():
                                # Counted where the audio is made (not where it is written, which runs only
                                # `lead` seconds ahead), so playedChars is the share of each clause heard.
                                u.marks[ci][1] += len(samples)
                                self.out.put((u, "pcm", (floats_to_pcm16(samples), ci)))

                        HOST.synthesize(clause, on_chunk=on_chunk, cancel=u.cancel, speed=u.speed)
            except Exception as e:
                code = getattr(e, "code", "INTERNAL")
                if code != "CANCELLED":
                    err = {"code": code, "message": getattr(e, "message", None) or str(e)}
                    _log("utterance %s failed: %s" % (u.id, err["message"]))
            finally:
                with self.lock:
                    self.synthesizing = None
            self.out.put((u, "end", err))

    def _write_loop(self):
        while True:
            u, kind, payload = self.out.get()
            if u is None:
                return
            if u.gen != self.gen or u.ended:
                continue
            try:
                if kind == "begin":
                    self.backend.begin(payload)
                elif kind == "pcm":
                    pcm, ci = payload
                    with self.lock:
                        if u.gen != self.gen or u.ended:
                            continue
                        if not u.started:
                            u.started = True
                            self.playing = u
                            _emit("playback.start", utteranceId=u.id, rate=u.rate, at=round(time.time(), 3))
                    if not self.backend.write(pcm, u.cancel) and not u.cancel.is_set():
                        self._end(u, interrupted=True, error={"code": "AUDIO_BACKEND", "message": "The playback device stopped"})
                elif kind == "end":
                    if u.started:
                        self.backend.finish(u.cancel)
                    with self.lock:
                        if not u.ended:
                            self._end(u, interrupted=u.cancel.is_set(), error=payload)
            except Exception as e:
                _log("playback failed:", e)
                with self.lock:
                    self._end(u, interrupted=True, error={"code": getattr(e, "code", "AUDIO_BACKEND"), "message": str(e)})

    def _played_chars(self, u, played):
        chars = 0
        left = played
        for c, n in u.marks:
            if n <= 0:
                continue
            if left >= n:
                chars += c
                left -= n
            else:
                chars += int(c * left / float(n))
                break
        return min(chars, len(u.text))

    def _end(self, u, interrupted, error=None):
        with self.lock:
            if u.ended:
                return
            u.ended = True
            if self.playing is u:
                self.playing = None
                self.last_end = time.monotonic()
            total = sum(n for _c, n in u.marks)
            played = total
            if u.started and interrupted and self.backend is not None:
                played = min(total, self.backend.played_samples())
            elif not u.started:
                played = 0
            ev = {
                "utteranceId": u.id,
                "interrupted": bool(interrupted),
                "started": bool(u.started),
                "chars": len(u.text),
                "playedChars": self._played_chars(u, played) if (u.text and u.started) else 0,
                "playedMs": int(played * 1000 / float(u.rate or 24000)),
            }
            if error:
                ev["error"] = error
            u.result = ev
        _emit("playback.end", **ev)
        u.done.set()

    def stop(self, reason="stopped"):
        """Stop speaking now: cancel synthesis, drop queued audio, kill the device buffer (<100 ms)."""
        with self.lock:
            self.gen += 1
            cur, syn = self.playing, self.synthesizing
            dropped = []
            while True:
                try:
                    dropped.append(self.items.get_nowait())
                except queue.Empty:
                    break
            while True:
                try:
                    item = self.out.get_nowait()
                    if item[0] is not None and item[0] not in dropped:
                        dropped.append(item[0])
                except queue.Empty:
                    break
            self.pending = 0
            for u in (syn, cur):
                if u is not None:
                    u.cancel.set()
            if cur is not None:
                self._end(cur, interrupted=True)
            for u in dropped:
                if u is not None and u is not cur:
                    u.cancel.set()
                    self._end(u, interrupted=True)
            if syn is not None and syn is not cur and not syn.started:
                self._end(syn, interrupted=True)
            if self.backend is not None:
                try:
                    self.backend.abort()
                except Exception:
                    pass
            self.playing = None
            self.last_end = time.monotonic()
        return {"stopped": True, "reason": reason}

    def close(self):
        self.stop("closed")
        with self.lock:
            b, self.backend, self.backend_key = self.backend, None, None
        if b is not None:
            try:
                b.close()
            except Exception:
                pass

    def status(self):
        return {"backend": self.backend.describe() if self.backend else None, "playing": self.playing.id if self.playing else None,
                "queued": self.pending, "active": self.active}


PLAYER = Player()


# ------------------------------------------------------------------------------------------- VAD

class EnergyVad(object):
    """Fallback when Silero is not loaded (and in fake mode): frame RMS against an adaptive noise floor."""

    def __init__(self, min_silence_ms=600, min_speech_ms=250, threshold=None, preroll_ms=200, max_speech_s=20.0):
        self.min_sil = int(min_silence_ms)
        self.min_speech = int(min_speech_ms)
        self.fixed = threshold
        self.noise = 0.002
        self.preroll = []
        self.preroll_n = max(1, preroll_ms // FRAME_MS)
        self.max_frames = int(max_speech_s * 1000 / FRAME_MS)
        self.reset()

    def reset(self):
        self.speaking = False
        self.run_speech = 0
        self.run_sil = 0
        self.seg = []
        self.start_t = None
        self.preroll = []

    def push(self, frame, t):
        rms, _pk = pcm16_stats(frame)
        thr = self.fixed if self.fixed else max(self.noise * 3.16, 0.008)
        loud = rms > thr
        if not self.speaking and not loud:
            self.noise = 0.95 * self.noise + 0.05 * max(rms, 1e-5)
        ev = []
        if not self.speaking:
            self.preroll.append(frame)
            del self.preroll[:-self.preroll_n - self.min_speech // FRAME_MS - 1]
            self.run_speech = self.run_speech + FRAME_MS if loud else 0
            if self.run_speech >= self.min_speech:
                self.speaking = True
                self.seg = list(self.preroll)
                self.start_t = max(0.0, t + FRAME_MS / 1000.0 - len(self.seg) * FRAME_MS / 1000.0)
                self.run_sil = 0
                ev.append(("start", t))
            return ev
        self.seg.append(frame)
        self.run_sil = 0 if loud else self.run_sil + FRAME_MS
        if self.run_sil >= self.min_sil or len(self.seg) >= self.max_frames:
            # Keep 100 ms of the trailing silence, like Silero's segments.
            drop = max(0, (self.run_sil - 100) // FRAME_MS)
            frames = self.seg[: len(self.seg) - drop] if drop else self.seg
            ev.append(("end", t + FRAME_MS / 1000.0, b"".join(frames), self.start_t))
            self.reset()
        return ev


class SileroVad(object):
    """sherpa-onnx VoiceActivityDetector (from host.new_vad); segments come out after min silence."""

    def __init__(self, vad):
        self.vad = vad
        self.buf = np.zeros(0, dtype=np.float32)
        self.fed = 0
        self.speaking = False

    def reset(self):
        try:
            self.vad.reset()
        except Exception:
            pass
        self.buf = np.zeros(0, dtype=np.float32)
        self.speaking = False

    def push(self, frame, t):
        x = np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0
        self.buf = np.concatenate([self.buf, x]) if len(self.buf) else x
        ev = []
        while len(self.buf) >= 512:
            w, self.buf = self.buf[:512], self.buf[512:]
            self.vad.accept_waveform(w)
            self.fed += 512
            now = self.fed / float(CAPTURE_RATE)
            while not self.vad.empty():
                seg = self.vad.front
                samples = np.array(seg.samples, dtype=np.float32)
                start = seg.start / float(CAPTURE_RATE)
                self.vad.pop()
                if not self.speaking:
                    ev.append(("start", start))
                ev.append(("end", start + len(samples) / float(CAPTURE_RATE), floats_to_pcm16(samples), start))
                self.speaking = False
            det = bool(self.vad.is_speech_detected())
            if det and not self.speaking:
                self.speaking = True
                ev.append(("start", now))
        return ev


# ------------------------------------------------------------------------------------------- live session

class LiveSession(object):
    def __init__(self, p):
        self.capture = make_capture(p.get("capture") or {})
        vad = p.get("vad") if isinstance(p.get("vad"), dict) else {}
        self.vad_cfg = {
            "threshold": _num(vad.get("threshold"), 0.5, 0.05, 0.99),
            "minSilenceMs": int(_num(vad.get("minSilenceMs"), 600, 100, 5000)),
            "minSpeechMs": int(_num(vad.get("minSpeechMs"), 250, 60, 5000)),
        }
        energy = vad.get("energyThreshold")
        sv = HOST.new_vad(self.vad_cfg["threshold"], self.vad_cfg["minSilenceMs"], self.vad_cfg["minSpeechMs"], CAPTURE_RATE) if HOST is not None else None
        if sv is not None:
            self.vad = SileroVad(sv)
            self.vad_kind = "silero"
        else:
            self.vad = EnergyVad(self.vad_cfg["minSilenceMs"], self.vad_cfg["minSpeechMs"],
                                 threshold=_num(energy, 0, 0, 1) or None)
            self.vad_kind = "energy"
        b = p.get("bargeIn")
        self.barge = None
        if isinstance(b, dict):
            self.barge = {"minSpeechMs": int(_num(b.get("minSpeechMs"), 400, 100, 5000)), "stopPlayback": b.get("stopPlayback", True) is not False}
        self.half = bool(p.get("halfDuplex"))
        if self.half:
            self.barge = None
        self.tail = _num(p.get("tailMs"), 300 if self.half else 0, 0, 3000) / 1000.0
        self.asr = p.get("asr", True) is not False
        self.level_s = _num(p.get("levelIntervalMs"), 500, 0, 10000) / 1000.0
        self.stopping = threading.Event()
        self.asr_q = queue.Queue()
        self.samples = 0
        self.speech_t = None
        self.barged = False
        self.stats = {"frames": 0, "segments": 0, "finals": 0, "bargeIns": 0, "dropped": 0}
        self.asr_warned = False
        self.restarts = 0

    def start(self):
        self.capture.start()
        threading.Thread(target=self._capture_loop, name="audio-capture", daemon=True).start()
        threading.Thread(target=self._asr_loop, name="audio-asr", daemon=True).start()

    def stop(self):
        self.stopping.set()
        try:
            self.capture.stop()
        except Exception:
            pass
        self.asr_q.put(None)

    def describe(self):
        return {"capture": self.capture.describe(), "vad": self.vad_kind, "halfDuplex": self.half, "bargeIn": self.barge, "stats": dict(self.stats),
                "t": round(self.samples / float(CAPTURE_RATE), 3)}

    def _restart_capture(self, why):
        if self.restarts >= 1 or self.stopping.is_set():
            return False
        self.restarts += 1
        _log("capture restarting after:", why)
        try:
            self.capture.stop()
        except Exception:
            pass
        time.sleep(0.5)
        try:
            spec = self.capture.describe()
            spec["app"] = self.capture.app
            self.capture = make_capture(spec)
            self.capture.start()
            return True
        except Exception as e:
            _log("capture restart failed:", e)
            return False

    def _capture_loop(self):
        lvl_sum = 0.0
        lvl_n = 0
        lvl_pk = 0.0
        last_lvl = 0.0  # stream time (seconds of capture), so levels follow the audio, not the clock
        while not self.stopping.is_set():
            frame = self.capture.read(0.5)
            if frame is None:
                code, msg = self.capture.error or ("AUDIO_BACKEND", "capture ended")
                if self._restart_capture(msg):
                    continue
                if not self.stopping.is_set():
                    _emit("audio.error", code=code, message=msg, where="capture")
                return
            if not frame:
                continue
            t = self.samples / float(CAPTURE_RATE)
            self.samples += len(frame) // 2
            self.stats["frames"] += 1
            if self.level_s > 0:
                rms, pk = pcm16_stats(frame)
                lvl_sum += rms * rms
                lvl_n += 1
                lvl_pk = max(lvl_pk, pk)
                if t + FRAME_MS / 1000.0 - last_lvl >= self.level_s:
                    r = math.sqrt(lvl_sum / max(1, lvl_n))
                    _emit("level", rms=round(r, 5), peak=round(lvl_pk, 4), db=dbfs(r), t=round(t, 2))
                    lvl_sum, lvl_n, lvl_pk, last_lvl = 0.0, 0, 0.0, t + FRAME_MS / 1000.0
            if self.half and (PLAYER.active or time.monotonic() < PLAYER.last_end + self.tail):
                # Half duplex (speaker mode): the capture contains our own voice; do not listen while speaking.
                if self.vad.speaking:
                    self.vad.reset()
                    self.speech_t = None
                self.stats["dropped"] += 1
                continue
            for ev in self.vad.push(frame, t):
                if ev[0] == "start":
                    self.speech_t = ev[1]
                    self.barged = False
                    _emit("vad.start", t=round(ev[1], 3))
                else:
                    t_det, pcm, t0 = ev[1], ev[2], ev[3]
                    ms = int(len(pcm) / 2 * 1000 / CAPTURE_RATE)
                    self.stats["segments"] += 1
                    _emit("vad.end", t=round(t_det, 3), ms=ms)
                    self.speech_t = None
                    if self.asr and ms >= 200:
                        self.asr_q.put((pcm, t0, t0 + ms / 1000.0))
            if self.barge and self.speech_t is not None and not self.barged and PLAYER.playing is not None:
                speech_ms = (t - self.speech_t) * 1000.0 + self.vad_cfg["minSpeechMs"]
                if speech_ms >= self.barge["minSpeechMs"]:
                    self.barged = True
                    self.stats["bargeIns"] += 1
                    cur = PLAYER.playing
                    _emit("barge_in", t=round(t, 3), utteranceId=cur.id if cur else None)
                    if self.barge["stopPlayback"]:
                        PLAYER.stop("barge_in")

    def _asr_loop(self):
        while True:
            item = self.asr_q.get()
            if item is None:
                return
            pcm, t0, t1 = item
            if HOST is None or not (HOST.fake or HOST.asr_ready()):
                if not self.asr_warned:
                    self.asr_warned = True
                    _emit("audio.error", code="MODEL_MISSING", message="Speech recognition is not loaded (asr.load)", where="asr")
                continue
            t_start = time.perf_counter()
            try:
                text = HOST.transcribe(pcm16_to_float(pcm), CAPTURE_RATE)
            except Exception as e:
                _emit("audio.error", code=getattr(e, "code", "INTERNAL"), message=str(e), where="asr")
                continue
            text = re.sub(r"\s+", " ", str(text or "")).strip()
            if not text:
                continue
            self.stats["finals"] += 1
            _emit("asr.final", text=text, t0=round(t0, 3), t1=round(t1, 3), ms=int((time.perf_counter() - t_start) * 1000))


def _num(v, default, lo, hi):
    if v is None or isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return default
    return max(lo, min(hi, v))


class _Live(object):
    session = None
    recorder = None
    lock = threading.Lock()


# ------------------------------------------------------------------------------------------- recorder

class Recorder(object):
    def __init__(self, capture, out, seconds):
        self.capture = capture
        self.out = out
        self.seconds = seconds
        self.data = bytearray()
        self.done = threading.Event()
        self.stopping = threading.Event()
        self.result = None
        self.error = None

    def start(self):
        self.capture.start()
        threading.Thread(target=self._run, name="audio-record", daemon=True).start()

    def _run(self):
        want = int(self.seconds * CAPTURE_RATE) * 2 if self.seconds else None
        try:
            while not self.stopping.is_set():
                f = self.capture.read(0.5)
                if f is None:
                    self.error = self.capture.error or ("AUDIO_BACKEND", "capture ended")
                    break
                if f:
                    self.data.extend(f)
                    if want is not None and len(self.data) >= want:
                        del self.data[want:]
                        break
                if len(self.data) > 600 * CAPTURE_RATE * 2:
                    break
        finally:
            try:
                self.capture.stop()
            except Exception:
                pass
            self._finish()

    def _finish(self):
        pcm = bytes(self.data)
        try:
            write_wav_private(self.out, pcm, CAPTURE_RATE)
        except Exception as e:
            self.error = ("BAD_REQUEST", "Could not write the recording: %s" % e)
        rms, pk = pcm16_stats(pcm)
        self.result = {"out": self.out, "seconds": round(len(pcm) / 2.0 / CAPTURE_RATE, 3), "peak": dbfs(pk), "rms": dbfs(rms), "backend": self.capture.kind}
        if self.error:
            self.result["error"] = {"code": self.error[0], "message": self.error[1]}
        _emit("record.done", **self.result)
        self.done.set()

    def stop(self, timeout=3.0):
        self.stopping.set()
        self.done.wait(timeout)
        return self.result


# ------------------------------------------------------------------------------------------- devices

def _pactl_short(what):
    exe = _which(["pactl"])
    if not exe:
        return []
    try:
        r = subprocess.run([exe, "list", "short", what], capture_output=True, timeout=5, env=_pulse_env(), **_no_window())
        rows = []
        for line in r.stdout.decode("utf-8", "replace").splitlines():
            f = line.split("\t")
            if len(f) >= 2 and f[0].isdigit():
                rows.append({"index": f[0], "name": f[1], "state": f[4].strip() if len(f) > 4 else ""})
        return rows
    except Exception:
        return []


def _pactl_info():
    exe = _which(["pactl"])
    if not exe:
        return {}
    try:
        r = subprocess.run([exe, "info"], capture_output=True, timeout=5, env=_pulse_env(), **_no_window())
        out = {}
        for line in r.stdout.decode("utf-8", "replace").splitlines():
            k, _s, v = line.partition(":")
            out[k.strip()] = v.strip()
        return out
    except Exception:
        return {}


def _no_window():
    if sys.platform == "win32":
        return {"creationflags": 0x08000000}  # CREATE_NO_WINDOW
    return {}


def list_devices():
    out = {"platform": sys.platform, "inputs": [], "outputs": [], "loopbacks": [], "defaults": {"input": None, "output": None}, "backends": {}}
    if sys.platform.startswith("linux"):
        out["backends"]["pulse"] = bool(_which(["parec"]) and _which(["pacat"]))
        info = _pactl_info()
        out["defaults"] = {"input": info.get("Default Source") or None, "output": info.get("Default Sink") or None}
        out["server"] = info.get("Server Name") or None
        for s in _pactl_short("sources"):
            d = {"name": s["name"], "id": s["index"], "backend": "pulse", "virtual": bool(VIRTUAL_RE.search(s["name"]))}
            (out["loopbacks"] if s["name"].endswith(".monitor") else out["inputs"]).append(d)
        for s in _pactl_short("sinks"):
            out["outputs"].append({"name": s["name"], "id": s["index"], "backend": "pulse", "virtual": bool(VIRTUAL_RE.search(s["name"]))})
    if np is not None and not sys.platform.startswith("linux"):
        try:
            sd = _sounddevice()
            out["backends"]["sounddevice"] = True
            apis = sd.query_hostapis()
            for i, d in enumerate(sd.query_devices()):
                api = apis[d["hostapi"]]["name"] if 0 <= d.get("hostapi", -1) < len(apis) else ""
                if sys.platform == "win32" and api not in ("Windows WASAPI",):
                    continue  # one entry per device (the WASAPI one has the full name)
                base = {"name": d["name"], "id": i, "backend": "device", "hostapi": api, "virtual": bool(VIRTUAL_RE.search(d["name"])),
                        "rate": int(d.get("default_samplerate") or 0)}
                if d.get("max_input_channels", 0) > 0:
                    out["inputs"].append(dict(base, channels=d["max_input_channels"]))
                if d.get("max_output_channels", 0) > 0:
                    out["outputs"].append(dict(base, channels=d["max_output_channels"]))
            di, do = sd.default.device
            if di is not None and di >= 0:
                out["defaults"]["input"] = sd.query_devices(di)["name"]
            if do is not None and do >= 0:
                out["defaults"]["output"] = sd.query_devices(do)["name"]
        except Exception as e:
            out["backends"]["sounddevice"] = False
            out["errors"] = [str(getattr(e, "message", e))]
    if sys.platform == "win32" and np is not None:
        try:
            import soundcard as sc  # noqa
            out["backends"]["soundcard"] = True
            for m in sc.all_microphones(include_loopback=True):
                if getattr(m, "isloopback", False):
                    out["loopbacks"].append({"name": str(m.name), "id": str(m.id), "backend": "wasapi-loopback", "virtual": bool(VIRTUAL_RE.search(str(m.name)))})
        except Exception as e:
            out["backends"]["soundcard"] = False
            out.setdefault("errors", []).append("soundcard: %s" % e)
    if sys.platform == "darwin":
        sck = {"name": "ScreenCaptureKit", "id": "sck", "backend": "sck", "virtual": False, "available": False}
        try:
            ver = tuple(int(x) for x in (__import__("platform").mac_ver()[0] or "0").split(".")[:2])
            import ScreenCaptureKit  # noqa
            sck["available"] = ver >= (13, 0)
        except Exception as e:
            sck["error"] = str(e)
        out["loopbacks"].append(sck)
        out["backends"]["sck"] = sck["available"]
        try:
            cur = CoreAudio().default_input()
            if cur:
                out["defaults"]["input"] = cur["name"]
        except Exception:
            pass
    return out


# ------------------------------------------------------------------------------------------- macOS CoreAudio (ctypes)

def _fourcc(s):
    return struct.unpack(">I", s.encode("ascii"))[0]


class CoreAudio(object):
    """Default input device get/set through the CoreAudio C API (ctypes; no extra package).
    Not verified on a Mac yet (design section 5.3)."""

    def __init__(self):
        import ctypes
        self.c = ctypes
        self.ca = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreAudio.framework/CoreAudio")
        self.cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")

        class Addr(ctypes.Structure):
            _fields_ = [("mSelector", ctypes.c_uint32), ("mScope", ctypes.c_uint32), ("mElement", ctypes.c_uint32)]

        self.Addr = Addr
        u32p = ctypes.POINTER(ctypes.c_uint32)
        self.ca.AudioObjectGetPropertyDataSize.argtypes = [ctypes.c_uint32, ctypes.POINTER(Addr), ctypes.c_uint32, ctypes.c_void_p, u32p]
        self.ca.AudioObjectGetPropertyData.argtypes = [ctypes.c_uint32, ctypes.POINTER(Addr), ctypes.c_uint32, ctypes.c_void_p, u32p, ctypes.c_void_p]
        self.ca.AudioObjectSetPropertyData.argtypes = [ctypes.c_uint32, ctypes.POINTER(Addr), ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]
        self.cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
        self.cf.CFStringGetCString.restype = ctypes.c_bool
        self.cf.CFRelease.argtypes = [ctypes.c_void_p]

    def _addr(self, sel, scope="glob"):
        return self.Addr(_fourcc(sel), _fourcc(scope), 0)

    def _size(self, obj, addr):
        n = self.c.c_uint32(0)
        st = self.ca.AudioObjectGetPropertyDataSize(obj, self.c.byref(addr), 0, None, self.c.byref(n))
        return n.value if st == 0 else 0

    def devices(self):
        a = self._addr("dev#")
        size = self._size(1, a)
        count = size // 4
        buf = (self.c.c_uint32 * max(1, count))()
        n = self.c.c_uint32(size)
        if self.ca.AudioObjectGetPropertyData(1, self.c.byref(a), 0, None, self.c.byref(n), buf) != 0:
            return []
        out = []
        for i in range(count):
            dev = buf[i]
            ins = self._size(dev, self._addr("stm#", "inpt")) // 4
            outs = self._size(dev, self._addr("stm#", "outp")) // 4
            out.append({"id": int(dev), "name": self._string(dev, "lnam"), "uid": self._string(dev, "uid "), "inputs": ins, "outputs": outs})
        return out

    def _string(self, obj, sel):
        a = self._addr(sel)
        ref = self.c.c_void_p()
        n = self.c.c_uint32(self.c.sizeof(ref))
        if self.ca.AudioObjectGetPropertyData(obj, self.c.byref(a), 0, None, self.c.byref(n), self.c.byref(ref)) != 0 or not ref.value:
            return ""
        buf = self.c.create_string_buffer(1024)
        ok = self.cf.CFStringGetCString(ref, buf, 1024, 0x08000100)
        self.cf.CFRelease(ref)
        return buf.value.decode("utf-8", "replace") if ok else ""

    def default_input(self):
        a = self._addr("dIn ")
        dev = self.c.c_uint32(0)
        n = self.c.c_uint32(4)
        if self.ca.AudioObjectGetPropertyData(1, self.c.byref(a), 0, None, self.c.byref(n), self.c.byref(dev)) != 0:
            return None
        return {"id": int(dev.value), "name": self._string(dev.value, "lnam"), "uid": self._string(dev.value, "uid ")}

    def set_default_input(self, name=None, uid=None):
        devs = [d for d in self.devices() if d["inputs"] > 0]
        pick = None
        if uid:
            pick = next((d for d in devs if d["uid"] == uid), None)
        if pick is None and name:
            want = name.lower()
            pick = next((d for d in devs if d["name"].lower() == want), None) or next((d for d in devs if want in d["name"].lower()), None)
        if pick is None:
            raise _err("DEVICE_NOT_FOUND", "No input device named %s" % (name or uid))
        a = self._addr("dIn ")
        dev = self.c.c_uint32(pick["id"])
        st = self.ca.AudioObjectSetPropertyData(1, self.c.byref(a), 0, None, 4, self.c.byref(dev))
        if st != 0:
            raise _err("AUDIO_BACKEND", "CoreAudio refused the default input change (status %d)" % st)
        return {"name": pick["name"], "uid": pick["uid"], "via": "CoreAudio"}


def default_input(set_name=None, uid=None):
    if sys.platform == "darwin":
        ca = CoreAudio()
        if set_name or uid:
            return ca.set_default_input(set_name, uid)
        d = ca.default_input() or {}
        return {"name": d.get("name"), "uid": d.get("uid"), "via": "CoreAudio"}
    if sys.platform.startswith("linux"):
        if set_name:
            if not PULSE_NAME_RE.match(set_name):
                raise _err("BAD_REQUEST", "Invalid source name")
            exe = _which(["pactl"])
            if not exe:
                raise _err("AUDIO_BACKEND", "pactl is not installed")
            r = subprocess.run([exe, "set-default-source", set_name], capture_output=True, timeout=5, env=_pulse_env())
            if r.returncode != 0:
                raise _err("AUDIO_BACKEND", "pactl set-default-source failed: %s" % r.stderr.decode("utf-8", "replace").strip())
        return {"name": _pactl_info().get("Default Source") or None, "via": "pactl"}
    raise _err("AUDIO_BACKEND", "On Windows the default microphone is switched by the PowerShell host (audioDefaultSet)")


# ------------------------------------------------------------------------------------------- ops

def op_devices(p, ctx):
    return list_devices()


def op_start(p, ctx):
    pb = p.get("playback")
    with _Live.lock:
        old = _Live.session
        _Live.session = None
    if old is not None:
        old.stop()
    if isinstance(pb, dict):
        PLAYER.set_backend(pb)
    s = LiveSession(p)
    s.start()
    with _Live.lock:
        _Live.session = s
    return {"started": True, "vad": s.vad_kind, "capture": s.capture.describe(), "playback": PLAYER.backend.describe() if PLAYER.backend else None,
            "halfDuplex": s.half, "bargeIn": s.barge}


def op_stop(p, ctx):
    """Reader thread: quick."""
    with _Live.lock:
        s, _Live.session = _Live.session, None
    stats = s.describe() if s else None
    if s is not None:
        s.stop()
    PLAYER.close()
    return {"stopped": s is not None, "session": stats}


def op_status(p, ctx):
    with _Live.lock:
        s = _Live.session
        r = _Live.recorder
    return {"session": s.describe() if s else None, "player": PLAYER.status(), "recording": bool(r and not r.done.is_set())}


def _utterance_id(p):
    uid = p.get("utteranceId")
    if uid is None:
        return "u%d" % int(time.time() * 1000)
    if isinstance(uid, bool) or not isinstance(uid, (str, int)) or len(str(uid)) > 64:
        raise _err("BAD_REQUEST", "Invalid utteranceId")
    return uid


def _queue(p, u):
    if isinstance(p.get("playback"), dict):
        PLAYER.set_backend(p["playback"])
    if p.get("interrupt"):
        PLAYER.stop("interrupt")
    pos = PLAYER.enqueue(u)
    return pos


def op_say(p, ctx):
    text = p.get("text")
    wav = p.get("wav")
    if wav:
        u = Utterance(_utterance_id(p), text=text if isinstance(text, str) else "", wav=_inside_state(wav))
    else:
        if not isinstance(text, str) or not text.strip():
            raise _err("BAD_REQUEST", "Nothing to speak")
        if len(text) > 2000:
            raise _err("BAD_REQUEST", "The text is longer than 2000 characters")
        if not HOST.tts_ready():
            raise _err("PROFILE_INVALID", "The cloned voice is not loaded (tts.load and tts.setVoice first)", "Record your voice first: /anywhere:clone-voice")
        speed = p.get("speed")
        u = Utterance(_utterance_id(p), text=re.sub(r"\s+", " ", text).strip(), speed=_num(speed, None, 0.5, 2.0) if speed is not None else None)
    pos = _queue(p, u)
    return {"queued": True, "utteranceId": u.id, "position": pos}


def op_play(p, ctx):
    wav = _inside_state(p.get("wav"))
    text = p.get("text") if isinstance(p.get("text"), str) else ""
    u = Utterance(_utterance_id(p), text=text, wav=wav)
    _queue(p, u)
    if p.get("wait"):
        rate, pcm = read_wav_pcm16(wav)
        limit = len(pcm) / 2.0 / max(1, rate) + 15.0
        if not u.done.wait(limit):
            raise _err("AUDIO_BACKEND", "Playback did not finish")
        r = dict(u.result or {})
        r["played"] = True
        return r
    return {"queued": True, "utteranceId": u.id}


def op_default_input(p, ctx):
    name = p.get("set")
    uid = p.get("uid")
    if name is not None and not isinstance(name, str):
        raise _err("BAD_REQUEST", "set must be a device name")
    return default_input(_device_str(name, "input") or None, _device_str(uid, "input") or None)


def op_record_start(p, ctx):
    out = HOST.output_path(p.get("out"))
    seconds = _num(p.get("seconds"), 0, 0, 600)
    spec = {"backend": p.get("backend"), "device": p.get("device"), "app": p.get("app")}
    if "realtime" in p:
        spec["realtime"] = p.get("realtime")
    with _Live.lock:
        old = _Live.recorder
        if old is not None and not old.done.is_set():
            raise _err("BAD_REQUEST", "A recording is already running (record.stop first)")
        rec = Recorder(make_capture(spec), out, seconds or None)
        _Live.recorder = rec
    rec.start()
    if p.get("wait") and seconds:
        rec.done.wait(seconds + 10.0)
        if not rec.done.is_set():
            rec.stop()
        r = rec.result or {}
        if r.get("error") and not r.get("seconds"):
            raise _err(r["error"]["code"], r["error"]["message"])
        return r
    return {"recording": True, "out": out, "seconds": seconds or None}


def op_record_stop(p, ctx):
    with _Live.lock:
        rec = _Live.recorder
    if rec is None:
        raise _err("BAD_REQUEST", "No recording is running")
    r = rec.stop()
    if r is None:
        raise _err("AUDIO_BACKEND", "The recording did not stop")
    return r


def on_tts_stop(p, ctx):
    PLAYER.stop("tts.stop")


def on_shutdown(p, ctx):
    with _Live.lock:
        s, _Live.session = _Live.session, None
        r = _Live.recorder
    if s is not None:
        s.stop()
    if r is not None and not r.done.is_set():
        r.stop(1.0)
    PLAYER.close()


def register(host):
    global HOST, np
    HOST = host
    np = host.numpy
    return {
        "audio.devices": op_devices,
        "audio.start": op_start,
        "audio.stop": op_stop,
        "audio.status": op_status,
        "audio.play": op_play,
        "audio.defaultInput": op_default_input,
        "tts.say": op_say,
        "tts.stop": on_tts_stop,
        "record.start": op_record_start,
        "record.stop": op_record_stop,
        "shutdown": on_shutdown,
    }


# ------------------------------------------------------------------------------------------- command line

def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Claude Anywhere call audio helper")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("get-default-input")
    s = sub.add_parser("set-default-input")
    s.add_argument("--name")
    s.add_argument("--uid")
    sub.add_parser("devices")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "get-default-input":
            r = default_input()
        elif a.cmd == "set-default-input":
            r = default_input(a.name, a.uid)
        elif a.cmd == "devices":
            r = list_devices()
        else:
            ap.print_help()
            return 2
        sys.stdout.write(json.dumps({"ok": True, "result": r}) + "\n")
        return 0
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": str(getattr(e, "message", e)), "code": getattr(e, "code", "INTERNAL")}) + "\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
