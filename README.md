# opencode-talk

**Voice + remote control for [OpenCode](https://opencode.ai): talk to the agent
and let it talk back, and drive the same sessions from Telegram or any Nostr
client — including a Telegram group where every session gets its own topic.**

**Voice**

- **Speech-to-text (STT)** — press `<leader>v` (or run `/mic`), speak, and the
  transcript becomes a prompt. Local `faster-whisper` by default (offline,
  private, no API key), or any OpenAI-compatible `/audio/transcriptions`
  endpoint; PipeWire, PulseAudio, ALSA, `sox` and `ffmpeg` (AVFoundation on
  macOS, DirectShow on Windows) are auto-detected.
- **Text-to-speech (TTS)** — the main agent's replies are **spoken aloud** with
  neural voices (edge-tts), automatic **pt / en / fr** language detection and a
  robotic `spd-say` fallback. Runs in the server plugin, so every client gets
  it; reasoning is opt-in.
- **Editable send + polish** — by default `/mic send` opens an editable dialog
  so you can fix the transcript before it is sent, and the optional `polish`
  step runs it through the model you are already using.
- **Voice in Telegram** — incoming voice notes and audio files are transcribed
  and attached to the prompt, so OpenCode receives the audio itself even when
  transcription fails; `/talk` sends agent replies back as spoken audio
  messages.
- Commands: `/mic` (`start|send|abort|off|status|help`), `/mic-setup`
  (settings menu), `/sound` (`on|off|pause|status|help`), `/talk` — `/talk
  help` lists every command this plugin adds.

**Remote control**

- **Telegram** — in-process bot: project/session menus (`/menu`, `/projects`,
  `/project`, `/sessions`, `/new`, `/use`), model + reasoning switching
  (`/models`, `/model <number|provider/model> [effort]`), `/status`, `/abort`,
  `/nostr`, plain-text prompts, in-place progress edits, agent photos and
  voice replies. Editing a submitted message stops the current run and
  re-prompts with the new text. `/telegram <bot-token> <group-id>` registers
  the **"Opencode Talk" group**, where every session gets its own forum topic
  seeded with the session's project + model/reasoning; creating a topic there
  creates a new session, and session renames rename the topic. `/projects`
  lists every OpenCode project (TUI/desktop picker) plus `TELEGRAM_PROJECTS`,
  `/telegram <chat-id>` links extra private chats, and
  `/telegram stop|start|talk|shut` controls the bot.
- **XMPP** — same features as Telegram over XMPP: `/menu`, `/projects`,
  `/project`, `/sessions`, `/new`, `/use`, `/models`, `/model <number|provider/model> [effort]`,
  `/status`, `/abort`, `/nostr`, plain-text prompts, progress + voice replies.
  `/xmpp <jid> <password> [muc-room]` connects the bot and registers the MUC
  room (one thread per session, seeded with project + model/reasoning);
  `/xmpp <token>` saves just the password when the JID comes from `XMPP_JID`.
  `/xmpp <contact-jid>` links extra direct chats, `/xmpp room <muc-room>`
  registers the room, and `/xmpp stop|start|talk|shut` controls the bot.
  Setup: [docs/XMPP_SETUP.md](docs/XMPP_SETUP.md).
- **Nostr** — every session owns its own keypair (npub). Pair with
  `/nostr <your-npub>`: the session DMs a welcome with the model + reasoning
  already selected. Encrypted NIP-04 DMs then drive the session with the same
  commands, scope projects, switch model/reasoning, abort, and receive agent
  images (Blossom). `/nostr off|on` halts/resumes relay traffic.
- **Any other `/command`** — forwarded to OpenCode as-is, so custom commands
  and skills work remotely too.
- **Local prompts are mirrored** — when you type a prompt in OpenCode
  (TUI/desktop/web, including `/mic` transcripts), it also appears in every
  Telegram/XMPP chat and Nostr DM bound to that session, so remote readers see
  both sides of the conversation. Remote-originated prompts and slash commands
  are never echoed.
- **Agent tool** — `telegram_send_image` lets the agent push screenshots,
  charts and renders to your Telegram/Nostr chat.
- **Session API + remote plugin** — REST + SSE for any client, typed RPC and
  compact progress events, single-flight loops and a shared poll lock that
  keeps exactly one Telegram poller even with several OpenCode servers. See
  [Remote control](#remote-control-telegram--nostr) below.

> OpenCode's plugin API can't write into the prompt composer, so the transcript
> is delivered with `session.prompt` (after an editable dialog). Toasts and the
> `/mic-setup` settings menu are **terminal-TUI** features; the web/desktop
> clients only run the server commands.

## How it works

```
/mic  ──▶ recorder (temp WAV) ──▶ speech-to-text ──▶ (edit) ──▶ session.prompt
agent reply ──▶ text-to-speech (edge-tts) ──▶ speakers
```

1. `src/recorder.ts` spawns the first available capture tool and writes a mono
   16 kHz WAV to a temp directory.
2. `src/transcribe.ts` runs the configured backend (local `faster-whisper` by
   default, or an OpenAI-compatible HTTP endpoint).
3. `src/tui.ts` / `index.ts` deliver the text to the active session (optionally
   edited in a dialog and optionally cleaned up by the current model first).
4. `src/speech.ts` speaks the main agent's replies with `edge-tts`
   (auto-detecting pt/en/fr) or `spd-say`, with a single, deduplicated queue.

Service/CLI plugins are two halves of one package: `index.ts` (server — the
`/mic` and `/sound` commands, plus TTS playback) and `tui.ts` (the terminal UI —
keybind, toasts, editable send and the settings menu).

## Requirements

- OpenCode v2 (`opencode --version` → `2.x`).
- A microphone and one capture tool: `pw-record` (PipeWire), `parecord`
  (PulseAudio), `arecord` (ALSA), `sox`, or `ffmpeg`.
- For local STT: `faster-whisper` in the bundled `.venv` (set up by
  `npm install`) or any Whisper CLI.
- For cloud STT: an API key for your provider.

## Install

This is **already installed** in `~/.config/opencode/opencode.jsonc`, which is
what makes it appear in OpenCode's plugin/extension list:

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/hdlrocha/opencode-voice"]
}
```

Run `npm install` once in this directory: its `postinstall` hook creates the
bundled `.venv` and installs the Python engines (`edge-tts` for speech,
`faster-whisper` for transcription). Re-run it any time with `npm run setup`
(or `OPENCODE_VOICE_SKIP_SETUP=1 npm install` to skip the Python step, e.g. in
CI).

The plugin is **self-configuring**: at load it looks for
`.venv/bin/python` and `scripts/whisper_transcribe.py` next to itself, and uses
the bundled local engine when they exist. No options are required.

> **Why not `options`?** When a plugin is registered in `opencode.json`, OpenCode
> currently does not forward its `options` object to the TUI half (`context.options`
> arrives empty). Configure it through environment variables instead, or use the
> CLI-only `cli.json` form below if you want `options`.

### Environment overrides

Set these before launching `opencode`:

| Variable                          | Purpose                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `OPENCODE_VOICE_BACKEND`          | `local` or `api`. Overrides auto-detection.                          |
| `OPENCODE_VOICE_LOCAL_COMMAND`    | Shell command for the local backend. Supports `{audio}`.             |
| `OPENCODE_VOICE_BASE_URL`         | OpenAI-compatible base URL (cloud backend).                          |
| `OPENCODE_VOICE_MODEL`            | Cloud transcription model.                                           |
| `OPENCODE_VOICE_API_KEY`          | Cloud bearer token. Also read from `OPENAI_API_KEY`/`GROQ_API_KEY`.  |
| `OPENCODE_VOICE_LANGUAGE`         | ISO-639-1 hint, e.g. `en`.                                           |
| `OPENCODE_VOICE_WHISPER_MODEL`    | faster-whisper model: `base` (default), `tiny.en`, `small`, …        |
| `OPENCODE_VOICE_WHISPER_LANGUAGE` | Language for the local wrapper (default: auto-detect).              |
| `OPENCODE_VOICE_WHISPER_COMPUTE`  | `int8` (default), `int8_float16`, `float16`, `float32`.              |

<details>
<summary>CLI-only install (honours <code>options</code>, but not listed)</summary>

Plugins declared in `cli.json` keep their `options` and stay active even against
a remote server, but they do **not** show in the plugin/extension list:

```json title="~/.config/opencode/cli.json"
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/home/hdlrocha/opencode-voice",
      "options": {
        "backend": "local",
        "localCommand": "/home/hdlrocha/opencode-voice/.venv/bin/python /home/hdlrocha/opencode-voice/scripts/whisper_transcribe.py {audio}",
        "keybind": "<leader>v",
        "slash": "voice"
      }
    }
  ]
}
```

</details>

<details>
<summary>Alternative: discovery via a plugins directory</summary>

OpenCode also discovers plugins under the global config directory and project
`.opencode` directories, so you can symlink this project instead of editing
`opencode.jsonc`:

```sh
mkdir -p ~/.config/opencode/plugins
ln -sfn /home/hdlrocha/opencode-voice ~/.config/opencode/plugins/mic
```

The `tui.ts` and `index.ts` files at the project root are the entry points used
by that layout.

</details>

Restart the terminal app (or run `opencode service restart`) so the plugin is
picked up.

### Changing the keybind

Override the command binding in `cli.json`:

```json title="~/.config/opencode/cli.json"
{
  "keybinds": { "voice.input.toggle": "ctrl+shift+v" }
}
```

## Usage

1. Open a session.
2. Start recording — press `<leader>v` (by default `Ctrl+X` then `v`), or run
   `/mic` (`/mic start` also works).
3. A "Recording…" toast appears. Speak.
4. Stop & transcribe — press the key again, run `/mic` (it toggles), or
   `/mic send`. By default this opens an **editable dialog** with the
   transcript so you can fix it before sending (press Enter to send, Esc to
   discard). Set `OPENCODE_VOICE_SUBMIT=send` to send directly instead.
5. To **cancel** (discard, send nothing), run `/mic abort` (`cancel`, `abort`,
   `parar` also work).
6. Run `/mic help` (or `/sound help`) any time to see the command reference,
   `/mic status` (or `/sound status`) for current state.

Recording also stops automatically after `maxDuration` seconds (default 120).

### Configuration menu

Run `/mic-setup` (or pick **Voice: configuração** from `Ctrl+P`) to:

- switch between **local** transcription (no key needed) and the **cloud API**;
- set the API key, `baseURL` and model — stored at
  `~/.config/opencode/voice.json` (mode `0600`, **outside this repository**, so
  it is never committed);
- choose the Portuguese, English and French TTS voices and toggle language
  auto-detection;
- enable/disable speech, and choose whether the agent's reasoning ("thinking")
  is spoken too;
- review the current settings (the key is shown masked).

Changes apply immediately — the plugin re-reads `voice.json` on every use.

## Text-to-speech (agent messages)

The plugin also reads the **main agent's** messages aloud:

- **Only the main agent** — messages from subagent/child sessions are never spoken.
- **Only assistant prose** — tool calls and shell/command output are not spoken. Code blocks, inline code, URLs and Markdown markup are stripped first so it reads like speech.
- **Reasoning is opt-in** — the agent's grey "thinking" text is skipped unless you enable it with `OPENCODE_VOICE_TTS_REASONING=1` (or the settings menu). Off by default.
- Runs in the **server** plugin, so it works in every client (TUI, desktop, web).
- Utterances are queued and serialized machine-wide, so agent messages and reasoning parts play one after another instead of talking over each other.

The default engine is **edge-tts** — Microsoft's neural voices, which sound
natural and include European Portuguese (`pt-PT-RaquelNeural`) and English
(`en-US-AriaNeural`). It is wired in through the bundled wrapper
`scripts/edge_tts_play.py`; if synthesis or playback ever fails it falls back to
`spd-say`. The wrapper also survives Microsoft's 2026 Read Aloud migration:
when the legacy `speech.platform.bing.com` endpoint answers 403 (as it does in
several regions), it retries on the new `api.msedgeservices.com` host, so the
natural voice keeps working.

**Language auto-detection:** each message is classified as Portuguese, English or
French and the matching voice is used, so replies are read with the right voice.
Inconclusive text (numbers, very short replies) is read with the **English**
voice. Set `OPENCODE_VOICE_TTS_AUTO=0` to disable detection (then everything
uses `OPENCODE_VOICE_TTS_VOICE`).

Because edge-tts uses an online service, it needs internet at speak time. For a
completely offline voice, use Piper (below), or force the robotic fallback with
`OPENCODE_VOICE_TTS_ENGINE=spd-say`.

Configure with environment variables (set them before launching `opencode`, then
`opencode service restart`):

| Variable                       | Default                | Purpose                                                            |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `OPENCODE_VOICE_TTS`           | `1`                    | Set to `0` to disable speech.                                      |
| `OPENCODE_VOICE_TTS_STREAMING` | `0`                    | Stream live text to a compatible stdin command (opt-in).          |
| `OPENCODE_VOICE_TTS_ENGINE`    | auto (`command`)       | `command` (bundled edge-tts), `spd-say`, or your own command.      |
| `OPENCODE_VOICE_TTS_AUTO`      | `1`                    | Auto-detect PT/EN/FR and pick the matching voice (EN when unclear). |
| `OPENCODE_VOICE_TTS_REASONING` | `0`                    | Set to `1` to also speak the agent's reasoning ("thinking") text.  |
| `OPENCODE_VOICE_TTS_VOICE`     | `pt`                   | Portuguese voice: `pt`, `pt-br`, or a full edge voice name.        |
| `OPENCODE_VOICE_TTS_VOICE_EN`  | `en-US-AriaNeural`     | Voice used for English messages.                                   |
| `OPENCODE_VOICE_TTS_VOICE_FR`  | `fr-FR-DeniseNeural`   | Voice used for French messages.                                    |
| `OPENCODE_VOICE_TTS_RATE`      | `0`                    | `-100`..`100` (positive is faster).                                |
| `OPENCODE_VOICE_TTS_MAX`       | `1500`                 | Max characters spoken per message (`0` = no limit).                |
| `OPENCODE_VOICE_TTS_COMMAND`   | bundled edge wrapper   | Command for `engine=command`; the text is written to its stdin.    |
| `OPENCODE_VOICE_EDGE_VOICE`    | –                      | Explicit edge voice, overrides the language-based choice.          |

Voice mapping: `pt` → `pt-PT-RaquelNeural`, `pt-br` → `pt-BR-FranciscaNeural`,
`en` → `en-US-AriaNeural`, `en-gb` → `en-GB-SoniaNeural`,
`fr` → `fr-FR-DeniseNeural`, `es` → `es-ES-ElviraNeural`, and so on. Examples:

```sh
OPENCODE_VOICE_TTS_VOICE=pt-PT-DuarteNeural      # male European Portuguese
OPENCODE_VOICE_TTS_VOICE_EN=en-GB-SoniaNeural    # British English
```

### Streaming speech (opt-in)

If your TTS command accepts incremental UTF-8 text on stdin and plays audio
before stdin closes, enable `ttsStreaming` in `~/.config/opencode/voice.json`:

```json
{
  "tts": true,
  "ttsEngine": "command",
  "ttsCommand": "my-streaming-tts-command",
  "ttsStreaming": true,
  "ttsMaxChars": 1500
}
```

The plugin forwards `session.text.delta` events instead of waiting for
`session.text.ended`. It holds incomplete words, code, links, and Markdown
markers back; the final text event flushes the tail without repeating words
already sent. Each text part uses one queued child process. Stopping speech
invalidates queued streams and terminates the active process group.

`ttsMaxChars` is respected without splitting a word (`0` disables the limit).
Reasoning remains opt-in and is narrated only after its part ends. The command
receives the selected voice in `OPENCODE_VOICE_EDGE_VOICE` and its queue timestamp
in `OPENCODE_TTS_QUEUED_AT_MS` (Unix milliseconds), which an external stop helper
can use to reject jobs queued before a global stop.

This adds no provider dependency or API keys to the plugin. Commands using a
`{text}` placeholder are not compatible; they must read stdin. A command that
waits for EOF (including the bundled edge-tts wrapper) still waits for the full
text part, even with this option enabled. Speech Dispatcher continues using
the completed-text path. With the default `ttsStreaming: false`, behavior is
unchanged.

### Sound commands

- `/sound` — toggle speech on/off. When turning it on it says “Voz ligada.”
- `/sound on` (`start`, `ligar`) — enable speech.
- `/sound off` (`stop`, `desligar`) — disable speech **and** stop speaking
  immediately (cuts the current utterance and clears the queue).
- `/sound pause` (`silence`, `calar`, `parar`) — silence now, but keep speech on.
- `/sound status` — show switch, engine, voices and limits.
- `/sound help` (`ajuda`) — show the command usage.

Starting a recording (`/mic`, `/mic start`) automatically silences the current
utterance so the microphone doesn't pick it up.

Works from any client, and persists to `~/.config/opencode/voice.json`.

### Fully offline (Piper, optional)

[Piper](https://github.com/rhasspy/piper) is a small neural TTS that runs
offline — less natural than edge-tts, but far better than espeak-ng. Install it
and a Portuguese voice, then point `OPENCODE_VOICE_TTS_COMMAND` at it (Piper
reads the text on stdin and writes WAV to stdout):

```sh
.venv/bin/python -m pip install piper-tts
# download a voice, e.g. pt_PT-tugão-medium.onnx (+ .json) into ~/mics
export OPENCODE_VOICE_TTS_COMMAND="$PWD/.venv/bin/piper -m $HOME/mics/pt_PT-tugao-medium.onnx -f - | paplay"
opencode service restart
```

Any command that consumes text on stdin and plays audio works (e.g. `espeak`,
`piper`, a cloud TTS CLI).

## Options

These are read from the plugin `options` object when the plugin is loaded via
`cli.json`. With the `opencode.json` install they are ignored — use the
environment variables above instead.

| Option          | Default                          | Description                                                                 |
| --------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `backend`       | `"local"` when bundled, else env | `"api"` for an OpenAI-compatible endpoint, `"local"` for a CLI.             |
| `baseURL`       | `https://api.openai.com/v1`      | API base URL.                                                               |
| `apiKey`        | from env                         | Bearer token. Supports `{env:NAME}`.                                        |
| `apiKeyEnv`     | inferred from `baseURL`          | Name of the env var that holds the key.                                     |
| `model`         | `gpt-4o-mini-transcribe`         | Transcription model (`whisper-1`, `whisper-large-v3-turbo`, …).             |
| `language`      | auto                             | ISO-639-1 hint, e.g. `"en"`.                                                |
| `prompt`        | –                                | Vocabulary/spelling hint passed to the recognizer.                          |
| `localCommand`  | bundled whisper wrapper          | Shell command for the local backend. Tokens: `{audio}`, `{outdir}`, `{out}`.|
| `localShell`    | `sh` / `cmd`                     | Shell used to run `localCommand`.                                           |
| `keybind`       | `"<leader>v"`                    | Binding, or `false` to disable the automatic binding.                       |
| `slash`         | `"mic"`                          | Slash command name, or `""` to disable it. Registered with `arguments: true` so typing `/mic` + Enter runs it. |
| `aliases`       | `["stt"]`                        | Slash aliases.                                                              |
| `confirm`       | `false`                          | Show a dialog to review the text before sending.                            |
| `submitMode`    | `"edit"`                         | `"edit"` opens an editable dialog before sending; `"send"` sends directly.  |
| `delivery`      | `"steer"`                        | `"steer"` to send now, `"queue"` to append behind running work.             |
| `prefix`        | `""`                             | Text prepended to the transcript.                                           |
| `suffix`        | `""`                             | Text appended to the transcript.                                            |
| `polish`        | `false`                          | Clean the transcript with the current model before sending.                 |
| `polishPrompt`  | built-in instruction             | Prompt used by `polish`; the raw transcript is appended.                     |
| `recorder`      | `"auto"`                         | `pw-record`, `parecord`, `arecord`, `ffmpeg`, or `sox`.                     |
| `sampleRate`    | `16000`                          | Capture sample rate.                                                        |
| `maxDuration`   | `120`                            | Auto-stop after this many seconds (`0` disables).                           |
| `minDuration`   | `0.35`                           | Reject recordings shorter than this many seconds.                           |
| `keepAudio`     | `false`                          | Keep the WAV file for debugging.                                            |
| `timeoutMs`     | `60000`                          | HTTP timeout for the transcription request.                                 |

