import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { rootSession } from "./fixtures/session.js";

function makeCtx() {
  const commands: { name: string; execute: (input: any) => Promise<void> }[] = [];
  const ctx: any = {
    command: {
      transform: async (fn: (editor: any) => void) => {
        fn({ add: (def: any) => commands.push(def) });
      },
    },
    session: {
      prompt: async () => ({ id: "msg_1" }),
      get: async ({ sessionID }: { sessionID: string }) => ({ ...rootSession(sessionID), title: "demo" }),
      interrupt: async () => {},
    },
    event: {
      subscribe: async function* () {},
    },
  };
  return { ctx, commands };
}

async function run(name: string, text: string): Promise<string> {
  const { ctx, commands } = makeCtx();
  const cleanup = await (plugin as any).setup(ctx);
  try {
    const cmd = commands.find((c) => c.name === name)!;
    expect(cmd).toBeDefined();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
    try {
      await cmd.execute({ sessionID: "ses_1", prompt: { text }, delivery: "steer" });
    } finally {
      spy.mockRestore();
    }
    return logs.join("\n");
  } finally {
    await cleanup?.();
  }
}

describe("/mic status", () => {
  it("reports idle state and backend without recording", async () => {
    const out = await run("mic", "/mic status");
    expect(out).toContain("mic status: idle");
    expect(out).toContain("backend:");
    expect(out).toContain("recorder:");
  });
});

describe("/mic off", () => {
  it("discards without sending anything", async () => {
    const { ctx, commands } = makeCtx();
    const cleanup = await (plugin as any).setup(ctx);
    try {
      const calls: unknown[] = [];
      (ctx as any).session.prompt = async (input: unknown) => {
        calls.push(input);
        return { id: "msg_1" };
      };
      const cmd = commands.find((c) => c.name === "mic")!;
      await cmd.execute({ sessionID: "ses_1", prompt: { text: "/mic off" }, delivery: "steer" });
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup?.();
    }
  });
});

describe("/sound status", () => {
  it("reports tts switch, engine and voices", async () => {
    const out = await run("sound", "/sound status");
    expect(out).toMatch(/sound status: (on|off)/);
    expect(out).toContain("engine");
    expect(out).toContain("voices:");
  });
});
