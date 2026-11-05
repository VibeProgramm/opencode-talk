import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../src/config.js"
import { speak, stopSpeaking, streamSpeech } from "../src/speech.js"

let directory: string
let previousTmp: string | undefined
const children: number[] = []
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "voice-production-"))
  previousTmp = process.env.TMPDIR
  process.env.TMPDIR = directory
  await mkdir(join(directory, "config"))
})
afterEach(async () => {
  stopSpeaking()
  for (const pid of children.splice(0)) {
    try { process.kill(-pid, "SIGKILL") } catch { /* already exited */ }
  }
  const state = (globalThis as Record<symbol, unknown>)[Symbol.for("opencode.voice.speech.state")] as { queue: Promise<unknown> }
  await state.queue
  if (previousTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmp
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

async function command(code: string, options: Record<string, unknown> = {}) {
  const script = join(directory, `reader-${Math.random()}.mjs`)
  await writeFile(script, code)
  return resolveConfig({ tts: true, ttsAuto: false, ttsEngine: "command", ttsMaxChars: 0,
    ttsCommand: `exec "${process.execPath}" "${script}"`, ...options })
}

it("reports a command failure rather than silently dropping the remaining narration", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const job = streamSpeech(await command("process.exit(7)"))
  job.write("First word ")
  job.end()
  await job.finished.catch(() => {})
  expect(warn).toHaveBeenCalled()
  expect(warn.mock.calls.flat().join(" ")).toMatch(/7|exit|failed/i)
})

it("reports a receiver that exits successfully before text EOF", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const job = streamSpeech(await command("process.exit(0)"))
  job.write("First word ")
  await job.finished.catch(() => {})
  job.write("Lost tail ")
  job.end()
  expect(warn).toHaveBeenCalled()
})

it("does not discard a whole word that fits exactly at the configured limit", async () => {
  const output = join(directory, "received")
  const job = streamSpeech(await command(`import { appendFileSync } from 'node:fs'; process.stdin.on('data', data => appendFileSync(${JSON.stringify(output)}, data));`, { ttsMaxChars: 5 }))
  job.write("Hello ")
  job.end()
  await job.finished
  expect(await readFile(output, "utf8").catch(() => "")).toBe("Hello")
})

it("times out a stuck receiver and advances the queue", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const pidFile = join(directory, "pid")
  const job = streamSpeech(await command(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`, { ttsTimeoutMs: 100 }))
  job.write("Text ")
  job.end()
  await expect.poll(async () => Number(await readFile(pidFile, "utf8").catch(() => "0"))).toBeGreaterThan(0)
  children.push(Number(await readFile(pidFile, "utf8")))
  const outcome = await Promise.race([job.finished.then(() => "finished", () => "finished"), new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 1500))])
  expect(outcome).toBe("finished")
  expect(warn).toHaveBeenCalled()
  const next = streamSpeech(await command("process.stdin.resume()"))
  next.end()
  await next.finished
})

it("counts supplementary Unicode as characters and never truncates a surrogate pair", async () => {
  const output = join(directory, "unicode")
  const job = streamSpeech(await command(`import { appendFileSync } from 'node:fs'; process.stdin.on('data', data => appendFileSync(${JSON.stringify(output)}, data));`, { ttsMaxChars: 2 }))
  job.write("😀x tail")
  job.end()
  await job.finished
  expect(await readFile(output, "utf8").catch(() => "")).toBe("😀x")
})

it("cancelled queued streams never start or retain later writes", async () => {
  const output = join(directory, "queued")
  const pidFile = join(directory, "active")
  const active = streamSpeech(await command(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume();`))
  active.write("Active ")
  await expect.poll(async () => Number(await readFile(pidFile, "utf8").catch(() => "0"))).toBeGreaterThan(0)
  children.push(Number(await readFile(pidFile, "utf8")))
  const queued = streamSpeech(await command(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, 'started'); process.stdin.resume();`))
  queued.write("Queued ")
  stopSpeaking()
  active.write("Stale ")
  queued.write("Stale ")
  active.end()
  queued.end()
  await Promise.all([active.finished, queued.finished])
  expect(await readFile(output, "utf8").catch(() => "")).toBe("")
})

it("escalates stop for a receiver that ignores SIGTERM and releases its queue", async () => {
  const pidFile = join(directory, "ignoring")
  const job = streamSpeech(await command(`import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`))
  job.write("Text ")
  await expect.poll(async () => Number(await readFile(pidFile, "utf8").catch(() => "0"))).toBeGreaterThan(0)
  children.push(Number(await readFile(pidFile, "utf8")))
  stopSpeaking()
  const outcome = await Promise.race([job.finished.then(() => "finished", () => "finished"), new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 2000))])
  expect(outcome).toBe("finished")
})

it("delivers over 10,000 Unicode characters exactly once before stdin EOF", async () => {
  const output = join(directory, "long-response")
  const job = streamSpeech(await command(`import { appendFileSync } from 'node:fs'; process.stdin.on('data', data => appendFileSync(${JSON.stringify(output)}, data));`))
  const text = "Пример 😀 ".repeat(2000)
  for (let i = 0; i < 20; i++) job.write("Пример 😀 ".repeat(100))
  await expect.poll(async () => readFile(output, "utf8").catch(() => ""), { timeout: 3000 }).toBe(text)
  job.write("Конец.")
  job.end()
  await job.finished
  expect(await readFile(output, "utf8")).toBe(text + "Конец.")
})

it("bounds a stalled receiver's buffering and explicitly reports overflow", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const pidFile = join(directory, "backpressure")
  const job = streamSpeech(await command(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.pause(); setInterval(() => {}, 1000);`))
  job.write("Initial ")
  await expect.poll(async () => Number(await readFile(pidFile, "utf8").catch(() => "0"))).toBeGreaterThan(0)
  children.push(Number(await readFile(pidFile, "utf8")))
  const state = (globalThis as Record<symbol, unknown>)[Symbol.for("opencode.voice.speech.state")] as { current?: import("node:child_process").ChildProcess }
  const child = state.current
  const chunk = "word ".repeat(100_000)
  for (let i = 0; i < 32; i++) job.write(chunk)
  expect(child?.stdin?.writableLength ?? 0).toBeLessThan(4 * 1024 * 1024)
  await expect.poll(() => warn.mock.calls.length).toBeGreaterThan(0)
  stopSpeaking()
  await job.finished.catch(() => {})
})