## Examples

### Local faster-whisper (default here)

The bundled wrapper is used automatically. `npm install` (postinstall) or
`npm run setup` creates the environment with both engines:

```sh
npm install                               # dev deps + .venv (edge-tts, faster-whisper)
npm run setup                             # run just the Python setup again
OPENCODE_VOICE_SKIP_SETUP=1 npm install   # skip the Python step (CI)
```

The model is downloaded on first use and cached by Hugging Face. Tune it with
environment variables:

```sh
export OPENCODE_VOICE_WHISPER_MODEL=base.en   # tiny.en is faster, small is more accurate
export OPENCODE_VOICE_WHISPER_LANGUAGE=en     # skip auto-detect
```

Point `localCommand`/`OPENCODE_VOICE_LOCAL_COMMAND` at any other Whisper CLI if
you prefer. For `openai-whisper`:

```
whisper {audio} --model small --language en --output_format txt --output_dir {outdir}
```

For `whisper.cpp`:

```
whisper-cli -m /path/to/ggml-base.en.bin -f {audio} -otxt -of {out}
```

### Cloud STT (Groq, very fast)

```sh
export OPENCODE_VOICE_BACKEND=api
export OPENCODE_VOICE_BASE_URL=https://api.groq.com/openai/v1
export OPENCODE_VOICE_MODEL=whisper-large-v3-turbo
export OPENAI_API_KEY=   # not used
export GROQ_API_KEY=gsk_...
```

