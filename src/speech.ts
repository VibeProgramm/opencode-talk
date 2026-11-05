import type { VoiceConfig } from "./config.js"
import { node, platform } from "./node.js"
import { detectLanguage, type DetectedLanguage } from "./lang.js"
export { detectLanguage, type DetectedLanguage }
export { StreamingText } from "./streaming-text.js"

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
  cancel?: () => void
  streams?: Set<() => void>
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
async function withPlaybackLock<T>(fn: () => Promise<T>, cancelled = () => false): Promise<T | undefined> {
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
  const deadline = Date.now() + 5 * 60 * 1000

  for (;;) {
    if (cancelled()) return
    try {
      const handle = await fs.open(file, "wx")
      await handle.writeFile(`${pid} ${Date.now()}`)
      await handle.close()
      break
    } catch {
      // Someone else is playing, or a crashed process left the lock behind.
      let steal = false
      try {
        const [owner] = (await fs.readFile(file, "utf8")).trim().split(/\s+/)
        // A live owner may legitimately narrate a long response. Age alone is
        // never permission to overlap playback. Empty files may be initializing.
        steal = Number(owner) > 0 ? !alive(Number(owner)) : Date.now() - (await fs.stat(file)).mtimeMs > 5000
      } catch {
        steal = true // lock vanished between open and read
      }
      if (!steal && Date.now() > deadline) throw new Error("Playback lock timeout")
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

export function speak(cfg: VoiceConfig, raw: string, signal?: AbortSignal): Promise<void> {
  if (!cfg.tts) return Promise.resolve()
  const text = sanitize(raw, cfg.ttsMaxChars)
  if (!text) return Promise.resolve()
  const st = state()
  const generation = st.generation
  st.queue = st.queue
    .then(() => (state().generation === generation && !signal?.aborted ? utter(cfg, text, generation, signal) : undefined))
    .catch(() => {})
  return st.queue as Promise<void>
}

/** One serialized child process with a stdin that stays open as text arrives. */
export function streamSpeech(cfg: VoiceConfig) {
  const st = state()
  st.streams ??= new Set()
  if (st.streams.size >= 64) {
    console.warn("[voice] Streaming speech failed: queue exceeds 64 jobs")
    return { finished: Promise.resolve(), write(_text: string) {}, end() {}, cancel() {} }
  }
  const generation = st.generation
  const queuedAt = Date.now()
  let child: import("node:child_process").ChildProcess | undefined
  let ended = false
  let cancelled = false
  let settled = false
  let blocked = false
  let characters = 0
  let bytes = 0
  let termination: Promise<void> | undefined
  const pending: string[] = []
  const stale = () => cancelled || state().generation !== generation
  const cancel = () => {
    cancelled = true
    pending.length = 0
    bytes = 0
    if (child) termination ??= killTree(child)
  }
  const fail = (reason: string) => {
    if (!cancelled) console.warn(`[voice] Streaming speech failed: ${reason}`)
    cancel()
  }
  const pump = () => {
    if (!child?.stdin || blocked || stale() || settled) return
    if (pending.length) {
      const text = pending.join("")
      pending.length = 0
      bytes = 0
      blocked = !child.stdin.write(text)
    }
    if (ended && !pending.length && !blocked && !child.stdin.writableEnded) child.stdin.end()
  }
  const end = () => {
    ended = true
    pump()
  }
  st.streams.add(cancel)
  st.queue = st.queue.then(async () => {
    if (!cfg.tts || stale()) { st.streams?.delete(cancel); return }
    st.cancel = cancel
    let timeout = setTimeout(() => fail("playback lock timeout"), Math.max(1000, cfg.ttsTimeoutMs ?? 900000))
    try {
      await withPlaybackLock(async () => {
        if (stale()) return
        const { cp } = await node()
        if (stale()) return
        const command = cfg.ttsCommand
        if (!command || command.includes("{text}")) { fail("requires a stdin command"); return }
        const args = platform() === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]
        const baseEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
        const voice = pickVoice(cfg, pending.join("")).voice
        child = cp.spawn(cfg.ttsShell, args, {
          stdio: ["pipe", "ignore", "ignore"], detached: platform() !== "win32",
          env: { ...baseEnv, ...(voice ? { OPENCODE_VOICE_EDGE_VOICE: voice } : {}), OPENCODE_TTS_QUEUED_AT_MS: String(queuedAt) },
        })
        clearTimeout(timeout)
        timeout = setTimeout(() => fail("timeout"), cfg.ttsTimeoutMs ?? 900000)
        st.current = child
        const finished = new Promise<void>((resolve) => {
          child!.once("error", () => { fail("receiver spawn error"); resolve() })
          child!.once("exit", (code) => {
            if (!stale() && (code !== 0 || !ended || pending.length || !child?.stdin?.writableFinished)) {
              fail(code !== 0 ? `receiver exit ${code}` : "receiver exited before text EOF")
            }
            resolve()
          })
        })
        child.stdin?.on("error", () => { if (!stale()) fail("receiver stdin error") })
        child.stdin?.on("drain", () => { blocked = false; pump() })
        pump()
        await finished
        await termination
        if (st.current === child) st.current = undefined
      }, stale)
    } finally {
      clearTimeout(timeout)
      if (st.cancel === cancel) st.cancel = undefined
      settled = true
      pending.length = 0
      bytes = 0
      st.streams?.delete(cancel)
    }
  }).catch(() => fail("receiver error"))
  return {
    finished: st.queue,
    write(text: string) {
      if (ended || stale() || settled || !text) return
      const remaining = cfg.ttsMaxChars > 0 ? cfg.ttsMaxChars - characters : Infinity
      // Inspect only the bounded prefix needed for the limit. A single giant
      // delta must not allocate an equally giant codepoint array before failing.
      const points: string[] = []
      for (const point of text) {
        points.push(point)
        if (points.length > remaining || points.length > 262144) break
      }
      const truncated = points.length > remaining
      if (!truncated && points.length > 262144) {
        fail("pending text exceeds 256 KiB")
        return
      }
      if (truncated) {
        text = points.slice(0, remaining).join("")
        if (points[remaining] && !/\s/.test(points[remaining])) text = text.replace(/\S+$/, "")
        console.warn("[voice] Streaming speech truncated at character limit")
      }
      characters += Array.from(text).length
      if (text) {
        const size = Buffer.byteLength(text)
        if (bytes + size + (child?.stdin?.writableLength ?? 0) > 262144) {
          fail("pending text exceeds 256 KiB")
          return
        }
        pending.push(text)
        bytes += size
        pump()
      }
      if (truncated) end()
    },
    end,
    cancel,
  }
}

export function stopSpeaking(): void {
  const st = state()
  st.generation++ // drop anything still queued
  for (const cancel of st.streams ?? []) cancel()
  if (st.cancel) st.cancel()
  else void killTree(st.current)
}

/**
 * Kill the current utterance and everything it spawned (shell → python →
 * audio player). Killing only the shell would leave the player running, so the
 * old audio would keep playing behind the next utterance.
 */
function killTree(child: import("node:child_process").ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return Promise.resolve()
  const proc = (globalThis as {
    process?: { kill?: (pid: number, signal?: string | number) => boolean; platform?: string }
  }).process
  const terminated = new Promise<void>((resolve) => setTimeout(() => {
    try {
      if (proc?.platform !== "win32") proc?.kill?.(-child.pid!, "SIGKILL")
      else child.kill("SIGKILL")
    } catch { /* process group already gone */ }
    resolve()
  }, 250))
  if (proc?.platform === "win32") {
    try {
      child.kill("SIGTERM")
    } catch {
      // ignore
    }
    return terminated
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
  return terminated
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

async function utter(cfg: VoiceConfig, text: string, generation: number, signal?: AbortSignal): Promise<void> {
  const { cp } = await node()
  const picked = pickVoice(cfg, text)
  const cancelled = () => !!signal?.aborted || state().generation !== generation
  return withPlaybackLock(async () => {
    if (cancelled()) return
    let termination: Promise<void> | undefined
    const abort = () => { termination ??= killTree(state().current) }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      if (cfg.ttsEngine === "command" && cfg.ttsCommand) {
        await runCommand(cp, cfg, text, picked.voice)
      } else await spdSay(cp, cfg, text, picked.lang ?? cfg.ttsVoice)
    } finally {
      signal?.removeEventListener("abort", abort)
      await termination
    }
  }, cancelled)
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
