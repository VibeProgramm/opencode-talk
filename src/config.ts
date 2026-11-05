import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { loadConfigFile } from "./configfile.js"
import { env } from "./node.js"

export type Backend = "api" | "local"
export type Delivery = "steer" | "queue"

/** Path of the bundled local whisper wrapper, resolved next to this module. */
function bundledLocalCommand(): string | undefined {
  try {
    const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url))
    const script = fileURLToPath(new URL("../scripts/whisper_transcribe.py", import.meta.url))
    if (existsSync(python) && existsSync(script)) return `${python} ${script} {audio}`
  } catch {
    // ignore, fall back below
  }
  return undefined
}

/** Command of the bundled Edge neural-TTS wrapper, resolved next to this module. */
function bundledTtsCommand(): string | undefined {
  try {
    const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url))
    const script = fileURLToPath(new URL("../scripts/edge_tts_play.py", import.meta.url))
    if (existsSync(python) && existsSync(script)) return `${python} ${script}`
  } catch {
    // ignore, fall back below
  }
  return undefined
}


export interface VoiceConfig {
  /** Speech-to-text engine: an OpenAI-compatible HTTP API, or a local command. */
  backend: Backend
  /** Base URL for the OpenAI-compatible API, e.g. https://api.openai.com/v1. */
  baseURL: string
  /** Bearer token for the API. Falls back to OPENAI_API_KEY / GROQ_API_KEY. */
  apiKey?: string
  /** Transcription model name. */
  model: string
  /** Optional ISO-639-1 language hint. */
  language?: string
  /** Optional text that biases the recognizer's vocabulary/spelling. */
  promptHint?: string

  /** Shell command used when backend === "local". Supports {audio}, {outdir}, {out}. */
  localCommand: string
  /** Shell used to run localCommand. */
  localShell: string

  /** Keybind (default `<leader>v`) or `false` to disable the automatic binding. */
  keybind: string | false
  /** Slash command name, or `""` to disable it. */
  slash: string
  /** Slash command aliases. */
  aliases: string[]

  /** Show a confirm dialog before sending. */
  confirm: boolean
  /** How the prompt is delivered to the session. */
  delivery: Delivery
  /** Text prepended to the transcript. */
  prefix: string
  /** Text appended to the transcript. */
  suffix: string

  /** Run the transcript through the current model to clean it up before sending. */
  polish: boolean
  /** Instruction used by polish. The raw transcript is appended. */
  polishPrompt: string

  /** Recorder binary: "auto", "pw-record", "parecord", "arecord", "ffmpeg" or "sox". */
  recorder: string
  /** Capture sample rate. 16000 is plenty for speech. */
  sampleRate: number
  /** Auto-stop after this many seconds (0 disables). */
  maxDuration: number
  /** Reject recordings shorter than this many seconds. */
  minDuration: number
  /** Keep the recorded WAV on disk after sending. */
  keepAudio: boolean
  /** HTTP timeout for the transcription request, in milliseconds. */
  timeoutMs: number

  /** Speak the main agent's messages aloud. */
  tts: boolean
  /** Feed live text deltas to a streaming stdin command rather than waiting for text.ended. */
  ttsStreaming: boolean
  ttsTimeoutMs: number
  /** TTS engine: "spd-say" (speech-dispatcher) or "command". */
  ttsEngine: "spd-say" | "command"
  /** Language/voice for spd-say (e.g. "pt"), or a synthesis voice name. */
  ttsVoice?: string
  /** spd-say rate, -100..100. */
  ttsRate: number
  /** Auto-detect the language and pick a pt/en voice per message. */
  ttsAuto: boolean
  /** Also speak the agent's reasoning ("thinking") text. Off by default. */
  ttsReasoning: boolean
  /** Voice for English messages (edge voice name, e.g. en-US-AriaNeural). */
  ttsVoiceEn: string
  /** Voice for French messages (edge voice name, e.g. fr-FR-DeniseNeural). */
  ttsVoiceFr: string
  /** Command for engine="command"; the text is written to its stdin. */
  ttsCommand?: string
  /** Shell used for ttsCommand. */
  ttsShell: string
  /** Truncate spoken text to this many characters (0 = no limit). */
  ttsMaxChars: number

