import { createHash } from "node:crypto"

/** Incremental prose parser. Unresolved tokens/labels retain at most 16,384 UTF-16 units.
 * Code and destinations are discarded as they arrive. The digest validates the
 * final snapshot without retaining or reparsing the consumed transcript.
 */
export class StreamingText {
  private digest = createHash("sha256")
  private consumed = 0
  private done = false
  private token = ""
  private prefix = true
  private indent = 0
  private mode: "text" | "run" | "code" | "label" | "afterLabel" | "destination" | "indent" = "text"
  private marker = ""
  private width = 0
  private run = 0
  private fence = false
  private fenceHeader = false
  private quoteDepth = 0
  private fenceQuoteDepth = 0
  private quotesRemaining = 0
  private codeLineStart = false
  private closing = false
  private depth = 0
  private label = ""
  private image = false
  private lastPeriod = false
  private output = ""

  append(delta: string): string {
    if (this.done) throw new Error("Streaming text is already finished")
    this.digest.update(delta, "utf16le")
    this.consumed += delta.length
    this.output = ""
    for (const char of delta) this.character(char)
    return this.output
  }

  finish(fullText?: string): string {
    if (this.done) return ""
    let out = ""
    if (fullText !== undefined) {
      const prefix = createHash("sha256").update(fullText.slice(0, this.consumed), "utf16le").digest("hex")
      if (fullText.length < this.consumed || prefix !== this.digest.copy().digest("hex")) {
        throw new Error("Final streaming text diverged from consumed text")
      }
      out = this.append(fullText.slice(this.consumed))
    }
    this.output = ""
    if (this.mode === "afterLabel") {
      this.emitLabel()
      this.mode = "text"
    }
    if (this.mode === "text") this.flush(false)
    else if (this.mode !== "indent" && !(this.mode === "code" && this.run === this.width)) {
      console.warn("[voice] Incomplete Markdown construct omitted at text EOF")
    }
    this.done = true
    return out + this.output
  }

  private bounded(value: string): string {
    if (value.length > 16384) throw new Error("Streaming Markdown construct exceeds 16384 characters")
    return value
  }

  private flush(space: boolean) {
    const word = this.token.replace(/[*_~|]/g, "")
    this.token = ""
    if (!word || /^<?https?:\/\//i.test(word)) return
    if (word === "." && this.lastPeriod) return
    this.output += word + (space ? " " : "")
    this.lastPeriod = word.endsWith(".")
  }

  private emitLabel() {
    if (!this.image) {
      const label = new StreamingText()
      const clean = label.append(this.label) + label.finish()
      for (const char of clean) {
        if (/\s/.test(char)) this.flush(true)
        else this.token = this.bounded(this.token + char)
      }
    }
    this.label = ""
  }

  private character(char: string): void {
    if (this.mode === "indent") {
      if (char === "\n") { this.mode = "text"; this.prefix = true; this.indent = 0; this.quoteDepth = 0 }
      return
    }
    if (this.mode === "run") {
      if (char === this.marker) { this.width++; return }
      if (this.marker === "~" && this.width < 3) {
        this.mode = "text"
        this.character(char)
        return
      }
      this.fence = this.fence && this.width >= 3
      this.fenceHeader = this.fence
      this.codeLineStart = false
      this.mode = "code"
      this.character(char)
      return
    }
    if (this.mode === "code") {
      // A backtick in a backtick fence's info string invalidates the
      // opening fence: this may instead be a root-line inline code span.
      if (this.fenceHeader && this.marker === "`" && char === "`") this.fence = false
      if (char === "\n") this.fenceHeader = false
      // Strip only the quote containers which enclosed this fence. A '>'
      // inside a root fence is code, not permission to recognize a closer.
      if (this.fence && this.codeLineStart && !this.run && char === ">" && this.quotesRemaining > 0) {
        this.quotesRemaining--
        return
      }
      if (char === this.marker) {
        if (!this.run) this.closing = this.codeLineStart && this.quotesRemaining === 0
        this.run++
        return
      }
      if ((!this.fence && this.run === this.width) || (this.fence && this.closing && this.run >= this.width && /\s/.test(char))) {
        this.mode = "text"; this.run = 0
        this.character(char)
      } else {
        if (this.run || !/[ \t]/.test(char)) this.codeLineStart = false
        if (char === "\n") {
          this.codeLineStart = true
          this.quotesRemaining = this.fenceQuoteDepth
        }
        this.run = 0
      }
      return
    }
    if (this.mode === "destination") {
      if (char === "(" && ++this.depth > 16384) throw new Error("Streaming link nesting exceeds limit")
      if (char === ")" && --this.depth === 0) this.mode = "text"
      return
    }
    if (this.mode === "label") {
      if (char === "]") this.mode = "afterLabel"
      else this.label = this.bounded(this.label + char)
      return
    }
    if (this.mode === "afterLabel") {
      this.emitLabel()
      this.mode = "text"
      if (char === "(") { this.mode = "destination"; this.depth = 1; return }
      this.character(char)
      return
    }
    if (this.prefix && !this.token && (char === " " || char === "\t")) {
      this.indent += char === "\t" ? 4 : 1
      if (this.indent >= 4) this.mode = "indent"
      return
    }
    if (char === "`" || (char === "~" && this.prefix && !this.token)) {
      this.fence = this.prefix && !this.token
      this.fenceQuoteDepth = this.quoteDepth
      this.quotesRemaining = 0
      this.flush(true); this.marker = char; this.width = 1; this.run = 0; this.mode = "run"; this.prefix = false
      return
    }
    if (char === "[") {
      this.image = this.token.endsWith("!")
      if (this.image) this.token = this.token.slice(0, -1)
      this.flush(true); this.mode = "label"
      return
    }
    if (/\s/.test(char)) {
      if (this.prefix && /^(?:#{1,6}|>+|[-*+]|\d+[.)])$/.test(this.token)) {
        this.token = ""
        this.indent = 0
        return
      }
      this.flush(true)
      if (char === "\n") { this.prefix = true; this.indent = 0; this.quoteDepth = 0 }
      else this.prefix = false
      return
    }
    if (char === ">" && this.prefix && !this.token) {
      this.quoteDepth++
      this.indent = 0
      return
    }
    if (char === ">" && /^<https?:\/\//i.test(this.token)) {
      this.token = ""
      return
    }
    this.token = this.bounded(this.token + char)
  }
}
