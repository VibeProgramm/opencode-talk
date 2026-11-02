import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./src/config.js"
import { saveConfigFile } from "./src/configfile.js"
import { MIC_HELP, SOUND_HELP } from "./src/help.js"
import { startRecording, type Recording } from "./src/recorder.js"
import { claimOnce, isSpeakerOwner, speak, stopSpeaking, streamSpeech, StreamingText } from "./src/speech.js"
import { transcribe } from "./src/transcribe.js"

/** `/mic <arg>` subcommands. */
const CANCEL_WORDS = new Set(["stop", "cancel", "abort", "off", "parar", "para", "cancelar", "cancela"])
const SEND_WORDS = new Set(["send", "submit", "enviar", "submeter", "terminar", "concluir"])
const START_WORDS = new Set(["start", "begin", "iniciar", "comecar", "começar", "gravar", "record"])
const HELP_WORDS = new Set(["help", "ajuda", "?"])
const STATUS_WORDS = new Set(["status", "estado", "info"])

/** `/sound <arg>` subcommands. */
const TTS_ON_WORDS = new Set(["start", "on", "ligar", "liga", "enable", "ativa", "ativar"])
const TTS_PAUSE_WORDS = new Set(["pause", "silence", "silencio", "silêncio", "quiet", "hush", "calar", "parar", "para"])
const TTS_OFF_WORDS = new Set([...CANCEL_WORDS, "off", "desligar", "desliga", "disable"])

/**
 * Server half of the voice plugin.
 *
 * This registers a `/voice` command on the server, so voice input works in any
 * client (terminal TUI, desktop, web) and does not depend on the terminal-only
 * plugin loading. It toggles: the first call starts recording, the second stops,
 * transcribes, and sends the text as a prompt.
 */
