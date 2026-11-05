import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { rootSession } from "./fixtures/session.js"

const mocked = vi.hoisted(() => ({
  cfg: { tts: true, ttsStreaming: true, ttsEngine: "command", ttsCommand: "cat", ttsReasoning: false, ttsMaxChars: 0, ttsTimeoutMs: 600_000 },
  jobs: [] as { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; finished: Promise<void> }[],
  stop: vi.fn(), claim: vi.fn(async () => true), owner: vi.fn(async () => true),
  say: vi.fn((_cfg: unknown, _text: string, _signal?: AbortSignal) => Promise.resolve()),
}))
vi.mock("../src/config.js", () => ({ resolveConfig: () => ({ ...mocked.cfg }) }))
vi.mock("../src/speech.js", async (original) => ({
  ...await original<typeof import("../src/speech.js")>(),
  stopSpeaking: mocked.stop, claimOnce: mocked.claim, isSpeakerOwner: mocked.owner,
  streamSpeech: vi.fn(() => {
    const job = { write: vi.fn(), end: vi.fn(), cancel: vi.fn(), finished: new Promise<void>(() => {}) }
    mocked.jobs.push(job)
    return job
  }), speak: mocked.say,
}))
import plugin from "../index.js"

const cleanups: (() => unknown)[] = []
beforeEach(() => {
  mocked.cfg.tts = true
  mocked.cfg.ttsStreaming = true
  mocked.cfg.ttsReasoning = false
  mocked.jobs.length = 0
  vi.clearAllMocks()
  const g = globalThis as Record<symbol, unknown>
  g[Symbol.for("opencode.voice.spokenEvents")] = new Set()
})
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function harness(get = vi.fn(async ({ sessionID }: { sessionID: string }) => rootSession(sessionID))) {
  let wake: (() => void) | undefined
  let ended = false
  const events: { event: unknown; done: () => void }[] = []
  const commands = new Map<string, { execute: (args: unknown) => Promise<void> }>()
  const cleanup = await plugin.setup({
    command: { transform: async (register: (editor: unknown) => void) => register({ add: (command: { name: string; execute: (args: unknown) => Promise<void> }) => commands.set(command.name, command) }) },
    session: { get },
    event: { subscribe: async function* () {
      while (!ended) {
        if (!events.length) await new Promise<void>((resolve) => { wake = resolve })
        const item = events.shift()
        if (item) { yield item.event; item.done() }
      }
    } },
  } as never)
  const close = async () => { ended = true; wake?.(); if (typeof cleanup === "function") await cleanup() }
  cleanups.push(close)
  return {
    close, get,
    pause: () => commands.get("sound")!.execute({ prompt: { text: "pause" } }),
    send: (type: string, data: object) => new Promise<void>((done) => { events.push({ event: { type, data }, done }); wake?.() }),
  }
}
const base = { sessionID: "root", assistantMessageID: "message", ordinal: 0 }

it("cancels a text part paused before its first complete word", async () => {
  const h = await harness()
  await h.send("session.text.delta", { ...base, delta: "Par" })
  await h.pause()
  await h.send("session.text.delta", { ...base, delta: "tial word " })
  await h.send("session.text.ended", { ...base, text: "Partial word tail" })
  expect(mocked.jobs).toHaveLength(0)
})

it("stops already-ended but still-playing text when its execution fails", async () => {
  const h = await harness()
  await h.send("session.text.delta", { ...base, delta: "Spoken " })
  await h.send("session.text.ended", { ...base, text: "Spoken tail" })
  mocked.stop.mockClear()
  await h.send("session.execution.failed", { sessionID: "root" })
  expect(mocked.stop.mock.calls.length + mocked.jobs[0].cancel.mock.calls.length).toBeGreaterThan(0)
})

it("cancels active speech when configuration is disabled", async () => {
  const h = await harness()
  await h.send("session.text.delta", { ...base, delta: "Spoken " })
  mocked.cfg.tts = false
  await h.send("session.text.delta", { ...base, delta: "more " })
  expect(mocked.stop.mock.calls.length + mocked.jobs[0].cancel.mock.calls.length).toBeGreaterThan(0)
})

