import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.js";

it("streams real delta events before ended, filters child/reasoning, and never replays ended", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-events-"));
  const previous = { config: process.env.XDG_CONFIG_HOME, tmp: process.env.TMPDIR };
  process.env.XDG_CONFIG_HOME = directory;
  process.env.TMPDIR = directory;
  const output = `${directory}/received`;
  const starts = `${directory}/starts`;
  const reader = `${directory}/reader.mjs`;
  await mkdir(`${directory}/opencode`);
  await writeFile(reader, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(starts)}, 'start\\n');\nprocess.stdin.on('data', data => appendFileSync(${JSON.stringify(output)}, data));\n`);
  await writeFile(`${directory}/opencode/voice.json`, JSON.stringify({
    tts: true, ttsStreaming: true, ttsEngine: "command", ttsCommand: `"${process.execPath}" "${reader}"`, ttsReasoning: false,
  }));
  let complete!: () => void;
  let fail!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const base = { sessionID: "root", assistantMessageID: `msg_${Date.now()}`, ordinal: 0 };
  const cleanup = await (plugin as any).setup({
    command: { transform: async () => {} },
    session: { get: async ({ sessionID }: any) => sessionID === "child" ? { parentID: "root" } : {} },
    event: { subscribe: async function* () {
      try {
        yield { type: "session.reasoning.ended", data: { ...base, text: "Не читать" } };
        yield { type: "session.text.delta", data: { ...base, sessionID: "child", delta: "Не читать " } };
        yield { type: "session.text.delta", data: { ...base, delta: "При" } };
        yield { type: "session.text.delta", data: { ...base, delta: "мер " } };
        // This assertion happens BEFORE a text.ended event exists.
        await expect.poll(async () => readFile(output, "utf8").catch(() => ""), { timeout: 3000 }).toBe("Пример ");
        yield { type: "session.text.delta", data: { ...base, delta: "работает." } };
        yield { type: "session.text.ended", data: { ...base, text: "Пример работает." } };
        yield { type: "session.text.ended", data: { ...base, text: "Пример работает." } };
        await expect.poll(async () => readFile(output, "utf8"), { timeout: 3000 }).toBe("Пример работает.");
        expect(await readFile(starts, "utf8")).toBe("start\n");
        complete();
      } catch (error) { fail(error); }
    } },
  });
  try {
    await finished;
  } finally {
    await cleanup?.();
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.tmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous.tmp;
    await rm(directory, { recursive: true, force: true });
  }
});
