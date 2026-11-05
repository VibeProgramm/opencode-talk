import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../src/config.js"
import { StreamingText, streamSpeech, stopSpeaking } from "../src/speech.js"

const directories: string[] = []
afterEach(async () => {
  stopSpeaking()
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it("validates the final snapshot and appends only its missing suffix", () => {
  const text = new StreamingText()
  expect(text.append("Hello par")).toBe("Hello ")
  expect(text.finish("Hello partial tail.")).toBe("partial tail.")
  expect(text.finish("Hello partial tail.")).toBe("")
  const diverged = new StreamingText()
  diverged.append("Hello ")
  expect(() => diverged.finish("Other tail")).toThrow(/diverged/)
})

it("rejects oversized incomplete words/labels explicitly", () => {
  for (const prefix of ["", "["]) {
    const text = new StreamingText()
    text.append(prefix)
    expect(() => text.append("x".repeat(16385))).toThrow(/exceeds/)
  }
})

it("flushes a bracket label supplied only by the final snapshot", () => {
  const text = new StreamingText()
  expect(text.append("Read ") + text.finish("Read [last label]")).toBe("Read last label")
})

it("preserves text immediately following autolinks and multi-backtick inline spans", () => {
  for (const raw of ["Before <https://site/path>after.", "Before ````inline code````after."]) {
    const text = new StreamingText()
    expect(raw.split("").map(char => text.append(char)).join("") + text.finish()).toBe("Before after.")
  }
})

it("distinguishes root-line inline spans and quote-container fence closers", () => {
  const cases = [
    ["````inline ` code```` tail.", "tail."],
    ["> > ~~~js\n> > secret\n> > ~~~\nTail.", "Tail."],
    [">```js\n>secret\n>```\nTail.", "Tail."],
    ["```js\n> ```\nstill secret\n```\nTail.", "Tail."],
  ]
  for (const [raw, expected] of cases) {
    for (let split = 0; split <= raw.length; split++) {
      const text = new StreamingText()
      expect((text.append(raw.slice(0, split)) + text.append(raw.slice(split)) + text.finish()).trim()).toBe(expected)
    }
  }
})

it("does not close a fence on inline fence-like text and discards long code incrementally", () => {
  const text = new StreamingText()
  let out = text.append("Before\n````js\n")
  for (let i = 0; i < 2000; i++) out += text.append("code ```` still code\n")
  out += text.append("````\nAfter ") + text.finish()
  expect(out.trim()).toBe("Before After")
})

it("bounds queued input, reports without transcript leakage, and advances the queue", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const directory = await mkdtemp(join(tmpdir(), "voice-fixer-"))
  directories.push(directory)
  const script = join(directory, "receiver.mjs")
  const output = join(directory, "received")
  await writeFile(script, `import {appendFileSync} from 'node:fs'; process.stdin.on('data', data => appendFileSync(${JSON.stringify(output)}, data))`)
  const cfg = resolveConfig({ tts: true, ttsMaxChars: 0, ttsEngine: "command", ttsCommand: `"${process.execPath}" "${script}"` })
  const overflow = streamSpeech(cfg)
  overflow.write("PRIVATE_TRANSCRIPT ".repeat(20000))
  await overflow.finished
  expect(warn).toHaveBeenCalled()
  expect(warn.mock.calls.flat().join(" ")).not.toContain("PRIVATE_TRANSCRIPT")
  const cancelled = streamSpeech(cfg)
  cancelled.write("Cancelled ")
  cancelled.cancel()
  await cancelled.finished
  const next = streamSpeech(cfg)
  next.write("Next ")
  next.end()
  await next.finished
  expect(await readFile(output, "utf8")).toBe("Next ")
})
