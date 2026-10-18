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

## Spoken replies

With `voice.speakResponses` on, Claude's final answer (markdown stripped, at most about 600 characters) and
milestone notifications are read aloud. Speech uses the browser's `speechSynthesis` (pick a voice and rate
in settings) or the OS: `say` on macOS, SAPI on Windows and WSL, `spd-say`/`espeak-ng` on Linux.
Speaking or typing stops playback immediately (barge-in).

## Terminal dialog

`anywhere tui` → `/voice` records with `sox`, `arecord` or `ffmpeg` until you press Enter, and needs a server
STT provider.
