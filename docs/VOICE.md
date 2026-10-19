# Voice

## Speech to text

The dialog picks a provider automatically (`voice.stt = auto`):

1. **Browser speech** (Web Speech API) in Chrome, Edge and Safari. It needs no setup, shows a live transcript,
   and the browser sends the audio to its vendor's speech service. It is unavailable inside Electron (Electron
   has no key for that service), so the Electron window needs one of the server providers below; or use the
   Chrome/Edge app window (`anywhere config set ui.host app`).
2. **Server speech**: the dialog records 16 kHz WAV, stops on silence, and posts it to the daemon, which uses
   the first of these that is set (settings come before the environment):

   | # | Source | Provider |
   |---|---|---|
   | 1 | Settings `voice.sttBaseUrl` (`anywhere config set voice.sttBaseUrl https://host/v1`) | That OpenAI-compatible endpoint, with `voice.sttApiKey` (or `ANYWHERE_STT_API_KEY`) if the server needs a key, and `voice.sttModel`; a local server such as faster-whisper needs no key. |
   | 2 | Settings `voice.sttApiKey` (Settings > Voice) | Groq or OpenAI, chosen by the key's form. |
   | 3 | `ANYWHERE_STT_BASE_URL` | That endpoint, with `ANYWHERE_STT_MODEL`. It is sent only `ANYWHERE_STT_API_KEY`, never `GROQ_API_KEY` or `OPENAI_API_KEY`. |
   | 4 | `ANYWHERE_STT_API_KEY` | Groq or OpenAI by the key's form, with `ANYWHERE_STT_MODEL` if set. |
   | 5 | `GROQ_API_KEY` | Groq (fast, cheap; model `whisper-large-v3-turbo`). |
   | 6 | `OPENAI_API_KEY` | OpenAI (model `gpt-4o-mini-transcribe`). |
   | 7 | whisper.cpp (fully local) | Install `whisper-cli` (e.g. `brew install whisper-cpp`) and put a `ggml-*.bin` model in `~/.claude-anywhere/models/`, or set `voice.whisperCppPath` and `voice.whisperModel`. |

   A key entered in Settings is stored in `~/.claude-anywhere/config.json` (mode 0600). Claude reading that
   file is a high-risk action that always shows an approval card.

If browser speech fails (offline, permission denied, or a browser without the API), the dialog switches to
server speech when a provider is available. `voice.stt = server` forces server speech.

Environment variables must be set in the environment the **daemon** starts in. Restart it with
`anywhere restart` after changing them (where `anywhere` is not on your PATH, run
`node <install dir>/bin/anywhere.js restart`; `/anywhere doctor` prints the exact command, and
`anywhere install` links `~/.local/bin/anywhere` on macOS, Linux and WSL).

## Talking to the dialog

- **Click the mic** to start, and click again to stop. With auto-send on, the transcript is sent when you finish.
- **Push-to-talk**: hold **Space** while the input isn't focused, or press and hold the mic button.
- **Ctrl/Cmd+Shift+M** toggles the mic.
- **Hands-free** (settings): always listening, and acts only on speech after the wake word (default
  "hey claude"). With server speech, every detected utterance is transcribed, which costs money with
  cloud providers.

Voice intents:

| You say | Effect |
|---|---|
| "stop", "cancel" | Interrupt the current task |
| "yes", "allow", "approve" (with an approval card) | Allow once. A critical card needs a click on "Allow once"; voice can only deny it |
| "always" | Allow for the rest of the session: adds the rule the card shows. Refused when the card has none (it then says "This action always asks") |
| "no", "deny" | Deny |
| anything else, with a question card | Answers the question |

## The spoken voice (free, offline, sounds like a person)

Claude Anywhere can speak with **Piper**, a free and open-source neural text-to-speech engine. The release
binaries come from [github.com/rhasspy/piper](https://github.com/rhasspy/piper) (MIT); on macOS, and where those
binaries do not run, it installs the `piper-tts` package from
[OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) (GPL-3.0-or-later) into a private virtual
environment. Piper is downloaded only when you ask for it and is not part of Claude Anywhere's own code. Its voices sound like a person
reading, not a robot. It runs entirely on your computer: nothing is sent anywhere, there is no
account or API key, and it costs nothing, ever.

### Install it once

```sh
anywhere voice install                          # Piper + the default voice (Lessac, US English; about 80-100 MB)
anywhere voice install --voice en_GB-alba-medium # another voice
```

or press **Install** in Settings > Voice (a progress bar shows the download). Everything goes into
`~/.claude-anywhere/voice/` and is removed with the rest of that folder:

- **The engine**: the official Piper release for your OS and CPU (Linux x86_64, ARM64 and ARMv7;
  Windows x64). On macOS, and anywhere that binary does not run, `pip install piper-tts` goes into
  a private Python environment (`~/.claude-anywhere/voice/venv`); your own Python packages are never
  touched. This needs Python 3.9 or newer (`brew install python`, python.org, or
  `sudo apt install python3 python3-venv`). Set `ANYWHERE_PIPER_PATH` to use a Piper you already
  have; a `piper` on your PATH is picked up too.
- **The voice**: from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) on Hugging
  Face (a `.onnx` model and its `.onnx.json` config). When Hugging Face is blocked, the voices that
  also exist in Piper's GitHub release (Lessac, Ryan, Siwis) come from there instead.

