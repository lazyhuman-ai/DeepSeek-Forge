import { describe, it, expect } from "vitest";
import { buildContext } from "../src/agent/context-window-builder.js";
import type {
  UserMessage,
  AssistantMessage,
  ToolCall,
  ToolResult,
  TriggerEvent,
  RuntimeEvent,
  ArtifactPointer,
  CompactionBlock,
  ContextUsageEvent,
} from "../src/streams/event-types.js";

const sid = "s1";
const ts = new Date().toISOString();

describe("ContextWindowBuilder", () => {
  it("maps user_message to user role", () => {
    const event: UserMessage = { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "hello" };
    const msgs = buildContext([event]);
    expect(msgs).toEqual([{ role: "user", content: "hello" }]);
  });

  it("maps assistant_message to assistant role", () => {
    const event: AssistantMessage = { type: "assistant_message", seq: 1, timestamp: ts, sessionId: sid, text: "hi there" };
    const msgs = buildContext([event]);
    expect(msgs).toEqual([{ role: "assistant", content: "hi there" }]);
  });

  it("maps tool_call to assistant with tool_calls", () => {
    const event: ToolCall = { type: "tool_call", seq: 3, timestamp: ts, sessionId: sid, toolName: "read_file", args: { path: "/tmp" } };
    const msgs = buildContext([event]);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.content).toBe("");
    expect(msgs[0]!.tool_calls).toEqual([{ id: "call_3", name: "read_file", args: { path: "/tmp" } }]);
    expect(msgs[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_3",
    });
    expect(msgs[1]!.content).toContain("Tool result missing from durable thread");
  });

  it("maps tool_result to tool role", () => {
    const event: ToolResult = { type: "tool_result", seq: 4, timestamp: ts, sessionId: sid, toolName: "read_file", result: "file contents", isError: false };
    const msgs = buildContext([event]);
    expect(msgs[0]!.role).toBe("tool");
    expect(msgs[0]!.content).toBe("file contents");
  });

  it("maps compaction_block to system role", () => {
    const event: CompactionBlock = { type: "compaction_block", seq: 1, timestamp: ts, sessionId: sid, coversEvents: [1, 120], summary: "User discussed architecture" };
    const msgs = buildContext([event]);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("events #1-#120");
    expect(msgs[0]!.content).toContain("historical handoff summary");
    expect(msgs[0]!.content).toContain("source of truth");
    expect(msgs[0]!.content).toContain("User discussed architecture");
  });

  it("maps trigger_event to system role", () => {
    const event: TriggerEvent = { type: "trigger_event", seq: 1, timestamp: ts, sessionId: sid, triggerKind: "webhook", payload: { url: "x" } };
    const msgs = buildContext([event]);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("[Trigger: webhook]");
  });

  it("maps runtime_event to system role", () => {
    const event: RuntimeEvent = { type: "runtime_event", seq: 1, timestamp: ts, sessionId: sid, runtimeKind: "chrome", detail: "disconnected", message: "CDP lost" };
    const msgs = buildContext([event]);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("[Runtime: chrome disconnected]");
    expect(msgs[0]!.content).toContain("CDP lost");
  });

  it("maps artifact_pointer to system role", () => {
    const event: ArtifactPointer = { type: "artifact_pointer", seq: 1, timestamp: ts, sessionId: sid, artifactId: "a1", mimeType: "image/png", sizeBytes: 1024 };
    const msgs = buildContext([event]);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("[Artifact: a1");
    expect(msgs[0]!.content).toContain("image/png");
  });

  it("keeps provider tool_call/tool_result messages adjacent when runtime events are interleaved", () => {
    const toolCall: ToolCall = {
      type: "tool_call",
      seq: 1,
      timestamp: ts,
      sessionId: sid,
      toolName: "browser_create_tab",
      args: {},
      toolUseId: "tc_browser",
    };
    const runtimeEvent: RuntimeEvent = {
      type: "runtime_event",
      seq: 2,
      timestamp: ts,
      sessionId: sid,
      runtimeKind: "chrome",
      detail: "attached",
      message: "Runtime chrome attached",
    };
    const toolResult: ToolResult = {
      type: "tool_result",
      seq: 3,
      timestamp: ts,
      sessionId: sid,
      toolName: "browser_create_tab",
      result: "created",
      isError: false,
      toolUseId: "tc_browser",
    };

    const msgs = buildContext([toolCall, runtimeEvent, toolResult]);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.tool_calls?.[0]?.id).toBe("tc_browser");
    expect(msgs[1]).toEqual({
      role: "tool",
      content: "created",
      tool_call_id: "tc_browser",
    });
    expect(msgs[2]!.role).toBe("system");
    expect(msgs[2]!.content).toContain("Runtime chrome attached");
  });

  it("compacts old large tool results while preserving recent tool results", () => {
    const oldLarge = "old-output-".repeat(2_000);
    const recentLarge = "recent-output-".repeat(2_000);
    const events: ToolResult[] = [
      {
        type: "tool_result",
        seq: 10,
        timestamp: ts,
        sessionId: sid,
        toolName: "bash",
        result: oldLarge,
        isError: false,
        toolUseId: "old",
      },
      {
        type: "tool_result",
        seq: 11,
        timestamp: ts,
        sessionId: sid,
        toolName: "read_file",
        result: recentLarge,
        isError: false,
        toolUseId: "recent",
      },
    ];

    const msgs = buildContext(events, {
      maxToolResultChars: 1_200,
      preserveRecentToolResults: 1,
    });

    expect(msgs[0]!.content).toContain("<compacted-tool-result>");
    expect(msgs[0]!.content).toContain("Original length");
    expect(msgs[0]!.content.length).toBeLessThan(oldLarge.length);
    expect(msgs[1]!.content).toBe(recentLarge);
  });

  it("does not render local context usage estimates into model context", () => {
    const event: ContextUsageEvent = {
      type: "context_usage_event",
      seq: 1,
      timestamp: ts,
      sessionId: sid,
      source: "local_estimate",
      reason: "post_compaction",
      inputTokens: 42,
      contextWindowTokens: 1000,
      contextUsedPercent: 4.2,
      estimated: true,
      message: "Local compacted context estimate · ctx ~4.2% · in ~42",
    };
    expect(buildContext([event])).toEqual([]);
  });

  it("builds full conversation from multiple events", () => {
    const events = [
      { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "hello" } as UserMessage,
      { type: "assistant_message", seq: 2, timestamp: ts, sessionId: sid, text: "hi!" } as AssistantMessage,
      { type: "user_message", seq: 3, timestamp: ts, sessionId: sid, text: "read /tmp" } as UserMessage,
    ] as const;
    const msgs = buildContext([...events]);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[2]!.role).toBe("user");
  });

  it("returns empty array for no events", () => {
    expect(buildContext([])).toEqual([]);
  });
});
