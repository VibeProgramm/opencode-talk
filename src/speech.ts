import type { VoiceConfig } from "./config.js"
import { node, platform } from "./node.js"
import { detectLanguage, type DetectedLanguage } from "./lang.js"
export { detectLanguage, type DetectedLanguage }

/**
 * Text-to-speech for the agent's messages.
 *
 * Utterances are serialized through a single queue, plus a machine-wide
 * playback lock, so agent messages and reasoning parts play one after another
 * instead of talking over each other. Engines:
 *   - "spd-say": speech-dispatcher (espeak-ng backend).
 *   - "command": any command that reads the text on stdin and plays audio, e.g.
 *                the bundled edge-tts wrapper (`scripts/edge_tts_play.py`).
 *
 * When `tts.auto` is on, the language is detected per message and an English,
 * Portuguese or French voice is used accordingly. English is the default when
 * the text is inconclusive (numbers, very short replies).
 */

interface SpeechState {
  queue: Promise<unknown>
  generation: number
  current?: import("node:child_process").ChildProcess
}

/** One queue per process, shared by every plugin instance (globalThis). */
function state(): SpeechState {
  const g = globalThis as Record<symbol, unknown>
  const key = Symbol.for("opencode.voice.speech.state")
  if (!g[key]) g[key] = { queue: Promise.resolve(), generation: 0 } as SpeechState
  return g[key] as SpeechState
}

/**
 * One utterance at a time, machine-wide. The promise queue above serializes
 * `speak` calls inside one plugin instance, but OpenCode can load the plugin
 * more than once (once per location, or on hot reload) and those instances do
 * not share `globalThis`. This lock file makes sure only one instance is
 * audible at any moment, so agent messages and reasoning parts play one after
 * another instead of talking over each other.
 */