Downloads go through `HTTPS_PROXY` (honouring `NO_PROXY`) and resume where they stopped if the
connection drops: run the same command again. After the download the voice speaks a test sentence,
so a finished install is a working one. A short sentence takes about half a second to render on a
laptop CPU, and phrases said before (the last 60) replay instantly from a cache.

### Choose a voice

```sh
anywhere voice list              # curated natural-sounding voices (✓ installed, * in use)
anywhere voice use en_US-ryan-high
anywhere voice test "Hello, I'm your new voice."
anywhere voice status            # engine, voice, installed voices, OS voice, audio player
anywhere voice remove en_US-amy-medium
```

The list includes US English (Lessac, Amy, HFC female and male, Kristin, Ryan, Joe, LibriTTS-R),
British English (Alba, Jenny, Cori, Northern English male, Alan), German, French, Spanish, Italian,
Brazilian Portuguese, Russian and Mandarin. Any other id from rhasspy/piper-voices installs too
(`anywhere voice install --voice <id>`). "high" voices sound a little richer and are about twice
the size of "medium" ones.

### Which voice speaks

`voice.ttsEngine` (Settings > Voice > Engine, or `anywhere config set voice.ttsEngine …`):

| Value | Voice |
|---|---|
| `auto` (default) | Piper when it is installed; otherwise the dialog's browser voice, or the OS voice when the dialog is hidden |
| `piper` | Piper only; until it is installed, speaking reports how to install it |
| `os` | The OS voice: `say` on macOS, SAPI on Windows and WSL, `spd-say`/`espeak-ng` on Linux (also while the dialog is visible) |
| `browser` | The dialog's browser voice only; nothing is said while the dialog is hidden |

`voice.piperVoice` is the Piper voice (`anywhere voice use` sets it) and `voice.ttsRate` its speed.

### What is announced

The daemon decides what to say and when, in one place, so nothing is said twice:

| When | What you hear |
|---|---|
| Claude finished a task | a short opener ("All done.", "Finished.", "Done!") and the first sentence or two of the answer |
| Claude needs your permission | "I need your permission to run gcloud run deploy for shop-api." (the program and its target, never a long command; secrets are never read) |
| Claude asks you something | "Quick question: which region? Options are us-central1 or europe-west1." |
| Something failed | "I ran into a problem: …" |
| Claude sends a progress note it wants said aloud (`notify_user` with `speak`) | the note, without a chime |
| Claude moves the work to another repository (`switch_project`) | "Switching to shop-api to continue." (the "done" comes when the work there finishes) |

Quick answers that took under about 4 seconds and used no tools are not announced (you are looking
at them anyway); permission requests and questions always are. A task you stopped is not announced.
Each announcement starts with a short chime (a softer one for questions, a lower one for problems);
spoken notes and hand-offs have none.

When the dialog is open and visible, it plays the announcement (with the Piper voice when it is
installed). When the dialog is hidden or minimized, the daemon plays it through your speakers
(`afplay` on macOS, Windows' SoundPlayer on Windows and WSL, `pw-play`/`paplay`/`aplay`/`ffplay` on
Linux), and permission requests and questions also show an OS notification. Speaking or typing in
the dialog silences it at once (barge-in), and announcements that were still waiting are dropped.

In the dialog, only the most recently focused window speaks (with several open). It plays the chime,
then the Piper recording the daemon rendered, or, without Piper, the most natural voice the browser
has ("Most natural available" in Settings > Voice picks it; you can choose another). Permission
requests and questions jump the queue; announcements older than two minutes are dropped; answering a
card drops its announcement. The dialog never speaks answers, cards or notes by itself, so nothing is
said twice. The speaker button on an answer reads it aloud with the same voice (Piper when installed).

### Turning it off

| Setting | Effect |
|---|---|
| `voice.speakResponses = false` | No announcements at all (Settings > Voice > Speak responses) |
| `voice.announce.done` / `.permission` / `.question` / `.error = false` | Silence one kind |
| `voice.chime = false` | No chime before announcements |
| `voice.tts = off` | No speech of any kind |

For example: `anywhere config set voice.announce.done false`.

## Terminal dialog

`anywhere tui` → `/voice` records with `sox`, `arecord` or `ffmpeg` until you press Enter, and needs a server
STT provider.