```sh
export OPENCODE_VOICE_BACKEND=api
export OPENCODE_VOICE_BASE_URL=https://api.groq.com/openai/v1
export OPENCODE_VOICE_MODEL=whisper-large-v3-turbo
export GROQ_API_KEY=gsk_...
```

### Preview before sending, and polish the text

With the `cli.json` install:

```json
{
  "package": "/home/hdlrocha/opencode-voice",
  "options": { "confirm": true, "polish": true, "language": "en" }
}
```

## Troubleshooting

- **The plugin is not in the plugins list** — it must be registered in
  `opencode.json(c)` (not `cli.json`) and the server must be restarted. Verify
  with `opencode plugin list` and `opencode api get /api/plugin`.
- **"no microphone recorder available"** — install one of `pipewire`
  (`pw-record`), `pulseaudio-utils` (`parecord`), `alsa-utils` (`arecord`),
  `sox`, or `ffmpeg`. On macOS/Windows you need `ffmpeg`.
- **"recording produced no audio"** — the recorder started but captured
  nothing. Check your input device and, on macOS, that
  `ffmpeg -f avfoundation -i :0` lists a real audio device index.
- **"transcription failed" / empty text** — try a larger model
  (`OPENCODE_VOICE_WHISPER_MODEL=small`) or set
  `OPENCODE_VOICE_WHISPER_LANGUAGE=en`.
