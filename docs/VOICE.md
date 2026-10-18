# Voice

## Speech to text

The dialog picks a provider automatically (`voice.stt = auto`):

1. **Browser speech** (Web Speech API) in Chrome, Edge and Safari. It needs no setup, shows a live transcript,
   and the browser sends the audio to its vendor's speech service. It is unavailable inside Electron (Electron
   has no key for that service), so the Electron window needs one of the server providers below; or use the
   Chrome/Edge app window (`anywhere config set ui.host app`).
2. **Server speech**: the dialog records 16 kHz WAV, stops on silence, and posts it to the daemon, which uses
   the first available of:

   | Provider | How to enable |
   |---|---|
   | Custom OpenAI-compatible endpoint | `anywhere config set voice.sttBaseUrl https://host/v1`, plus `voice.sttApiKey` (if the server needs a key) and `voice.sttModel`. Or set `ANYWHERE_STT_BASE_URL`, plus `ANYWHERE_STT_API_KEY` and `ANYWHERE_STT_MODEL` as needed; a local server such as faster-whisper needs no key. `ANYWHERE_STT_API_KEY` alone uses Groq or OpenAI (by the key's form) with `ANYWHERE_STT_MODEL` if set. |
   | Groq (fast, cheap) | `export GROQ_API_KEY=…` (model `whisper-large-v3-turbo`) |
   | OpenAI | `export OPENAI_API_KEY=…` (model `gpt-4o-mini-transcribe`) |
   | whisper.cpp (fully local) | Install `whisper-cli` (e.g. `brew install whisper-cpp`) and put a `ggml-*.bin` model in `~/.claude-anywhere/models/`, or set `voice.whisperCppPath` and `voice.whisperModel`. |

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
| "yes", "allow", "approve" (with an approval card) | Allow once |
| "always" | Allow for the rest of the session |
| "no", "deny" | Deny |
| anything else, with a question card | Answers the question |

## Spoken replies

With `voice.speakResponses` on, Claude's final answer (markdown stripped, at most about 600 characters) and
milestone notifications are read aloud. Speech uses the browser's `speechSynthesis` (pick a voice and rate
in settings) or the OS: `say` on macOS, SAPI on Windows and WSL, `spd-say`/`espeak-ng` on Linux.
Speaking or typing stops playback immediately (barge-in).

## Terminal dialog

`anywhere tui` → `/voice` records with `sox`, `arecord` or `ffmpeg` until you press Enter, and needs a server
STT provider.
