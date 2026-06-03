import { describe, it, expect, vi } from "vitest";
import {
  COMPACTION_SYSTEM_PROMPT,
  compact,
  serializeEventsForCompaction,
} from "../src/agent/compactor.js";
import type { ModelProvider, ModelResponse, ModelMessage } from "../src/agent/model-provider.js";
import type { AssistantMessage, ToolCall, ToolResult, UserMessage } from "../src/streams/event-types.js";

const sid = "s1";
const ts = "2025-01-01T00:00:00.000Z";

function makeProvider(response: ModelResponse | Error): ModelProvider {
  return {
    generate: vi.fn().mockImplementation(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  };
}

describe("Compactor", () => {
  it("calls the model without tools and creates a compaction block", async () => {
    const events: UserMessage[] = [
      { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "read file" },
      { type: "user_message", seq: 2, timestamp: ts, sessionId: sid, text: "run tests" },
    ];
    const provider = makeProvider({
      text: "## Active Task\nNone.\n\n## Critical Context\nTests passed.",
      finishReason: "stop",
    });

    const block = await compact({
      events,
      seq: 100,
      sessionId: sid,
      modelProvider: provider,
      timestamp: ts,
    });

    expect(block.type).toBe("compaction_block");
    expect(block.coversEvents).toEqual([1, 2]);
    expect(block.seq).toBe(100);
    expect(block.timestamp).toBe(ts);
    expect(block.summary).toContain("## Active Task");

    expect(provider.generate).toHaveBeenCalledTimes(1);
    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const messages = call[0] as ModelMessage[];
    expect(call[1]).toBeUndefined();
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("Do NOT call any tools");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("## Active Task");
    expect(messages[1]!.content).toContain("## Errors and Fixes");
    expect(messages[1]!.content).toContain("latest user message");
    expect(messages[1]!.content).toContain("[REDACTED]");
  });

  it("uses structured prompt guidance based on source projects", () => {
    expect(COMPACTION_SYSTEM_PROMPT).toContain("historical reference");
    expect(COMPACTION_SYSTEM_PROMPT).toContain("latest user message");
    expect(COMPACTION_SYSTEM_PROMPT).toContain("Do not invent facts");
  });

  it("serializes tool calls and tool errors for the summarizer", () => {
    const events: Array<UserMessage | AssistantMessage | ToolCall | ToolResult> = [
      { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "use tool" },
      {
        type: "tool_call",
        seq: 2,
        timestamp: ts,
        sessionId: sid,
        toolName: "bash",
        args: { cmd: "npm test" },
        toolUseId: "tc1",
      },
      {
        type: "tool_result",
        seq: 3,
        timestamp: ts,
        sessionId: sid,
        toolName: "bash",
        result: "failed: missing file",
        isError: true,
        toolUseId: "tc1",
      },
      { type: "assistant_message", seq: 4, timestamp: ts, sessionId: sid, text: "I will fix it." },
    ];

    const transcript = serializeEventsForCompaction(events);

    expect(transcript).toContain("[assistant tool_call #2 id=tc1 name=bash]");
    expect(transcript).toContain('"cmd": "npm test"');
    expect(transcript).toContain("[tool_result #3 id=tc1 name=bash isError=true]");
    expect(transcript).toContain("failed: missing file");
  });

  it("throws when provider fails instead of using heuristic fallback", async () => {
    const provider = makeProvider(new Error("summary provider failed"));
    const events: UserMessage[] = [
      { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "hello" },
    ];

    await expect(compact({
      events,
      seq: 10,
      sessionId: sid,
      modelProvider: provider,
      timestamp: ts,
    })).rejects.toThrow("summary provider failed");
  });

  it("throws when the model returns an empty summary", async () => {
    const provider = makeProvider({ text: "  \n", finishReason: "stop" });
    const events: UserMessage[] = [
      { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "hello" },
    ];

    await expect(compact({
      events,
      seq: 10,
      sessionId: sid,
      modelProvider: provider,
      timestamp: ts,
    })).rejects.toThrow("empty summary");
  });

  it("throws when the model attempts tool calls during compaction", async () => {
    const provider = makeProvider({
      text: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "tc1", name: "read", args: {} }],
    });
    const events: UserMessage[] = [
      { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "hello" },
    ];

    await expect(compact({
      events,
      seq: 10,
      sessionId: sid,
      modelProvider: provider,
      timestamp: ts,
    })).rejects.toThrow("attempted to call tools");
  });

  it("throws when required provider usage is missing", async () => {
    const provider = makeProvider({ text: "summary", finishReason: "stop" });
    const events: UserMessage[] = [
      { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "hello" },
    ];

    await expect(compact({
      events,
      seq: 10,
      sessionId: sid,
      modelProvider: provider,
      timestamp: ts,
      requireUsage: true,
    })).rejects.toThrow("requires real prompt token telemetry");
  });

  it("throws on empty event list", async () => {
    const provider = makeProvider({ text: "summary", finishReason: "stop" });

    await expect(compact({
      events: [],
      seq: 1,
      sessionId: sid,
      modelProvider: provider,
      timestamp: ts,
    })).rejects.toThrow("Cannot compact empty event list");
  });
});