it("does not steal an old playback lock from a still-live long utterance", async () => {
  const file = join(directory, `opencode-voice.playing-${process.getuid?.() ?? 0}`)
  await writeFile(file, `${process.pid} ${Date.now() - 11 * 60 * 1000}`)
  const started = join(directory, "must-not-start")
  const job = streamSpeech(await command(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(started)}, 'started'); process.stdin.resume();`))
  job.write("Queued ")
  job.end()
  await new Promise((resolve) => setTimeout(resolve, 300))
  stopSpeaking()
  await job.finished
  expect(await readFile(started, "utf8").catch(() => "")).toBe("")
  expect(await readFile(file, "utf8")).toMatch(new RegExp(`^${process.pid} `))
})

it("cancels a completed-text receiver through its owner signal without blocking following speech", async () => {
  const pidFile = join(directory, "completed-owner")
  const cfg = await command(`import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`)
  const controller = new AbortController()
  const completed = speak(cfg, "Completed text", controller.signal)
  await expect.poll(async () => Number(await readFile(pidFile, "utf8").catch(() => "0"))).toBeGreaterThan(0)
  children.push(Number(await readFile(pidFile, "utf8")))
  const next = streamSpeech(await command("process.stdin.resume()"))
  next.write("Following ")
  next.end()
  controller.abort()
  const outcome = await Promise.race([Promise.all([completed, next.finished]).then(() => "finished"), new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 2000))])
  expect(outcome).toBe("finished")
})
