import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { StreamingText, streamSpeech, stopSpeaking } from "../src/speech.js";

const directories: string[] = [];
afterEach(async () => {
  stopSpeaking();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("streaming text cleanup", () => {
  it("emits complete words before the whole response, never half a word", () => {
    const text = new StreamingText();
    expect(text.append("При")).toBe("");
    expect(text.append("мер ")).toBe("Пример ");
    expect(text.append("рабо")).toBe("");
    expect(text.append("тает.")).toBe("");
    expect(text.finish()).toBe("работает.");
  });

  it("hides unfinished code fences, inline code, links and URLs across deltas", () => {
    const text = new StreamingText();
    let spoken = "";
    for (const part of ["**Готово** ", "`секрет ", "в коде` ", "``", "`sh\nrm -rf /\n", "``` ", "[ссылка ", "на сайт](https://example.com) ", "https://hidden.example ", "Конец."]) {
      spoken += text.append(part);
    }
    spoken += text.finish();
    expect(spoken.replace(/\s+/g, " ").trim()).toBe("Готово ссылка на сайт Конец.");
  });

  it("continues across paragraphs and split heading/list markers", () => {
    const text = new StreamingText();
    let spoken = "";
    for (const part of ["Первый абзац. ", "\n\n", "## ", "Заголовок\n", "1. ", "Первый пункт.\n", "> ", "Цитата.\n", "- ", "Последний пункт."]) {
      spoken += text.append(part);
    }
    spoken += text.finish();
    expect(spoken).toBe("Первый абзац. Заголовок Первый пункт. Цитата. Последний пункт.");
  });
});

it("writes the first text to the real child stdin while the stream is still open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-stream-"));
  directories.push(directory);
  const output = `${directory}/received`;
  const script = `${directory}/reader.mjs`;
  await writeFile(script, `import { appendFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(output)}, '');\nprocess.stdin.on('data', data => appendFileSync(${JSON.stringify(output)}, data));\n`);
  const speech = streamSpeech(resolveConfig({ tts: true, ttsEngine: "command", ttsCommand: `"${process.execPath}" "${script}"` }));
  speech.write("Первое слово ");
  await expect.poll(async () => readFile(output, "utf8").catch(() => ""), { timeout: 2000 }).toBe("Первое слово ");
  speech.write("и продолжение.");
  speech.end();
  await speech.finished;
  expect(await readFile(output, "utf8")).toBe("Первое слово и продолжение.");
});

it("honors the configured character limit without splitting or accepting later words", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-limit-"));
  directories.push(directory);
  const output = `${directory}/received`;
  const script = `${directory}/reader.mjs`;
  await writeFile(script, `import { appendFileSync } from 'node:fs';\nprocess.stdin.on('data', data => appendFileSync(${JSON.stringify(output)}, data));\n`);
  const speech = streamSpeech(resolveConfig({ tts: true, ttsEngine: "command", ttsMaxChars: 10,
    ttsCommand: `"${process.execPath}" "${script}"` }));
  speech.write("Hello ");
  speech.write("world ");
  speech.write("ignored");
  speech.end();
  await speech.finished;
  expect(await readFile(output, "utf8")).toBe("Hello ");
});
