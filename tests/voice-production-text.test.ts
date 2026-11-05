import { describe, expect, it } from "vitest"
import { StreamingText } from "../src/speech.js"

function render(chunks: string[]) {
  const text = new StreamingText()
  return chunks.map((chunk) => text.append(chunk)).join("") + text.finish(chunks.join(""))
}

// Whitespace already sent before a later punctuation token cannot be retracted.
const prose = (text: string) => text.trim().replace(/\s+([.,!?])/g, "$1")

describe("streamed Markdown regression corpus", () => {
  const cases = [
    ["Hello . . Tail remains audible.", "Hello. Tail remains audible."],
    ["Before ``code ` with backtick`` after.", "Before after."],
    ["Before\n````js\ncode ``` inside\n````\nAfter.", "Before After."],
    ["Before\n~~~js\nsecret code\n~~~\nAfter.", "Before After."],
    ["Before\n    secret code\n\nAfter.", "Before After."],
    ["Read [label](https://site/path(with space)) after.", "Read label after."],
    ["Intro\n## Heading\n1. First\n- Last\n> Quote.", "Intro Heading First Last Quote."],
    ["Before `multiline\ncode` and [a label](https://example.com) after.", "Before and a label after."],
    ["Read [label `hidden code` words](https://site/path) after.", "Read label words after."],
    ["Before\n> ## Heading\n> quoted text\nAfter.", "Before Heading quoted text After."],
    ["~~outdated~~ Current text.", "outdated Current text."],
    ["Before\n```js\nconst x = \"```\";\nsecret code\n```\nAfter.", "Before After."],
    ["Before\n```js\nsecret code\n````\nAfter.", "Before After."],
    ["Read [last label]", "Read last label"],
    ["Before ```inline triple code``` after.", "Before after."],
    ["Read <https://example.com/path> then tail.", "Read then tail."],
    ["```inline triple code``` after.", "after."],
    ["Before\n> ```js\n> secret code\n> ```\nAfter.", "Before After."],
    ["Before\n>> ```js\n>> secret code\n>> ```\nAfter.", "Before After."],
  ]
  for (const [raw, expected] of cases) {
    it(`preserves the tail across every split: ${JSON.stringify(raw)}`, () => {
      // UTF-16 code-unit splitting also covers transport deltas inside astral characters.
      expect(prose(render(raw.split("")))).toBe(expected)
      for (let split = 1; split < raw.length; split++) {
        expect(prose(render([raw.slice(0, split), raw.slice(split)])), `split ${split}`).toBe(expected)
      }
    })
  }

  it("keeps supplementary Unicode words whole across UTF-16 delta boundaries", () => {
    const raw = "Пример 😀работает целиком."
    expect(render(raw.split(""))).toBe(raw)
  })

  it("does not retain every already-consumed word in long live responses", () => {
    const text = new StreamingText()
    let output = ""
    const started = performance.now()
    for (let i = 0; i < 20_000; i++) output += text.append("word ")
    output += text.finish()
    expect(output.trim()).toBe("word ".repeat(20_000).trim())
    // A generous end-to-end bound catches full-prefix reparsing (quadratic work).
    expect(performance.now() - started).toBeLessThan(1500)
  })
})
