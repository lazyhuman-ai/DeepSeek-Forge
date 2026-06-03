import { describe, it, expect, beforeEach, vi } from "vitest";
import { CoreAPI } from "../../src/core/core-api.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { ModelProvider, ModelResponse, ModelMessage } from "../../src/agent/model-provider.js";
import type { ToolExecutor } from "../../src/agent/tool-executor.js";

function makeProvider(responses: ModelResponse[]): ModelProvider {
  let i = 0;
  return {
    generate: vi.fn().mockImplementation(async (_msgs: ModelMessage[]) => {
      const r = responses[i];
      if (!r) throw new Error(`Unexpected generate call #${i}`);
      i++;
      return r;
    }),
  };
}

function makeExecutor(results: Array<{ output: unknown; isError: boolean }>): ToolExecutor {
  let i = 0;
  return {
    execute: vi.fn().mockImplementation(async (_name, _args, _sid) => {
      const r = results[i];
      if (!r) throw new Error(`Unexpected execute call #${i}`);
      i++;
      return r;
    }),
  };
}

describe("Full Turn Integration", () => {
  let api: CoreAPI;
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echoes the input",
      params: { text: { type: "string", description: "Text to echo" } },
      handler: async (args) => `Echo: ${args.text}`,
    });

    api = new CoreAPI(registry, { dataDir: ".forge-test-integration" });
    api.initSupervisor(2);
    api.initScheduler();
  });

  it("completes a full simple turn", async () => {
    const provider = makeProvider([
      { text: "Hello, World!", finishReason: "stop" },
    ]);
    api.setModelProvider(provider);

    const session = api.createSession("integration test");
    expect(session.status).toBe("idle");

    api.appendUserMessage(session.id, "Say hello", { dispatch: false });
    expect(api.getSession(session.id)!.status).toBe("running");

    const result = await api.runTurn(session.id);
    expect(result.status).toBe("idle");

    const thread = api.getThread(session.id);
    expect(thread).toHaveLength(2);
    expect(thread[0]!.type).toBe("user_message");
    expect(thread[1]!.type).toBe("assistant_message");
    if (thread[1]!.type === "assistant_message") {
      expect(thread[1]!.text).toBe("Hello, World!");
    }
  });

  it("executes a tool-call turn", async () => {
    const provider = makeProvider([
      {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "tc1", name: "echo", args: { text: "hello" } }],
      },
      { text: "I echoed hello", finishReason: "stop" },
    ]);
    api.setModelProvider(provider);

    const session = api.createSession("tool test");
    api.appendUserMessage(session.id, "echo hello", { dispatch: false });

    const result = await api.runTurn(session.id);
    expect(result.status).toBe("idle");

    const thread = api.getThread(session.id);
    expect(thread.length).toBeGreaterThanOrEqual(4);
    expect(thread[1]!.type).toBe("tool_call");
    expect(thread[2]!.type).toBe("tool_result");
    expect(thread[thread.length - 1]!.type).toBe("assistant_message");
  });

  it("transitions session through correct states during a turn", async () => {
    const provider = makeProvider([
      { text: "done", finishReason: "stop" },
    ]);
    api.setModelProvider(provider);

    const session = api.createSession("state test");
    expect(session.status).toBe("idle");

    const afterMsg = api.appendUserMessage(session.id, "go", { dispatch: false });
    expect(afterMsg.status).toBe("running");

    const afterTurn = await api.runTurn(session.id);
    expect(afterTurn.status).toBe("idle");
  });

  it("handles multiple concurrent sessions via supervisor", async () => {
    const provider = makeProvider([
      { text: "response 1", finishReason: "stop" },
      { text: "response 2", finishReason: "stop" },
    ]);
    api.setModelProvider(provider);

    const s1 = api.createSession("s1");
    const s2 = api.createSession("s2");

    api.appendUserMessage(s1.id, "msg1");
    api.appendUserMessage(s2.id, "msg2");

    // Wait for both turns to complete
    await new Promise((r) => setTimeout(r, 200));

    expect(api.getSession(s1.id)!.status).toBe("idle");
    expect(api.getSession(s2.id)!.status).toBe("idle");

    const t1 = api.getThread(s1.id);
    const t2 = api.getThread(s2.id);
    expect(t1).toHaveLength(2);
    expect(t2).toHaveLength(2);
    expect(t1[1]!.type).toBe("assistant_message");
    expect(t2[1]!.type).toBe("assistant_message");
  });

  it("handles tool execution failure gracefully", async () => {
    const provider = makeProvider([
      {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "tc1", name: "echo", args: { text: "x" } }],
      },
      { text: "I saw the tool error and recovered.", finishReason: "stop" },
    ]);
    api.setModelProvider(provider);

    // Override tool executor to simulate failure
    const executor = makeExecutor([
      { output: "something went wrong", isError: true },
    ]);
    api.setToolExecutor(executor);

    const session = api.createSession("error test");
    api.appendUserMessage(session.id, "test", { dispatch: false });

    const result = await api.runTurn(session.id);
    expect(result.status).toBe("idle");

    const thread = api.getThread(session.id);
    expect(thread.map((e) => e.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    expect(thread[2]!.type).toBe("tool_result");
    if (thread[2]!.type === "tool_result") {
      expect(thread[2]!.isError).toBe(true);
      expect(thread[2]!.result).toBe("something went wrong");
    }
    expect(thread[3]!.type).toBe("assistant_message");
    if (thread[3]!.type === "assistant_message") {
      expect(thread[3]!.text).toBe("I saw the tool error and recovered.");
    }
  });
});
