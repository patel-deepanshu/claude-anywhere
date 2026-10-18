# Answering calls in your own voice

> *"If anyone calls me on this laptop, answer and assist."*

Claude Anywhere can pick up your Zoho Cliq, Google Meet, Microsoft Teams, Slack and Zoom calls while you
are away, talk to the caller in **your own cloned voice**, help with a few safe requests (for example,
assign the caller an unassigned Jira ticket and send them the link on Cliq), and leave **notes on your
Desktop**. It always tells the caller it is an AI assistant and that the call is transcribed.

Everything is free and runs on your computer: the voice clone, speech recognition, the virtual audio
devices and the notes. The only services involved are the call app itself, your Jira (optional), and your
own Claude Code login, whose usage counts toward your plan (the call assistant uses `haiku`).

| Step | How | Once? |
|---|---|---|
| 1. Virtual audio devices | [per operating system](#1-set-up-the-audio-free), then `anywhere calls test-audio` | once |
| 2. Your voice | `/anywhere:clone-voice` (about 3 minutes of reading aloud) | once (optional) |
| 3. Turn on answering | say or type *"answer my calls until 6"*, then click **Allow once** | each time |
| 4. Read the notes | `<Desktop>/Claude Call Notes/` | after each call |

`anywhere calls doctor` checks all of it and prints the exact fix for anything missing.

**Before you use it**, check the rules where you and your callers live, and your employer's policy:
some places require every party to agree to a recording or transcription, and some regulate synthetic
voices. The assistant discloses itself on every call (see [The disclosure](#5-the-disclosure-and-why)).

---

## 1. Set up the audio (free)

The assistant needs two audio paths during an AI-answered call: its voice must reach the call app as a
**microphone**, and the caller's voice must reach the assistant **without** the assistant's own voice
mixed in. Claude Anywhere switches the call app to a virtual microphone only while it handles a call, and
always switches it back (also after a crash: the routing is saved in `~/.claude-anywhere/run/calls-audio.json`
and restored when the daemon starts again).

### Linux (PulseAudio or PipeWire)

Nothing to install beyond the PulseAudio tools, which also work with PipeWire (`pipewire-pulse`):

```bash
sudo apt install pulseaudio-utils      # Debian/Ubuntu: pactl, pacat, parec (Fedora: sudo dnf install pulseaudio-utils)
anywhere calls audio setup             # adds the virtual devices (removed again with: anywhere calls audio teardown)
anywhere calls test-audio              # the browser self-test, in your call browser
```

`audio setup` loads a null sink `anywhere_tts`, a remapped source **Claude-Anywhere-Mic** (Chromium does
not list monitor sources, so the remap is required), a capture sink `anywhere_call` and a loopback from it to
your speakers, so you still hear the caller. During an AI-answered call the default microphone becomes
Claude-Anywhere-Mic and the browser's audio streams are moved to the capture sink; when the call ends or you
take over, everything goes back.

### Windows (and WSL)

1. Install **VB-CABLE** (free donationware) from <https://vb-audio.com/Cable/>: unzip the driver pack, run
   `VBCABLE_Setup_x64.exe` **as administrator**, and reboot. Claude Anywhere never installs drivers itself.
2. Keep your speakers or headphones as the default **output** (not "CABLE Input").
3. `anywhere calls test-audio`.

The assistant plays its voice into *CABLE Input*; during the call, *CABLE Output* becomes the default
recording device (for the console, multimedia and communications roles), and the caller is captured with
WASAPI loopback of your speakers. Under **WSL** the voice runtime runs on the Windows side (Windows Python,
models under `%USERPROFILE%\.claude-anywhere\voice`), because the call runs in your Windows browser; set
`ANYWHERE_CLONE_WSL=linux` to keep it inside WSL instead.

### macOS

```bash
brew install blackhole-2ch             # free (GPL-3.0); asks for your admin password, or use the installer from existential.audio
anywhere calls test-audio
```

The assistant speaks into **BlackHole 2ch**, which becomes the default input during the call. The caller is
captured with **ScreenCaptureKit** (macOS 13+), which uses the Screen Recording permission that screenshots
already need. Without it: `brew install blackhole-16ch`, create a Multi-Output Device (your speakers +
BlackHole 16ch) in Audio MIDI Setup and pick it as the browser's or the system output. Reading BlackHole as an
input makes macOS ask for the **Microphone** permission of the app that runs Claude Code.

### No virtual devices: speaker mode

With `anywhere config set calls.audio.mode speakers` (or automatically, when no virtual device is found) the
assistant talks through your speakers and listens through your microphone. It works, at lower quality: the
caller hears the room, headphones break it, and the assistant cannot be interrupted (it stops listening
while it speaks). Doctor marks this mode "works, lower quality".

### The self-test

`anywhere calls test-audio` (or **Run the audio test** in the calls panel) opens a page in your browser with a
single-use link. The page records its microphone while the assistant speaks into the virtual microphone,
then plays a test phrase while the assistant records the caller side; both are transcribed locally and
compared. Allow the microphone for `127.0.0.1` when the browser asks. If the call app has a specific
microphone selected, choose **Default** in its audio settings so it follows the virtual microphone.

---

## 2. Clone your voice: `/anywhere:clone-voice`

```text
/anywhere:clone-voice            (plugin)        /anywhere clone-voice   (personal skill)
anywhere clone-voice             (terminal)      Settings › Voice › Clone my voice   (dialog)
```

The enrollment opens in the Claude Anywhere dialog (or, when no dialog answers, in a browser tab):

1. **About**: what is recorded, that it stays on this computer, and how to delete it. You confirm that you
   are the person whose voice will be recorded.
2. **Install** (first time): the free voice runtime, about 425 MB (a private Python environment under
   `~/.claude-anywhere/voice/clone-venv` with sherpa-onnx, and the models from GitHub releases, each checked
   by sha256). Also `anywhere clone-voice install`. Your own Python is never touched; with no Python 3.9–3.14
   installed, Claude Anywhere downloads `uv` and a private Python into `~/.claude-anywhere/voice`.
3. **Microphone**: pick your microphone; a few seconds of room tone measure the noise. Virtual and loopback
   devices (BlackHole, VB-CABLE, "Monitor of", "Stereo Mix" and the like) are refused, and so is
   narrowband Bluetooth headset audio.
4. **Consent**: read one sentence with your name and a fresh 4-digit code that is shown only while you
   record: *"I, Deepanshu Patel, agree that Claude Anywhere may create a copy of my voice on this computer. My
   code is 4 7 2 9."* It is transcribed locally and must match.
5. **Script**: 14 short lines (about 70 seconds of speech). Each take is checked at once (level, noise,
   clipping, length, and a local transcript that must match the line) and can be re-recorded. At least 45 seconds of speech are needed in all; the consent
   sentence counts toward it.
6. **Build**: the lines must be the same speaker as the consent take, each of them and together (speaker
   embeddings; a session with two voices is refused); the best takes make a 10–15 second reference clip.
7. **Test**: a sentence plays in your cloned voice with a match score. **Keep**, **Redo**, or try the
   **quality voice** (ZipVoice: closer to your voice but slower, and its model is trained on data with a
   non-commercial license).

Only recordings made live in this view are accepted, there is no way to clone a voice from a file, and the
voice can only be the enrolled speaker's. Read in the language of your calls, in a quiet room.

| Command | What it does |
|---|---|
| `anywhere clone-voice` | opens the enrollment (`--standalone`: in a browser tab) |
| `anywhere clone-voice install [--engine zipvoice]` | installs the runtime and models |
| `anywhere clone-voice status` | runtime, voice profile, speed |
| `anywhere clone-voice test` | plays the test sentence in your cloned voice (sentences of your own: Test in the dialog's voice view) |
| `anywhere clone-voice bench` | measures the voice engines on this computer |
| `anywhere clone-voice delete` | deletes your voice (asks you to type `delete`; `--yes` skips that) |

**Stored** under `~/.claude-anywhere/voice/clone/profiles/default/` (folder 0700, files 0600): the reference
clip, its text, the consent recording and a manifest; plus pre-rendered phrases (the greeting and short
fillers such as "Okay, one moment."). Nothing is uploaded; notes never contain audio.
**Deleting** (`anywhere clone-voice delete`, or **Delete my voice** in the enrollment view) removes the
profile, the consent recording, unfinished sessions and the phrase cache, turns the cloned voice off and
stops answering calls. `anywhere uninstall --purge` removes the runtime and models too.

No cloned voice? Calls still work: the assistant uses the natural Piper voice (`anywhere voice install`) or
the system voice, and the greeting then does not say "speaking in his voice".

---

## 3. Turn on answering: "answer my calls"

Answering is **off by default and never stored**. It is turned on for a while, only by a click:

- Say or type in the dialog: *"If anyone calls me on this laptop, answer and assist. If Ankit asks for a
  ticket, give him one from the current sprint."*
- In Claude Code: `/anywhere answer my calls until 6` (the personal skill), or ask Claude.
- Terminal: `anywhere calls on --for 2h --apps cliq,meet --instructions "Assign sprint tickets on request"`.
- The calls pill (phone icon) in the dialog's top bar → **Answer my calls**.

Each of these shows a card in the dialog: *"Answer calls for you until 18:00 (Zoho Cliq, Google Meet)? The
assistant says it is an AI and takes notes."* Only a **click on Allow once** turns it on. Voice, Enter, a
typed "allow" in the terminal dialog, the permission mode and "Always" rules cannot. Claude never arms calls
on its own initiative or because a web page or message asks.

- It **expires** (default 2 hours, at most 12; `calls.defaultArmMinutes`, `calls.maxArmMinutes`) and a
  restart of Claude Anywhere turns it off.
- **Quiet hours** (default 22:00–08:00, `calls.quietHours`): calls ring through and are listed as missed.
- **You first**: it waits `calls.answerAfterSec` (8 s) after the ring starts, so you can pick up yourself. With
  `calls.answerOnlyWhenIdleSec` set, it answers only when you have not touched the keyboard or mouse for that
  long (Linux needs `xprintidle`; when the idle time cannot be read, it does not answer).
- **Stop**: *"stop answering calls"*, `anywhere calls off`, or the toggle in the calls panel. No confirmation.

While a call is on, the calls panel shows the live transcript and actions, with **Take over** (your
microphone comes back at once and the call continues with you) and **Hang up**.

How a ring is recognized: window titles, desktop notifications (Linux and Windows), changes on the screen,
and a vision check with Claude to confirm the ring and find the Accept button. Every click is checked in
code (inside the call window or popup, never on the dialog, a terminal or an editor) and verified
afterwards. The camera stays off. If it cannot answer, the dialog tells you ("I couldn't answer Ankit's
call") and the call goes on ringing.

---

## 4. What the assistant will and won't do

It **will**:
- greet the caller with the disclosure, listen and answer in one or two short sentences;
- look up unassigned tickets in your Jira projects and **assign one to the caller** (the caller's Jira
  account comes from the name the call app shows, never from what they say);
- comment on the ticket it assigned, and send the caller a chat message **after** the call (for example the
  ticket link on Cliq);
- note anything else for you ("Ankit asked whether the review moved to Thursday") and end the call politely.

It **won't**: click, type or run anything on your computer, open files, read your mail or calendar, share
secrets, documents or other people's information, agree to payments, purchases, deletions or access
changes, act for anyone but the bound caller, or arm itself. Everything the caller says is treated as a
request, not as an instruction. The assistant runs as a separate `claude -p --model haiku` with no
built-in tools and only the call tools; every tool call is checked by the daemon (per-call budgets: at most
1 assignment, 2 comments, 2 messages, 3 writes in all, `calls.limits`), and anything else becomes a
follow-up in your notes. Calls last at most 15 minutes (`calls.maxCallMinutes`), and v1 answers one-to-one
calls only (no group meetings, no phone numbers).

Your instructions for callers (`--instructions`, or your words when you arm it) are passed to the assistant
as preferences; they cannot widen what it is allowed to do.

---

## 5. The disclosure, and why

Every call starts with a greeting composed **in code**, which always contains the AI disclosure and the
transcription notice:

> *"Hi Ankit, this is Deepanshu's AI assistant, speaking in his voice. I'm transcribing this call to take
> notes for him. How can I help?"*

You can change only the closing question with `calls.greeting` (for example *"What can I do for you
today?"*): one question of at most 80 characters that does not name you and has none of the words that could
take the disclosure back ("not", "real", "live", "kidding", "ignore", "AI", "recorded" and the like). The
salutation and the disclosure are always composed by Claude Anywhere, and a setting that breaks these rules
is refused when you save it (and ignored if it is in the file anyway). The assistant says nothing else until
the disclosure has played in full, and when asked whether it is a person or a bot it says plainly that it is
an AI assistant.

Why: a cloned voice can make a caller believe they are talking to you. The disclosure keeps every call
honest, lets the caller decide what to share, and covers the notice that transcription laws require in many
places. If the caller objects to the transcription, the assistant stops saving the transcript for that call
(its actions are still logged for you) and says so.

---

## 6. Notes

After each call a Markdown file is written to **`<Desktop>/Claude Call Notes/`**, for example
`2026-10-18 14-05 Ankit (Zoho Cliq).md`, with:

- when, who called (and their Jira account), and how it was answered;
- a short summary and **Follow-ups for you**;
- **Actions taken**, from the daemon's own action log (not from what the assistant claims);
- the transcript (unless the caller objected or `calls.saveTranscript` is `false`).

The Desktop is found the way the OS defines it: `GetFolderPath('Desktop')` on Windows (so OneDrive Known
Folder Move is followed), the WSL path of the Windows Desktop under WSL, `XDG_DESKTOP_DIR` on Linux (else
`~/Desktop`, else `~/Claude Call Notes`), and `~/Desktop` on macOS. If macOS does not let Claude Anywhere write
to the Desktop (Files and Folders privacy), the notes go to `~/.claude-anywhere/calls/notes/` and the dialog
says so; allow Desktop access for the app that runs Claude Code under System Settings › Privacy & Security ›
Files and Folders.

- Calls that were not answered (quiet hours, an app you did not choose, you were at the computer, a failed
  answer) are listed in `Claude Call Notes/Missed calls.md`.
- `anywhere calls notes` lists them; `--open` opens the folder. The dialog's calls panel shows the recent calls
  with their notes.
- **Synced Desktops** (OneDrive, iCloud Desktop & Documents) upload the notes; set
  `anywhere config set calls.notesDir ~/CallNotes` to keep them local. The voice profile is never written there.
- Call data for the panel (`~/.claude-anywhere/calls/<id>/`: transcript and action log, 0600) is kept for
  30 days (`calls.keepCallDataDays`).

At the end of a call the dialog shows a summary and, with spoken announcements on, says "Call with Ankit
finished; notes are on your Desktop."

---

## 7. Zoho Cliq

**Ringing.** Cliq's ringing screen is not documented, so calibrate it once with a test call:

```bash
anywhere calls learn --app cliq        # then have a colleague call you, and let it ring
```

When the dialog says the ring was seen, you may answer and hang up a few seconds later: that also teaches it
how a call in progress looks.

This records how the ring looks (window title, notification, popup position and the Accept button) in
`~/.claude-anywhere/calls/signatures.json`; later rings are recognized faster and more reliably. Answering
must be off while it learns. Also:
- open Cliq **in its own window** ("Install Cliq as an app" or "Open in new window"): a background tab
  cannot change the window title, so only the notification would show the ring;
- keep Cliq's **Show Incoming Calls** (web) and **Enable Notifications for Cliq Calls** (desktop) turned on.

**Messages after the call.** By default, no setup: after the call the assistant focuses your Cliq window,
finds the chat with the caller, pastes the message and presses Enter, then checks on screen that it was sent.
A message whose delivery is uncertain is listed as "check whether Ankit got this message", never sent twice.

**Optional: the Zoho Cliq API** (messages go out even when the Cliq window is closed):

```bash
anywhere calls cliq setup              # asks for the data center, Client ID, Client Secret (hidden) and grant code
```

1. Open `https://api-console.zoho.<dc>` (`<dc>` is `com`, `eu`, `in`, `com.au`, `jp` or `ca`, as in your Cliq
   address) → **Add Client** → **Self Client** → **Create**.
2. **Generate Code** with the scope `ZohoCliq.Webhooks.CREATE`, 10 minutes, any description, and copy the code.
3. The Client ID and Client Secret are on the **Client Secret** tab.

Setup exchanges the code for a refresh token and saves it (with the secret, in `~/.claude-anywhere/config.json`,
0600; never shown, and never accepted as a command-line argument: type it, or pipe it with `--secret-stdin`).
`anywhere calls cliq test` checks the token, and `anywhere calls cliq gui` goes back to the window method and
removes the saved tokens. The caller's email address comes from their Jira account; without it, or if the API
refuses, the window method is used. If Zoho answers 401/403, the error names the scope to add.

---

## 8. Settings

| Key | Default | Meaning |
|---|---|---|
| `calls.ownerName`, `calls.ownerPronoun` | (Jira or OS name), `their` | how the greeting names you: `his` · `her` · `their` |
| `calls.apps` | all five | `zoho-cliq` · `google-meet` · `teams` · `slack` · `zoom` |
| `calls.defaultArmMinutes`, `calls.maxArmMinutes` | `120`, `720` | how long answering lasts |
| `calls.answerAfterSec`, `calls.answerOnlyWhenIdleSec` | `8`, `0` | give yourself time to pick up; answer only when idle |
| `calls.quietHours` | `{enabled: true, start: '22:00', end: '08:00'}` | never answer in these hours |
| `calls.greeting` | (empty) | the closing question after the disclosure (default "How can I help?"; at most 80 characters, one question) |
| `calls.maxCallMinutes` | `15` | the assistant wraps up a minute before |
| `calls.model` | `haiku` | the call assistant's model |
| `calls.stt.model` | `moonshine` | `moonshine` · `whisper-tiny` · `whisper` · `parakeet` (more accurate, 482 MB) |
| `calls.audio.mode` | `auto` | `virtual` · `speakers` |
| `calls.audio.virtualMic`, `calls.audio.capture`, `calls.audio.switchDefaultInput` | (auto), (auto), `true` | device overrides |
| `calls.detect.titles` / `.notifications` / `.screenDiff` / `.vision` | `true` | ring detection signals |
| `calls.limits` | `{assign: 1, comment: 2, chat: 2, writes: 3}` | per-call write budgets |
| `calls.jira.projects` | `[]` | projects callers may get tickets from (`[]`: the projects of your open issues) |
| `calls.notesDir`, `calls.saveTranscript`, `calls.keepCallDataDays` | (Desktop), `true`, `30` | notes |
| `calls.cliq.mode`, `calls.cliq.dc` | `gui`, `com` | `api` after `anywhere calls cliq setup` |
| `voice.clone.enabled`, `voice.clone.engine` | `false`, `pocket` | set by the enrollment; `zipvoice` is the quality voice |
| `voice.clone.threads`, `voice.clone.steps`, `voice.clone.provider` | `2`, `0`, `cpu` | engine tuning (`cuda`, `coreml`: measure with `anywhere clone-voice bench`) |
| `voice.clone.python` | (auto) | the Python used to create the private environment |

Environment variables: `ANYWHERE_CLONE_ASSET_BASE` (a mirror of the sherpa-onnx GitHub release paths for the
models), `ANYWHERE_CLONE_UV_BASE` (a mirror of the uv releases), `ANYWHERE_PYTHON` (the Python to use),
`ANYWHERE_CLONE_WSL=linux` (keep the voice runtime inside WSL), `ANYWHERE_CLONE_FAKE=1` (tests: a fake engine
without models).

**Offline or blocked downloads**: put a model archive by hand at
`~/.claude-anywhere/voice/clone-models/downloads/<file name>` (the name in the error message) and run
`anywhere clone-voice install` again: it is checked by sha256 and used. A sha256 mismatch means the upstream
file changed: update Claude Anywhere.

---

## 9. Commands

```text
anywhere calls on [--for 2h | --until 18:00] [--apps cliq,meet] [--instructions TEXT]   asks for the click
anywhere calls off | status | notes [--open]
anywhere calls doctor [--deep]          everything calls need, with fixes (--deep records 1 s of caller audio)
anywhere calls test-audio               the browser audio self-test
anywhere calls learn [--app cliq] [--seconds 60]
anywhere calls audio setup | teardown | check
anywhere calls cliq setup | test | gui | status
anywhere clone-voice [start | install | status | test | bench | delete] [--engine pocket|zipvoice]
```

All of them take `--json`. `calls on` exits 0 when answering is on, 5 when you did not allow it, 2 when nobody
clicked in time, and 1 when it cannot be turned on (the reason and fix are printed, e.g. the voice runtime is
not installed).

## Troubleshooting

- **"Call audio is not ready"**: `anywhere calls doctor` names the missing piece (sound server, VB-CABLE,
  BlackHole). Run `anywhere calls test-audio` after fixing it.
- **The caller hears nothing**: the call app has a fixed microphone; choose **Default** in its audio settings.
- **It does not notice the ring**: keep the call app in its own window, run `anywhere calls learn`, and on
  Linux install `dbus` (`busctl` or `dbus-monitor` watch the notifications).
- **Speech is slow**: `anywhere clone-voice bench`; computers below real time lean on pre-rendered phrases, and
  the standard voice is always available.
- **The consent sentence is not recognized**: read it exactly, including the four digits, in a quiet room.
  The code is replaced after a few failed attempts or after 10 minutes; read the one on screen.
- Design and measurements: [CALLS-DESIGN.md](CALLS-DESIGN.md). Security model: [SECURITY.md](SECURITY.md).
