import type { SessionApi } from "@opencode/client/promise/api"

type SessionInfo = Awaited<ReturnType<SessionApi["get"]>>

export const rootSession = (id: string): SessionInfo => ({
  id, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, location: { directory: "/offline-session-fixture" },
})