export default Plugin.define({
  id: "voice-input",
  async setup(ctx) {
    let cfg = resolveConfig(undefined)
    const refresh = () => {
      cfg = resolveConfig(undefined)
    }

    let recording: Recording | undefined
    let starting = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let target: { sessionID: string; prompt: Record<string, unknown>; delivery: "steer" | "queue" } | undefined

    async function finish() {
      refresh()
      const active = recording
      if (!active) return
      recording = undefined
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      const current = target
      target = undefined

      const { file } = await active.stop()
      try {
        const text = (await transcribe(cfg, file)).trim()
        if (text && current) {
          await ctx.session.prompt({
            ...(current.prompt as object),
            sessionID: current.sessionID,
            text,
            delivery: current.delivery,
          } as never)
        }
      } finally {
        await active.abort()
      }
    }

    async function start(sessionID: string, prompt: Record<string, unknown>, delivery: "steer" | "queue") {
      if (starting || recording) return
      refresh()
      stopSpeaking() // silence any ongoing TTS before recording
      starting = true
      try {
        recording = await startRecording({ recorder: cfg.recorder, sampleRate: cfg.sampleRate })
        target = { sessionID, prompt, delivery }
        if (cfg.maxDuration > 0) {
          timer = setTimeout(() => void finish().catch(() => {}), cfg.maxDuration * 1000)
        }
      } finally {
        starting = false
      }
    }

    async function cancel() {
      const active = recording
      if (!active) return
      recording = undefined
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      target = undefined
      await active.abort()
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "mic",
        description:
          "Microphone. `/mic` toggles (start, then stop & transcribe); `/mic start` records, `/mic send` stops & transcribes, `/mic abort` cancels, `/mic status` shows state, `/mic help` shows usage",
        execute: async ({ sessionID, prompt, delivery }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?mic\b/, "").trim()
          console.log(`[voice] /mic ${arg || "toggle"}${recording ? " (recording)" : ""}`)
          if (HELP_WORDS.has(arg)) {
            console.log(MIC_HELP)
            return
          }
          if (STATUS_WORDS.has(arg)) {
            refresh()
            console.log(
              `[voice] mic status: ${recording ? "recording" : "idle"}\n` +
                `backend: ${cfg.backend}${cfg.backend === "api" ? ` (model ${cfg.model} @ ${cfg.baseURL})` : ""}\n` +
                `recorder: ${cfg.recorder} @ ${cfg.sampleRate}Hz, max ${cfg.maxDuration}s`,
            )
            return
          }
          if (CANCEL_WORDS.has(arg)) {
            if (recording) await cancel()
            return
          }
          if (SEND_WORDS.has(arg)) {
            if (recording) await finish()
            return
          }
          if (START_WORDS.has(arg)) {
            if (!recording) await start(sessionID, prompt as unknown as Record<string, unknown>, delivery)
            return
          }
          if (recording) await finish()
          else await start(sessionID, prompt as unknown as Record<string, unknown>, delivery)
        },
      })
      editor.add({
        name: "sound",
        description:
          "Toggle speech of agent messages: /sound (toggle), /sound on, /sound off, /sound pause, /sound status, /sound help",
        execute: async ({ prompt }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?sound\b/, "").trim()
          console.log(`[voice] /sound ${arg || "toggle"}`)
          if (HELP_WORDS.has(arg)) {
            console.log(SOUND_HELP)
            return
          }
          if (STATUS_WORDS.has(arg)) {
            refresh()
            console.log(
              `[voice] sound status: ${cfg.tts ? "on" : "off"} (engine ${cfg.ttsEngine})\n` +
                `voices: pt ${cfg.ttsVoice} · en ${cfg.ttsVoiceEn} · fr ${cfg.ttsVoiceFr} (auto ${cfg.ttsAuto ? "on" : "off"})\n` +
                `reasoning: ${cfg.ttsReasoning ? "spoken" : "skipped"}, rate ${cfg.ttsRate}, max ${cfg.ttsMaxChars} chars`,
            )
            return
          }
          if (TTS_ON_WORDS.has(arg)) {
            saveConfigFile({ tts: true })
            refresh()
            void speak(cfg, "Voz ligada.")
            return
          }
          if (TTS_PAUSE_WORDS.has(arg)) {
            stopSpeaking()
            return
          }
          if (TTS_OFF_WORDS.has(arg)) {
            stopSpeaking()
            saveConfigFile({ tts: false })
            refresh()
            return
          }
          refresh()
          const next = !cfg.tts
          if (!next) stopSpeaking()
          saveConfigFile({ tts: next })
          refresh()
          if (next) void speak(cfg, "Voz ligada.")
        },
      })
    })

    // Speak the MAIN agent's text aloud: only root sessions (never subagents),
    // and only assistant text parts (never tool calls, shell output or commands).
    // Reasoning ("thinking") parts are spoken too, but only when `ttsReasoning`
    // is on (off by default). The server can instantiate the plugin once per
    // location, so dedupe events process-wide to speak each message exactly once.
    const spokenKey = Symbol.for("opencode.voice.spokenEvents")
    const globalScope = globalThis as Record<symbol, unknown>
    if (!globalScope[spokenKey]) globalScope[spokenKey] = new Set<string>()
    const spoken = globalScope[spokenKey] as Set<string>
    const streams = new Map<string, { sessionID: string; text: StreamingText; speech?: ReturnType<typeof streamSpeech> }>()

    const speech = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: speech.signal })) {
        if (event.type === "session.execution.interrupted" || event.type === "session.execution.failed") {
          for (const [key, stream] of streams) {
            if (stream.sessionID !== event.data.sessionID) continue
            stream.speech?.end()
            streams.delete(key)
            stopSpeaking()
          }
          continue
        }
        if (event.type !== "session.text.delta" && event.type !== "session.text.ended" && event.type !== "session.reasoning.ended") continue
        const reasoning = event.type === "session.reasoning.ended"
        const { sessionID, assistantMessageID, ordinal } = event.data
        const key = `${reasoning ? "reasoning" : "text"}:${sessionID}:${assistantMessageID}:${ordinal}`

        refresh()
        if (!cfg.tts) {
          streams.get(key)?.speech?.end()
          streams.delete(key)
          continue
        }
        if (reasoning && !cfg.ttsReasoning) continue

        const existing = streams.get(key)
        const streaming = !!existing || (cfg.ttsStreaming && cfg.ttsEngine === "command")
        if (!existing && spoken.has(key)) continue
        if (event.type === "session.text.delta" && !streaming) continue

        if (!existing) {
          try {
            const info = await ctx.session.get({ sessionID })
            if (info.parentID) continue
          } catch {
            continue
          }
          if (!(await isSpeakerOwner())) continue
          if (!(await claimOnce(key))) continue
          spoken.add(key)
          if (spoken.size > 2000) spoken.clear()
        }

        if (streaming && !reasoning) {
          const stream = existing ?? { sessionID, text: new StreamingText() }
          streams.set(key, stream)
          const clean = event.type === "session.text.delta"
            ? stream.text.append(event.data.delta)
            : stream.text.finish(event.data.text)
          if (clean) {
            stream.speech ??= streamSpeech(cfg)
            stream.speech.write(clean)
          }
          if (event.type === "session.text.ended") {
            stream.speech?.end()
            streams.delete(key)
          }
        } else if (event.type !== "session.text.delta") {
          void speak(cfg, event.data.text)
        }
      }
    })().catch(() => {})

    return () => {
      speech.abort()
      for (const stream of streams.values()) stream.speech?.end()
      streams.clear()
      stopSpeaking()
      if (timer) clearTimeout(timer)
      if (recording) void recording.abort()
    }
  },
})