it("does not start speech when teardown occurs during asynchronous session lookup", async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const get = vi.fn(async ({ sessionID }: { sessionID: string }) => { await waiting; return rootSession(sessionID) })
  const h = await harness(get)
  const sent = h.send("session.text.delta", { ...base, delta: "Stale text " })
  await expect.poll(() => get.mock.calls.length).toBe(1)
  await h.close()
  release()
  await sent
  expect(mocked.jobs).toHaveLength(0)
})

it("interrupting one session preserves the other session's narration", async () => {
  const h = await harness()
  await h.send("session.text.delta", { ...base, delta: "First session " })
  await h.send("session.text.delta", { ...base, sessionID: "other", delta: "Second session " })
  await h.send("session.execution.interrupted", { sessionID: "other", reason: "user" })
  expect(mocked.jobs[1].cancel).toHaveBeenCalled()
  expect(mocked.jobs[0].cancel).not.toHaveBeenCalled()
  expect(mocked.stop).not.toHaveBeenCalled()
})

it("does not create a stale stream after pause during a claim await", async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  mocked.claim.mockImplementationOnce(async () => { await waiting; return true })
  const h = await harness()
  const sent = h.send("session.text.delta", { ...base, delta: "Stale claim " })
  await expect.poll(() => mocked.claim.mock.calls.length).toBe(1)
  await h.pause()
  release()
  await sent
  expect(mocked.jobs).toHaveLength(0)
})

it("unloading one plugin instance does not cancel another instance's narration", async () => {
  const first = await harness()
  const second = await harness()
  await first.send("session.text.delta", { ...base, delta: "First location " })
  await second.send("session.text.delta", { ...base, sessionID: "another-location", delta: "Other location " })
  mocked.stop.mockClear()
  await first.close()
  expect(mocked.jobs[0].cancel).toHaveBeenCalled()
  expect(mocked.jobs[1].cancel).not.toHaveBeenCalled()
  expect(mocked.stop).not.toHaveBeenCalled()
})

it("preserves completed-text narration and dedupe when streaming is disabled", async () => {
  mocked.cfg.ttsStreaming = false
  const h = await harness()
  await h.send("session.text.delta", { ...base, delta: "Hello " })
  await h.send("session.text.delta", { ...base, delta: "world" })
  expect(mocked.jobs).toHaveLength(0)
  expect(mocked.say).not.toHaveBeenCalled()
  await h.send("session.text.ended", { ...base, text: "Hello world" })
  await h.send("session.text.ended", { ...base, text: "Hello world" })
  expect(mocked.say).toHaveBeenCalledTimes(1)
  expect(mocked.say.mock.calls[0][1]).toBe("Hello world")
})

it("narrates reasoning only when enabled and after its part ends", async () => {
  const h = await harness()
  await h.send("session.reasoning.ended", { ...base, text: "Hidden" })
  expect(mocked.say).not.toHaveBeenCalled()
  mocked.cfg.ttsReasoning = true
  await h.send("session.reasoning.delta", { ...base, delta: "Reasoning " })
  expect(mocked.say).not.toHaveBeenCalled()
  await h.send("session.reasoning.ended", { ...base, text: "Reasoning tail" })
  expect(mocked.say).toHaveBeenCalledTimes(1)
  expect(mocked.say.mock.calls[0][1]).toBe("Reasoning tail")
  expect(mocked.jobs).toHaveLength(0)
})

it("scopes cancellation of completed-text jobs through their abort signal", async () => {
  mocked.cfg.ttsStreaming = false
  mocked.say.mockImplementationOnce(() => new Promise<void>(() => {}))
  const h = await harness()
  await h.send("session.text.ended", { ...base, text: "Queued completed text" })
  const signal = mocked.say.mock.calls[0][2]
  expect(signal?.aborted).toBe(false)
  await h.send("session.execution.failed", { sessionID: base.sessionID })
  expect(signal?.aborted).toBe(true)
  expect(mocked.stop).not.toHaveBeenCalled()
})
