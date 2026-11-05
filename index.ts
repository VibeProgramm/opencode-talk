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
    let disposed = false
    let epoch = 0
    const pendingClaims = new Map<string, string>()
    const globalScope = globalThis as Record<symbol, unknown>
    const spokenKey = Symbol.for("opencode.voice.spokenEvents")
    if (!globalScope[spokenKey]) globalScope[spokenKey] = new Set<string>()
    const spoken = globalScope[spokenKey] as Set<string>
    function remember(key: string) {
      spoken.add(key)
      if (spoken.size > 2000) spoken.delete(spoken.values().next().value!)
    }
    const controlsKey = Symbol.for("opencode.voice.streamControls")
    if (!globalScope[controlsKey]) globalScope[controlsKey] = new Set<(sessionID?: string) => void>()
    const controls = globalScope[controlsKey] as Set<(sessionID?: string) => void>
    const streams = new Map<string, { sessionID: string; text: StreamingText; ended?: boolean; speech?: ReturnType<typeof streamSpeech> }>()
    const completedJobs = new Map<AbortController, string>()
    function cancelStreams(sessionID?: string) {
      if (!sessionID) epoch++
      for (const [key, session] of pendingClaims) {
        if (!sessionID || session === sessionID) remember(key)
      }
      for (const [key, stream] of streams) {
        if (sessionID && stream.sessionID !== sessionID) continue
        stream.speech?.cancel()
        streams.delete(key)
      }
      for (const [controller, session] of completedJobs) {
        if (!sessionID || session === sessionID) controller.abort()
      }
    }
    function silence() {
      for (const cancel of controls) cancel()
      stopSpeaking()
    }
    controls.add(cancelStreams)

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
      silence() // silence any ongoing TTS before recording
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
            silence()
            return
          }
          if (TTS_OFF_WORDS.has(arg)) {
            silence()
            saveConfigFile({ tts: false })
            refresh()
            return
          }
          refresh()
          const next = !cfg.tts
          if (!next) silence()
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

    const speech = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: speech.signal })) {
        if (disposed) break
        if (event.type === "session.execution.interrupted" || event.type === "session.execution.failed") {
          for (const cancel of controls) cancel(event.data.sessionID)
          continue
        }
        if (event.type !== "session.text.delta" && event.type !== "session.text.ended" && event.type !== "session.reasoning.ended") continue
        const reasoning = event.type === "session.reasoning.ended"
        const { sessionID, assistantMessageID, ordinal } = event.data
        const key = `${reasoning ? "reasoning" : "text"}:${sessionID}:${assistantMessageID}:${ordinal}`

        refresh()
        if (!cfg.tts) {
          silence()
          remember(key)
          continue
        }
        if (reasoning && !cfg.ttsReasoning) continue

        const existing = streams.get(key)
        if (existing?.ended) continue
        const streaming = !!existing || (cfg.ttsStreaming && cfg.ttsEngine === "command")
        if (!existing && spoken.has(key)) continue
        if (event.type === "session.text.delta" && !streaming) continue

        if (!existing) {
          const claimedEpoch = epoch
          pendingClaims.set(key, sessionID)
          try {
            const info = await ctx.session.get({ sessionID })
            // Only flat, matching V2 session metadata can establish a root.
            if (!info || typeof info !== "object" || Array.isArray(info) ||
                typeof info.id !== "string" || !info.id || info.id !== sessionID ||
                info.parentID !== undefined) continue
            if (disposed || epoch !== claimedEpoch || spoken.has(key)) continue
            if (!(await isSpeakerOwner())) continue
            if (disposed || epoch !== claimedEpoch || spoken.has(key)) continue
            if (!(await claimOnce(key))) continue
            const cancelled = disposed || epoch !== claimedEpoch || spoken.has(key)
            remember(key)
            if (cancelled) continue
          } catch {
            continue
          } finally {
            pendingClaims.delete(key)
          }
        }

        if (streaming && !reasoning) {
          if (!existing && streams.size >= 64) {
            console.warn("[voice] Streaming speech failed: more than 64 active text parts")
            continue
          }
          const stream: { sessionID: string; text: StreamingText; ended?: boolean; speech?: ReturnType<typeof streamSpeech> } = existing ?? { sessionID, text: new StreamingText() }
          streams.set(key, stream)
          try {
            const clean = event.type === "session.text.delta"
              ? stream.text.append(event.data.delta)
              : stream.text.finish(event.data.text)
            if (clean) {
              if (!stream.speech) {
                stream.speech = streamSpeech(cfg)
                void stream.speech.finished.finally(() => {
                  if (streams.get(key) === stream) streams.delete(key)
                })
              }
              stream.speech.write(clean)
            }
            if (event.type === "session.text.ended") {
              stream.speech?.end()
              stream.ended = true
              if (!stream.speech) streams.delete(key)
            }
          } catch {
            console.warn("[voice] Streaming text failed: invalid or oversized Markdown/final snapshot")
            stream.speech?.cancel()
            streams.delete(key)
          }
        } else if (event.type !== "session.text.delta") {
          const controller = new AbortController()
          completedJobs.set(controller, sessionID)
          void Promise.resolve(speak(cfg, event.data.text, controller.signal)).finally(() => completedJobs.delete(controller))
        }
      }
    })().catch(() => {
      if (!disposed) console.warn("[voice] Speech event subscription failed")
    }).finally(() => cancelStreams())

    return () => {
      disposed = true
      speech.abort()
      cancelStreams()
      controls.delete(cancelStreams)
      if (timer) clearTimeout(timer)
      if (recording) void recording.abort()
    }
  },
})
