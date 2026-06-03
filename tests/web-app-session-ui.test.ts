import { describe, expect, it } from "vitest";
import { latestAgentResultSeq, sessionIndicator } from "../web/src/session-ui.js";
import type { Session, SessionEvent } from "../web/src/types.js";

const timestamp = "2026-06-02T00:00:00.000Z";

function session(input: Partial<Session>): Session {
  return {
    id: "s1",
    title: "Session",
    status: "idle",
    muted: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input,
  };
}

describe("web app session indicators", () => {
  it("does not show a green indicator for idle sessions", () => {
    expect(sessionIndicator(session({ status: "idle", unread: false }))).toBe("none");
  });

  it("uses a spinner for running sessions even if unread is true", () => {
    expect(sessionIndicator(session({ status: "running", unread: true }))).toBe("spinner");
  });

  it("uses a green unread indicator for completed agent results", () => {
    expect(sessionIndicator(session({ status: "idle", unread: true }))).toBe("unread");
  });

  it("counts assistant, permission, and blocked runtime events as agent result seq", () => {
    const events: SessionEvent[] = [
      { type: "user_message", seq: 1, timestamp, text: "hello" },
      { type: "tool_result", seq: 2, timestamp, toolName: "bash", result: "ok", isError: false },
      { type: "assistant_message", seq: 3, timestamp, text: "done" },
      {
        type: "permission_request",
        seq: 4,
        timestamp,
        permissionRequestId: "p1",
        toolName: "bash",
        action: "process.exec",
        subject: "npm test",
        message: "Approve?",
        reason: "Needs approval",
        status: "pending",
        expiresAt: timestamp,
      },
      { type: "runtime_event", seq: 5, timestamp, runtimeKind: "core", detail: "failed", message: "blocked" },
    ];

    expect(latestAgentResultSeq(session({ status: "idle" }), events)).toBe(4);
    expect(latestAgentResultSeq(session({ status: "blocked" }), events)).toBe(5);
  });
});