async function withPlaybackLock<T>(fn: () => Promise<T>): Promise<T> {
  const { fs, os, path } = await node()
  const proc = (globalThis as {
    process?: {
      pid?: number
      kill?: (pid: number, signal?: number) => boolean
      getuid?: () => number
    }
  }).process
  const pid = proc?.pid ?? 0
  const uid = proc?.getuid?.() ?? 0
  const file = path.join(os.tmpdir(), `opencode-voice.playing-${uid}`)
  const alive = (value: number): boolean => {
    try {
      proc?.kill?.(value, 0)
      return true
    } catch {
      return false
    }
  }
  const staleAfter = 10 * 60 * 1000 // longer than any utterance can be
  const deadline = Date.now() + 5 * 60 * 1000

  for (;;) {
    try {
      const handle = await fs.open(file, "wx")
      await handle.writeFile(`${pid} ${Date.now()}`)
      await handle.close()
      break
    } catch {
      // Someone else is playing, or a crashed process left the lock behind.
      let steal = false
      try {
        const [owner, stamp] = (await fs.readFile(file, "utf8")).trim().split(/\s+/)
        const age = Date.now() - Number(stamp)
        steal = !Number(owner) || !alive(Number(owner)) || age > staleAfter
      } catch {
        steal = true // lock vanished between open and read
      }
      if (!steal && Date.now() > deadline) steal = true // never block speech forever
      if (steal) {
        try {
          await fs.rm(file, { force: true })
        } catch {
          // ignore
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  try {
    return await fn()
  } finally {
    try {
      await fs.rm(file, { force: true })
    } catch {
      // ignore
    }
  }
}

function pickVoice(cfg: VoiceConfig, text: string): { voice?: string; lang?: string } {
  if (!cfg.ttsAuto) {
    return { voice: cfg.ttsVoice, lang: cfg.ttsVoice }
  }
  const lang = detectLanguage(text) ?? "en"
  if (lang === "en") return { voice: cfg.ttsVoiceEn, lang }
  if (lang === "fr") return { voice: cfg.ttsVoiceFr, lang }
  return { voice: cfg.ttsVoice, lang: "pt" }
}

export function speak(cfg: VoiceConfig, raw: string): Promise<void> {
  if (!cfg.tts) return Promise.resolve()
  const text = sanitize(raw, cfg.ttsMaxChars)
  if (!text) return Promise.resolve()
  const st = state()
  const generation = st.generation
  st.queue = st.queue
    .then(() => (state().generation === generation ? utter(cfg, text) : undefined))
    .catch(() => {})
  return st.queue as Promise<void>
}

/** One serialized child process with a stdin that stays open as text arrives. */
export function streamSpeech(cfg: VoiceConfig) {
  const st = state()
  const generation = st.generation
  const queuedAt = Date.now()
  let child: import("node:child_process").ChildProcess | undefined
  let ended = false
  let characters = 0
  const pending: string[] = []
  const end = () => {
    ended = true
    if (child?.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
  }
  st.queue = st.queue.then(async () => {
    if (!cfg.tts || state().generation !== generation) return
    await withPlaybackLock(async () => {
      if (state().generation !== generation) return
      const { cp } = await node()
      const command = cfg.ttsCommand
      if (!command || command.includes("{text}")) throw new Error("Streaming speech needs a stdin command")
      const args = platform() === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]
      const baseEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
      const voice = pickVoice(cfg, pending.join("")).voice
      child = cp.spawn(cfg.ttsShell, args, {
        stdio: ["pipe", "ignore", "ignore"], detached: platform() !== "win32",
        env: { ...baseEnv, ...(voice ? { OPENCODE_VOICE_EDGE_VOICE: voice } : {}), OPENCODE_TTS_QUEUED_AT_MS: String(queuedAt) },
      })
      st.current = child
      const finished = waitExit(child)
      child.stdin?.on("error", () => {}) // stop/error may close the receiver while deltas still arrive
      for (const text of pending.splice(0)) child.stdin?.write(text)
      if (ended) child.stdin?.end()
      await finished
      if (st.current === child) st.current = undefined
    })
  }).catch((error) => console.warn(`[voice] Streaming speech failed: ${error instanceof Error ? error.message : "unknown error"}`))
  return {
    finished: st.queue,
    write(text: string) {
      if (ended || state().generation !== generation || !text) return
      const remaining = cfg.ttsMaxChars > 0 ? cfg.ttsMaxChars - characters : Infinity
      const truncated = text.length > remaining
      if (truncated) text = text.slice(0, remaining).replace(/\S+$/, "")
      characters += text.length
      if (text) {
        if (child) {
          if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(text)
        } else pending.push(text)
      }
      if (truncated || (cfg.ttsMaxChars > 0 && characters >= cfg.ttsMaxChars)) end()
    },
    end,
  }
}

/** Keep unfinished words and Markdown constructs back, not the entire response. */
export class StreamingText {
  private raw = ""
  private emitted = ""

  append(delta: string): string {
    this.raw += delta
    return this.take(false)
  }

  finish(fullText?: string): string {
    if (fullText !== undefined) this.raw = fullText
    return this.take(true)
  }

  private take(final: boolean): string {
    let text = this.raw.replace(/```[\s\S]*?```/g, " ")
    const fence = text.indexOf("```")
    if (fence >= 0) text = text.slice(0, fence)
    text = text.replace(/`[^`]*`/g, " ")
    const inline = text.indexOf("`")
    if (inline >= 0) text = text.slice(0, inline)
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    if (!final) {
      const link = text.search(/!?\[[^\]]*(?:\](?:\([^)]*)?)?$/)
      if (link >= 0) text = text.slice(0, link)
      const boundary = text.search(/\s+\S*$/)
      // Keep a delimiter so a standalone "## " or "1. " is recognized as Markdown.
      text = boundary >= 0 ? text.slice(0, boundary + 1) : ""
    }
    // Paragraph punctuation cannot be inserted retroactively after a spoken word.
    let clean = sanitize(text, 0, true)
    if (clean && !final) clean += " "
    if (!clean.startsWith(this.emitted)) return ""
    const next = clean.slice(this.emitted.length)
    this.emitted = clean
    return next
  }
}

export function stopSpeaking(): void {
  const st = state()
  st.generation++ // drop anything still queued
  killTree(st.current)
}

/**
 * Kill the current utterance and everything it spawned (shell → python →
 * audio player). Killing only the shell would leave the player running, so the
 * old audio would keep playing behind the next utterance.
 */
function killTree(child: import("node:child_process").ChildProcess | undefined): void {
  if (!child?.pid) return
  const proc = (globalThis as {
    process?: { kill?: (pid: number, signal?: string | number) => boolean; platform?: string }
  }).process
  if (proc?.platform === "win32") {
    try {
      child.kill("SIGTERM")
    } catch {
      // ignore
    }
    return
  }
  try {
    proc?.kill?.(-child.pid, "SIGTERM") // negative pid = the child's process group
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // ignore
    }
  }
}

/**
 * Cross-process coordination so that, when several OpenCode servers share this
 * machine, only ONE of them speaks. The owner is stored as a PID in a temp file;
 * if the recorded owner is gone, another process takes over.
 */
let ownerConfirmed = false

export async function isSpeakerOwner(): Promise<boolean> {
  if (ownerConfirmed) return true
  const { fs, os, path } = await node()
  const proc = (globalThis as {
    process?: { pid?: number; kill?: (pid: number, signal?: number) => boolean }
  }).process
  const pid = proc?.pid ?? 0
  if (!pid) return true

  const file = path.join(os.tmpdir(), "opencode-voice.speaker")
  const alive = (value: number): boolean => {
    try {
      proc?.kill?.(value, 0)
      return true
    } catch {
      return false
    }
  }

  let owner = 0
  try {
    owner = Number((await fs.readFile(file, "utf8")).trim())
  } catch {
    // no owner yet
  }
  if (owner === pid) {
    ownerConfirmed = true
    return true
  }
  if (owner && alive(owner)) return false

  try {
    await fs.writeFile(file, String(pid))
  } catch {
    return false
  }
  try {
    if (Number((await fs.readFile(file, "utf8")).trim()) === pid) {
      ownerConfirmed = true
      return true
    }
  } catch {
    // fall through
  }
  return false
}

/** Cross-process, per-message dedupe: the first process to claim a key speaks. */
export async function claimOnce(key: string): Promise<boolean> {
  const { fs, os, path } = await node()
  const dir = path.join(os.tmpdir(), "opencode-voice.spoken")
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch {
    // ignore
  }
  const file = path.join(dir, key.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 150))
  try {
    const handle = await fs.open(file, "wx")
    await handle.close()
    return true
  } catch {
    return false
  }
}

/** Strip markdown/code/URLs so the spoken text reads like prose. */
export function sanitize(text: string, maxChars: number, flattenWhitespace = false): string {
  let out = text
  out = out.replace(/```[\s\S]*?```/g, " ") // fenced code blocks
  out = out.replace(/`[^`]*`/g, " ") // inline code
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> label
  out = out.replace(/https?:\/\/\S+/g, " ") // bare URLs
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
  out = out.replace(/^\s{0,3}>\s?/gm, "") // blockquotes
  out = out.replace(/^\s*[-*+]\s+/gm, "") // bullets
  out = out.replace(/^\s*\d+[.)]\s+/gm, "") // ordered lists
  out = out.replace(/[*_~|]/g, "") // emphasis / table pipes
  if (flattenWhitespace) out = out.replace(/\s+/g, " ")
  else {
    out = out.replace(/[ \t]+/g, " ")
    out = out.replace(/\n{2,}/g, ". ")
    out = out.replace(/\n/g, ", ")
  }
  out = out.replace(/\s*\.\s*\./g, ".") // collapse duplicate periods
  out = out.trim()
  if (maxChars > 0 && out.length > maxChars) out = out.slice(0, maxChars)
  return out
}

async function utter(cfg: VoiceConfig, text: string): Promise<void> {
  const { cp } = await node()
  const picked = pickVoice(cfg, text)
  return withPlaybackLock(async () => {
    if (cfg.ttsEngine === "command" && cfg.ttsCommand) {
      return runCommand(cp, cfg, text, picked.voice)
    }
    return spdSay(cp, cfg, text, picked.lang ?? cfg.ttsVoice)
  })
}

async function spdSay(
  cp: typeof import("node:child_process"),
  cfg: VoiceConfig,
  text: string,
  lang: string | undefined,
): Promise<void> {
  const args = ["-w"]
  if (lang) args.push("-l", lang)
  if (cfg.ttsRate) args.push("-r", String(cfg.ttsRate))
  args.push("-e") // read the text from stdin
  const st = state()
  st.current = cp.spawn("spd-say", args, {
    stdio: ["pipe", "ignore", "ignore"],
    detached: platform() !== "win32", // own process group, so stopSpeaking can kill it whole
  })
  st.current.stdin?.end(text)
  await waitExit(st.current)
  st.current = undefined
}

async function runCommand(
  cp: typeof import("node:child_process"),
  cfg: VoiceConfig,
  text: string,
  voice: string | undefined,
): Promise<void> {
  const command = (cfg.ttsCommand ?? "").replaceAll("{text}", text)
  const args = platform() === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]
  const baseEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const env = voice ? { ...baseEnv, OPENCODE_VOICE_EDGE_VOICE: voice } : baseEnv
  const st = state()
  st.current = cp.spawn(cfg.ttsShell, args, {
    stdio: ["pipe", "ignore", "ignore"],
    env,
    detached: platform() !== "win32", // own process group, so stopSpeaking can kill it whole
  })
  st.current.stdin?.end(text)
  await waitExit(st.current)
  st.current = undefined
}

function waitExit(child: import("node:child_process").ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
}
