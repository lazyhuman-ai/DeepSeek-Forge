import { describe, it, expect, beforeEach, vi } from "vitest";
import { CoreAPI } from "../../src/core/core-api.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { ModelProvider, ModelMessage } from "../../src/agent/model-provider.js";

describe("Error Recovery Integration", () => {
  let api: CoreAPI;

  beforeEach(() => {
    const registry = new ToolRegistry();
    api = new CoreAPI(registry, { dataDir: ".forge-test-error-int" });
    api.initSupervisor();
    api.initScheduler();
  });

  it("session transitions to blocked on unrecoverable model failure", async () => {
    const provider: ModelProvider = {
      generate: vi.fn().mockRejectedValue(new Error("Fatal API error: 500 Internal Server Error")),
    };
    api.setModelProvider(provider);

    const session = api.createSession("blocked test");
    api.appendUserMessage(session.id, "test", { dispatch: false });

    await expect(api.runTurn(session.id)).rejects.toThrow("Fatal API error");

    const updated = api.getSession(session.id);
    expect(updated!.status).toBe("blocked");

    const thread = api.getThread(session.id);
    expect(thread[1]!.type).toBe("runtime_event");
    if (thread[1]!.type === "runtime_event") {
      expect(thread[1]!.runtimeKind).toBe("model_provider");
      expect(thread[1]!.detail).toBe("failed");
      expect(thread[1]!.message).toContain("Fatal API error");
    }
    expect(api.getSystemEvents().some((e) => (
      e.detail === "blocked" &&
      e.message.includes("Fatal API error")
    ))).toBe(true);
  });

  it("blocked session stays blocked until runtime recovers", async () => {
    const provider: ModelProvider = {
      generate: vi.fn().mockRejectedValue(new Error("API down")),
    };
    api.setModelProvider(provider);

    const session = api.createSession("recovery test");
    api.appendUserMessage(session.id, "test", { dispatch: false });

    await expect(api.runTurn(session.id)).rejects.toThrow("API down");
    expect(api.getSession(session.id)!.status).toBe("blocked");

    // Attempting to dispatch a blocked session should not run
    api.dispatchTurn(session.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(api.getSession(session.id)!.status).toBe("blocked");

    // Thread should still contain the user message
    const thread = api.getThread(session.id);
    expect(thread[0]!.type).toBe("user_message");
    expect(thread[1]!.type).toBe("runtime_event");
    if (thread[1]!.type === "runtime_event") {
      expect(thread[1]!.message).toContain("API down");
    }
  });

  it("records agent-loop tool_failure reason before blocking", async () => {
    const provider: ModelProvider = {
      generate: vi.fn().mockResolvedValue({
        text: "",
        finishReason: "tool_calls",
        toolCalls: [],
      }),
    };
    api.setModelProvider(provider);

    const session = api.createSession("protocol failure test");
    api.appendUserMessage(session.id, "test", { dispatch: false });

    const updated = await api.runTurn(session.id);
    expect(updated.status).toBe("blocked");

    const thread = api.getThread(session.id);
    expect(thread[1]!.type).toBe("runtime_event");
    if (thread[1]!.type === "runtime_event") {
      expect(thread[1]!.runtimeKind).toBe("agent_loop");
      expect(thread[1]!.detail).toBe("failed");
      expect(thread[1]!.message).toContain("Model requested tool calls");
    }
    expect(api.getSystemEvents().some((e) => (
      e.detail === "blocked" &&
      e.message.includes("Model requested tool calls")
    ))).toBe(true);
  });

  it("records compaction failure before blocking", async () => {
    const provider: ModelProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce({ text: "first done", finishReason: "stop" })
        .mockResolvedValueOnce({
          text: "second done",
          finishReason: "stop",
          rawUsage: { input_tokens: 95_000, output_tokens: 10 },
        })
        .mockRejectedValueOnce(new Error("summary model unavailable")),
    };
    api.setModelProvider(provider);

    const session = api.createSession("compaction failure test");
    api.appendUserMessage(session.id, "first", { dispatch: false });
    await api.runTurn(session.id);
    expect(api.getSession(session.id)!.status).toBe("idle");

    api.appendUserMessage(session.id, "x".repeat(90_000), { dispatch: false });
    const updated = await api.runTurn(session.id);

    expect(updated.status).toBe("blocked");
    const thread = api.getThread(session.id);
    const runtimeEvent = thread.find((e) => e.type === "runtime_event");
    expect(runtimeEvent?.type).toBe("runtime_event");
    if (runtimeEvent?.type === "runtime_event") {
      expect(runtimeEvent.runtimeKind).toBe("compaction");
      expect(runtimeEvent.detail).toBe("failed");
      expect(runtimeEvent.message).toContain("summary model unavailable");
    }
    expect(api.getSystemEvents().some((e) => (
      e.detail === "blocked" &&
      e.message.includes("summary model unavailable")
    ))).toBe(true);
  });
});
