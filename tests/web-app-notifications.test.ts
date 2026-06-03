import { describe, expect, it } from "vitest";
import {
  isNativeNotificationEvent,
  nativeNotificationForEvent,
} from "../web/src/notifications.js";
import type { SessionEvent } from "../web/src/types.js";

function event<T extends SessionEvent>(value: T): T {
  return value;
}

describe("web native notifications", () => {
  it("notifies for user-actionable and final agent events", () => {
    const events: SessionEvent[] = [
      event({ type: "assistant_message", seq: 1, timestamp: "t", text: "done" }),
      event({
        type: "permission_request",
        seq: 2,
        timestamp: "t",
        permissionRequestId: "p1",
        toolName: "bash",
        action: "process.exec",
        subject: "npm test",
        message: "ForgeAgent needs approval.",
        reason: "Process execution requires approval.",
        status: "pending",
        expiresAt: "t",
      }),
      event({
        type: "mcp_elicitation_request",
        seq: 3,
        timestamp: "t",
        elicitationId: "e1",
        serverId: "srv",
        serverName: "mcp",
        message: "MCP server needs input.",
        status: "pending",
        expiresAt: "t",
      }),
      event({
        type: "runtime_event",
        seq: 4,
        timestamp: "t",
        runtimeKind: "provider",
        detail: "blocked",
        message: "Session blocked: provider failed.",
      }),
    ];

    for (const item of events) {
      expect(isNativeNotificationEvent(item)).toBe(true);
      expect(nativeNotificationForEvent("s1", item)?.tag).toBe(`forgeagent:s1:${item.seq}`);
    }
  });

  it("does not notify for streaming, tool, usage, or non-blocking runtime events", () => {
    const events: SessionEvent[] = [
      event({ type: "assistant_delta", seq: 1, timestamp: "t", text: "partial" }),
      event({ type: "tool_call", seq: 2, timestamp: "t", toolName: "bash", args: {} }),
      event({ type: "tool_result", seq: 3, timestamp: "t", toolName: "bash", result: "ok", isError: false }),
      event({
        type: "usage_event",
        seq: 4,
        timestamp: "t",
        provider: "deepseek",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimated: false,
        message: "usage",
      }),
      event({
        type: "context_usage_event",
        seq: 5,
        timestamp: "t",
        source: "local_estimate",
        inputTokens: 1,
        contextWindowTokens: 100,
        contextUsedPercent: 1,
        estimated: true,
        message: "context",
      }),
      event({
        type: "runtime_event",
        seq: 6,
        timestamp: "t",
        runtimeKind: "browser",
        detail: "attached",
        message: "Browser attached.",
      }),
    ];

    for (const item of events) {
      expect(isNativeNotificationEvent(item)).toBe(false);
      expect(nativeNotificationForEvent("s1", item)).toBeNull();
    }
  });
});