- **"no API key"** — the cloud backend was selected but no key is available;
  set `OPENAI_API_KEY`/`GROQ_API_KEY`, or unset `OPENCODE_VOICE_BACKEND` to use
  the bundled local engine.
- **Nothing happens on `<leader>v`** — the leader key may be rebound. Check
  `keybinds.leader`, or bind the command directly with
  `keybinds["voice.input.toggle"]`.

## Development

```sh
npm install        # dev deps + the bundled Python engines (.venv)
npm run typecheck  # tsc --noEmit (voice + remote)
npm test           # typecheck + voice smoke test + remote vitest suites
npm run build      # compile the remote runtime (Session API + bots) to dist/
```

OpenCode resolves `@opencode/plugin/tui` at runtime, so the plugin runs without
a build step. The import is only needed locally for TypeScript.

## Remote control (Telegram + Nostr)

The same sessions, from your phone or any Nostr client — through an
independent **Session API** (REST + SSE) and a small OpenCode plugin. Voice
and remote are independent halves: use either or both.

```
Telegram → Telegram Adapter →┐
                             ├→ Session API → Remote Plugin → OpenCode Session
Nostr    → Nostr Adapter   →┘
```

- **Telegram** (`src/remote/telegram/`): grammY standalone bot + in-process
  plugin bot (`pluginBot.ts`, raw Bot API polling). `/sessions`, `/new`,
  `/use <n|id>`, `/status`, `/abort`, `/nostr [npub]`; plain text prompts the
  selected session; progress edits one `🤖 …` message; agent screenshots
  arrive as photos. From OpenCode, `/telegram <bot-token> <group-id>`
  registers an **"Opencode Talk" group and `/telegram` gives every session its
  own forum topic** (project + model/reasoning seeded from the session).
  `/telegram <chat-id>` still links an extra private chat.
  Setup: [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md).
