import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { SessionApi } from "@opencode/client/promise/api"

type SessionInfo = Awaited<ReturnType<SessionApi["get"]>>
const root = (id: string): SessionInfo => ({
  id, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, location: { directory: "/offline-session-fixture" },
})
const child = (id: string): SessionInfo => ({ ...root(id), parentID: "parent" })
const mocked = vi.hoisted(() => ({
  streaming: true,
  spoken: [] as string[],
  claims: vi.fn(async () => true),
}))
vi.mock("../src/config.js", () => ({ resolveConfig: () => ({
  tts: true, ttsStreaming: mocked.streaming, ttsEngine: "command", ttsCommand: "offline-receiver",
  ttsReasoning: true, ttsMaxChars: 0, ttsTimeoutMs: 600_000,
}) }))
vi.mock("../src/speech.js", async (original) => ({
  ...await original<typeof import("../src/speech.js")>(),
  isSpeakerOwner: async () => true, claimOnce: mocked.claims, stopSpeaking: vi.fn(),
  speak: async (_cfg: unknown, text: string) => { mocked.spoken.push(text) },
  streamSpeech: () => ({
    write: (text: string) => mocked.spoken.push(text), end() {}, cancel() {}, finished: new Promise<void>(() => {}),
  }),
}))
import plugin from "../index.js"

const cleanups: (() => Promise<void>)[] = []
beforeEach(() => {
  mocked.streaming = true
  mocked.spoken.length = 0
  mocked.claims.mockClear()
  ;(globalThis as Record<symbol, unknown>)[Symbol.for("opencode.voice.spokenEvents")] = new Set()
})
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function harness(get: (input: { sessionID: string }) => Promise<unknown>) {
  let wake: (() => void) | undefined
  let closed = false
  const queue: { event: unknown; done: () => void }[] = []
  const cleanup = await plugin.setup({
    command: { transform: async () => {} }, session: { get },
    event: { subscribe: async function* () {
      while (!closed) {
        if (!queue.length) await new Promise<void>((resolve) => { wake = resolve })
        const next = queue.shift()
        if (next) { yield next.event; next.done() }
      }
    } },
  } as never)
  cleanups.push(async () => { closed = true; wake?.(); if (typeof cleanup === "function") await cleanup() })
  return (type: string, data: object) => new Promise<void>((done) => {
    queue.push({ event: { type, data }, done }); wake?.()
  })
}
const part = { sessionID: "child-session", assistantMessageID: "assistant-message", ordinal: 0 }

for (const streaming of [true, false]) {
  it(`never narrates a preexisting V2 child (${streaming ? "streaming" : "completed"})`, async () => {
    mocked.streaming = streaming
    const send = await harness(async ({ sessionID }) => child(sessionID))
    await send("session.text.delta", { ...part, delta: "Child English narration " })
    await send("session.text.ended", { ...part, text: "Child English narration tail." })
    await send("session.reasoning.ended", { ...part, text: "Child private reasoning" })
    expect(mocked.spoken).toEqual([])
    expect(mocked.claims).not.toHaveBeenCalled()
  })
}

for (const [label, info] of [
  ["missing identity", {}],
  ["unrecognized wrapped child", { data: child(part.sessionID) }],
  ["another session's root metadata", root("different-session")],
] as const) {
  for (const streaming of [true, false]) it(`fails closed for ${label} (${streaming ? "deltas" : "final fallback"})`, async () => {
    mocked.streaming = streaming
    const send = await harness(async () => info)
    await send("session.text.delta", { ...part, delta: "Unknown child speech " })
    await send("session.text.ended", { ...part, text: "Unknown child speech tail." })
    await send("session.reasoning.ended", { ...part, text: "Unknown child reasoning" })
    expect(mocked.spoken).toEqual([])
    expect(mocked.claims).not.toHaveBeenCalled()
  })
}

it("does not grant a stream ownership before an initially unknown child is resolved", async () => {
  let calls = 0
  const send = await harness(async ({ sessionID }) => ++calls === 1 ? {} : child(sessionID))
  await send("session.text.delta", { ...part, delta: "Child first words " })
  await send("session.text.delta", { ...part, delta: "must remain silent " })
  await send("session.text.ended", { ...part, text: "Child first words must remain silent tail." })
  expect(mocked.spoken).toEqual([])
})

it("waits for parent metadata and keeps lookup failures silent", async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const get = vi.fn(async ({ sessionID }: { sessionID: string }) => { await waiting; return child(sessionID) })
  const send = await harness(get)
  const pending = send("session.text.delta", { ...part, delta: "Child delayed metadata " })
  await expect.poll(() => get.mock.calls.length).toBe(1)
  expect(mocked.spoken).toEqual([])
  release()
  await pending
  expect(mocked.spoken).toEqual([])
  const failed = await harness(async () => { throw new Error("session lookup unavailable") })
  await failed("session.text.ended", { ...part, text: "Unverified fallback" })
  expect(mocked.spoken).toEqual([])
})

it("still streams a verified root before ended with no final replay", async () => {
  const send = await harness(async ({ sessionID }) => root(sessionID))
  const main = { ...part, sessionID: "root-session" }
  await send("session.text.delta", { ...main, delta: "Root English prose " })
  expect(mocked.spoken.join("")).toBe("Root English prose ")
  await send("session.text.ended", { ...main, text: "Root English prose tail." })
  await send("session.text.ended", { ...main, text: "Root English prose tail." })
  expect(mocked.spoken.join("")).toBe("Root English prose tail.")
})