  /** On stop: "edit" opens an editable dialog before sending; "send" sends directly. */
  submitMode: "edit" | "send"
}

function firstDefined<T>(...values: (T | undefined | null)[]): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value
  }
  return undefined
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    if (/^(1|true|yes|on)$/i.test(value)) return true
    if (/^(0|false|no|off)$/i.test(value)) return false
  }
  return fallback
}

function asNum(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function asString(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return fallback
}

/** Resolve `{env:NAME}` references, otherwise return the literal value. */
function resolveRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  const match = /^\{env:([A-Za-z0-9_]+)\}$/.exec(trimmed)
  if (match) return env(match[1])
  return trimmed
}

export function resolveConfig(raw: Record<string, unknown> | undefined): VoiceConfig {
  // Precedence: explicit options > voice.json (the setup menu) > environment.
  const file = loadConfigFile()
  const o = { ...file, ...(raw ?? {}) } as Record<string, unknown>

  const baseURL = firstDefined(
    asString(o.baseURL, undefined),
    asString(o.baseUrl, undefined),
    env("OPENCODE_VOICE_BASE_URL"),
    "https://api.openai.com/v1",
  ) as string
  const isGroq = /groq/i.test(baseURL)

  const defaultModel = isGroq ? "whisper-large-v3-turbo" : "gpt-4o-mini-transcribe"
  const model = firstDefined(
    asString(o.model, undefined),
    env("OPENCODE_VOICE_MODEL"),
    defaultModel,
  ) as string

  const keyEnvName = firstDefined(
    asString(o.apiKeyEnv, undefined),
    isGroq ? "GROQ_API_KEY" : "OPENAI_API_KEY",
  ) as string
  const apiKey = firstDefined(
    resolveRef(o.apiKey),
    resolveRef(o.token),
    env("OPENCODE_VOICE_API_KEY"),
    env(keyEnvName),
    isGroq ? env("GROQ_API_KEY") : env("OPENAI_API_KEY"),
    isGroq ? env("OPENAI_API_KEY") : env("GROQ_API_KEY"),
  )

  const aliases = Array.isArray(o.aliases)
    ? o.aliases.map((value) => String(value))
    : typeof o.aliases === "string" && o.aliases.trim()
      ? o.aliases.split(",").map((value) => value.trim())
      : ["voice", "stt"]

  const bundled = bundledLocalCommand()
  const bundledTts = bundledTtsCommand()

  const explicitBackend = firstDefined(
    asString(o.backend, undefined),
    env("OPENCODE_VOICE_BACKEND"),
  )
  const backend: Backend = explicitBackend
    ? String(explicitBackend).toLowerCase() === "api"
      ? "api"
      : "local"
    : bundled
      ? "local"
      : apiKey
        ? "api"
        : "local"

  const deliveryValue = String(firstDefined(asString(o.delivery, undefined), "steer"))
  const delivery: Delivery = deliveryValue === "queue" ? "queue" : "steer"

  const keybindValue = o.keybind
  const keybind: string | false = keybindValue === false || keybindValue === "none"
    ? false
    : (firstDefined(asString(o.keybind, undefined), "<leader>v") as string)

  const requestedTtsEngine = firstDefined(
    asString(o.ttsEngine, undefined),
    env("OPENCODE_VOICE_TTS_ENGINE"),
  )
  const ttsEngine: "spd-say" | "command" = requestedTtsEngine
    ? String(requestedTtsEngine) === "command"
      ? "command"
      : "spd-say"
    : bundledTts
      ? "command"
      : "spd-say"
  const ttsCommand = firstDefined(
    asString(o.ttsCommand, undefined),
    env("OPENCODE_VOICE_TTS_COMMAND"),
    bundledTts,
  )

  return {
    backend,
    baseURL,
    apiKey,
    model,
    language: firstDefined(asString(o.language, undefined), env("OPENCODE_VOICE_LANGUAGE")),
    promptHint: firstDefined(asString(o.prompt, undefined), asString(o.promptHint, undefined)),

    localCommand: firstDefined(
      asString(o.localCommand, undefined),
      asString(o.command, undefined),
      env("OPENCODE_VOICE_LOCAL_COMMAND"),
      bundled,
      "whisper {audio} --model base --output_format txt --output_dir {outdir}",
    ) as string,
    localShell: firstDefined(asString(o.localShell, undefined), platform() === "win32" ? "cmd" : "sh") as string,

    keybind,
    slash: firstDefined(asString(o.slash, undefined), "mic") as string,
    aliases,

    confirm: asBool(o.confirm, false),
    delivery,
    prefix: firstDefined(asString(o.prefix, undefined), "") as string,
    suffix: firstDefined(asString(o.suffix, undefined), "") as string,

    polish: asBool(o.polish, false),
    polishPrompt: firstDefined(
      asString(o.polishPrompt, undefined),
      "Rewrite the following dictated text into clear, correctly punctuated prose. Preserve the original language and meaning. Reply with only the cleaned text.\n\n",
    ) as string,

    recorder: firstDefined(asString(o.recorder, undefined), "auto") as string,
    sampleRate: Math.max(8000, asNum(o.sampleRate, 16000)),
    maxDuration: Math.max(0, asNum(o.maxDuration, 120)),
    minDuration: Math.max(0, asNum(o.minDuration, 0.35)),
    keepAudio: asBool(o.keepAudio, false),
    timeoutMs: Math.max(1000, asNum(o.timeoutMs, 60000)),

    tts: asBool(firstDefined(o.tts, env("OPENCODE_VOICE_TTS")), true),
    ttsStreaming: asBool(firstDefined(o.ttsStreaming, env("OPENCODE_VOICE_TTS_STREAMING")), false),
    ttsTimeoutMs: Math.max(1, asNum(firstDefined(o.ttsTimeoutMs, env("OPENCODE_VOICE_TTS_TIMEOUT_MS")), 900000)),
    ttsEngine,
    ttsVoice: firstDefined(
      asString(o.ttsVoice, undefined),
      asString(o.ttsLanguage, undefined),
      env("OPENCODE_VOICE_TTS_VOICE"),
      "pt",
    ),
    ttsRate: asNum(firstDefined(o.ttsRate, env("OPENCODE_VOICE_TTS_RATE")), 0),
    ttsAuto: asBool(firstDefined(o.ttsAuto, env("OPENCODE_VOICE_TTS_AUTO")), true),
    ttsReasoning: asBool(
      firstDefined(
        o.ttsReasoning,
        o.ttsThinking,
        env("OPENCODE_VOICE_TTS_REASONING"),
        env("OPENCODE_VOICE_TTS_THINKING"),
      ),
      false,
    ),
    ttsVoiceEn: firstDefined(
      asString(o.ttsVoiceEn, undefined),
      env("OPENCODE_VOICE_TTS_VOICE_EN"),
      "en-US-AriaNeural",
    ) as string,
    ttsVoiceFr: firstDefined(
      asString(o.ttsVoiceFr, undefined),
      env("OPENCODE_VOICE_TTS_VOICE_FR"),
      "fr-FR-DeniseNeural",
    ) as string,
    ttsCommand,
    ttsShell: firstDefined(asString(o.ttsShell, undefined), platform() === "win32" ? "cmd" : "sh") as string,
    ttsMaxChars: Math.max(0, asNum(firstDefined(o.ttsMaxChars, env("OPENCODE_VOICE_TTS_MAX")), 1500)),
    submitMode:
      String(firstDefined(asString(o.submitMode, undefined), env("OPENCODE_VOICE_SUBMIT"), "edit")) === "send"
        ? "send"
        : "edit",
  }
}

function platform(): string {
  return (globalThis as { process?: { platform?: string } }).process?.platform ?? "linux"
}