- **Nostr** (`src/remote/nostr/`): encrypted DMs, two modes. Plugin-native
  (recommended): the remote plugin itself connects to relays — each session
  owns a keypair, DM its npub directly, pair with OpenCode `/nostr <your-npub>`.
  Standalone: encrypted-DM client of the Session API, paired via Telegram
  `/nostr <your-npub>`. Setup: [docs/NOSTR_SETUP.md](docs/NOSTR_SETUP.md).
- **Session API** (`src/remote/session-api/` + `src/remote/opencode/`): Express
  server over `@opencode/client` — session CRUD, `POST …/message`, `…/abort`,
  media store for agent images, SSE fan-out. Reference: [docs/API.md](docs/API.md).
- **Remote plugin** (`remote-plugin/`, id `telegram-bridge`): typed RPC
  (`sendMessage`/`abort`/`status`), compact progress events, a
  `telegram_send_image` agent tool ("run the app 2 minutes and send me the
  screenshot"), and the in-process Nostr bridge (`/nostr`). Install:
  [docs/PLUGIN_INSTALL.md](docs/PLUGIN_INSTALL.md).
- **Prompt mirroring**: a prompt typed locally in OpenCode (TUI/desktop/web,
  `/mic` transcripts included) is posted as `👤 …` into every Telegram chat,
  XMPP chat and Nostr DM bound to that session. Prompts that came from a
  remote bridge are not echoed back, and slash commands stay local.

Quick start (plugin-native Telegram + Nostr — no API/bot processes):

```sh
export TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
export TELEGRAM_ALLOWED_USERS=123456789
export NOSTR_RELAYS=wss://nos.lol,wss://relay.snort.social
export NOSTR_ALLOWED_NPUBS=npub1you...
opencode service restart
# Telegram: message the bot, /sessions, /use 1 — or link from OpenCode: /telegram <chat-id>
# Bot + group: /telegram <bot-token> <group-id>, or /telegram group <group-id> after /telegram <bot-token>
# Voice to Telegram: /telegram talk (off with /telegram shut); halt bot: /telegram stop
# Every plugin command: /talk help
# Nostr: inside OpenCode: /nostr, then /nostr <your-npub>, then DM the session npub
```

### Telegram group: one topic per OpenCode session (recommended)

Use a single Telegram group as a session hub instead of private chats.
One-time setup:

#### 1. Create the bot with @BotFather

1. Open a chat with [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a display name (e.g. `OpenCode Talk`) and a username ending in `bot`
   (e.g. `opencode_talk_bot`).
3. Copy the token BotFather replies with (`123456:ABC-DEF...`) — treat it like
   a password. The plugin saves it to `TELEGRAM_TOKEN_FILE` (mode 0600).
4. Optional but recommended:
   - `/setjoingroups` → **Enable** (default) so the bot can be added to the
     group.
   - `/setprivacy` → select the bot → **Disable**. An admin bot receives all
     group messages anyway (see step 3), but disabling privacy keeps
     plain-text prompts working if the bot is ever demoted.

#### 2. Create the group

1. Telegram → **New Group** → name it **Opencode Talk** → add the bot as a
   member (search its @username).
2. Open the group → **Edit** → enable **Topics** (forum mode). Without Topics
   the bot cannot create the per-session topics.
3. Find the group id (negative, e.g. `-1001234567890`):
   - add [@userinfobot](https://t.me/userinfobot) to the group — it posts the
     group id (remove it afterwards), or
   - send a message in the group and open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser — look for
     `"chat":{"id":-100…}`. This needs the bot to be an admin or to have
     privacy disabled (steps 1.4/3).

#### 3. Give the bot permissions in the group

1. Group → **Edit** → **Administrators** → **Add Admin** → select the bot.
2. Enable:
   - **Manage Topics** — required: creates the per-session forum topics.
   - **Send Messages** — required (on by default).
   - **Delete Messages** — optional: lets it tidy its own progress messages.
3. Save. As an admin the bot receives every group message, regardless of
   privacy mode.

#### 4. Register the group and use it

1. In OpenCode run `/telegram <bot-token> <group-id>`: the token is verified,
   saved locked-down (`TELEGRAM_TOKEN_FILE`, mode 0600), the bot connects, and
   the group is registered. You can also do it in two steps — connect the bot
   with `/telegram <bot-token>`, then the group with
   `/telegram group <group-id>`.
2. From any session run `/telegram` (or any time later): the bot creates or
   reuses a topic named after the session, binds it, and posts the first
   message showing the session's **project** and **model + reasoning already
   selected**.
3. Write in a topic to prompt that session — progress edits and results stay
   in the topic. `/models`, `/model`, `/status`, `/abort`, `/nostr` work there
   too; `/telegram status` shows state without touching the group.
4. Creating a topic yourself works in reverse: the bot creates a new session
   named after the topic, binds it, and asks for model + reasoning. Telegram
   only delivers topic-creation notices to administrators, so keep the bot an
   admin (step 3).
5. Renaming the session (e.g. in the TUI) renames its bound topic to match.
   A topic renamed by hand stays as typed until the session is renamed again.

Prerequisites: group mode requires the **plugin-native** bot (it creates
topics through the same in-process polling loop); `TELEGRAM_ALLOWED_USERS`
must contain your user id. The standalone `dev:bot` process ignores topic
mappings.

Telegram allows only **one `getUpdates` consumer per bot token**. If several
OpenCode servers run (e.g. the desktop app's server plus the background
`opencode serve --service`), the first to start polls and the others run in
**secondary mode** — no polling, but topic linking and sends still work from
those processes — instead of fighting with `409 Conflict`.
`TELEGRAM_LOCK_FILE` overrides the shared lock path when the plugin is
installed in more than one place. Mappings, token/account files, bot state
and media resolve against the install directory (not each server's working
directory), so every server shares them — absolute `*_FILE` paths in `.env`
still win when set. Stopping extra servers is still recommended: with several
servers only one polls, and linked topics reply from whichever holds the
poller.

Quick start (standalone adapters via the Session API):

```sh
cp .env.example .env   # SESSION_API_TOKEN, TELEGRAM_BOT_TOKEN, ...
npm run dev:api        # Session API on 127.0.0.1:3456
npm run dev:bot        # Telegram bot
npm run dev:nostr      # Nostr adapter (needs NOSTR_RELAYS)
```

Remote config lives in `.env` (see `.env.example`); voice config stays in
`voice.json`. Secrets for both are git-ignored.
