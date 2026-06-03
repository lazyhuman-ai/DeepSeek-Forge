import { describe, it, expect, afterEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { memorySearchTool } from "../src/tools/built-in/memory-search.js";
import type { ModelMessage, ModelProvider, ToolDefinition } from "../src/index.js";

const DATA_DIR = ".forge/test-memory-manager";

afterEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("MemoryManager", () => {
  it("extracts proposals after a turn and consolidates them into active memory", async () => {
    const calls: Array<{ messages: ModelMessage[]; tools?: ToolDefinition[] | undefined }> = [];
    const provider: ModelProvider = {
      generate: vi.fn().mockImplementation(async (messages: ModelMessage[], tools?: ToolDefinition[]) => {
        calls.push({ messages, tools });
        if (calls.length === 1) {
          return { text: "Turn done", finishReason: "stop" };
        }
        if (calls.length === 2) {
          return {
            text: `\`\`\`json\n${JSON.stringify({
              proposals: [
                {
                  type: "project",
                  title: "Readable tool errors",
                  content: "Tool errors should flow back to the agent as readable tool_result text.",
                  tags: ["errors", "architecture"],
                  reason: "Stable project design decision.",
                },
              ],
            })}\n\`\`\``,
            finishReason: "stop",
          };
        }
        const payload = JSON.parse(calls[2]!.messages[1]!.content) as {
          proposals: Array<{ id: string }>;
        };
        return {
          text: `\`\`\`json\n${JSON.stringify({
            operations: [
              {
                action: "promote",
                proposalId: payload.proposals[0]!.id,
              },
            ],
          })}\n\`\`\``,
          finishReason: "stop",
        };
      }),
    };

    const api = new CoreAPI(new ToolRegistry(), { dataDir: DATA_DIR });
    api.setModelProvider(provider);
    api.initMemoryManager({ autoRun: false });

    const session = api.createSession("memory");
    api.appendUserMessage(session.id, "Remember our design decision", { dispatch: false });
    await api.runTurn(session.id);

    expect(api.getSession(session.id)!.status).toBe("idle");
    expect(api.getMemoryStatus().queuedExtractions).toBe(1);

    const report = await api.runMemoryMaintenance({ consolidate: true });

    expect(report.extractedProposals).toBe(1);
    expect(report.promoted).toBe(1);
    expect(calls[1]!.tools).toBeUndefined();
    expect(calls[2]!.tools).toBeUndefined();

    const search = await memorySearchTool.handler({ query: "tool errors" }, session.id);
    expect(search).toContain("Readable tool errors");
  });

  it("degrades on extractor failure without blocking the foreground session", async () => {
    const provider: ModelProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce({ text: "Done", finishReason: "stop" })
        .mockResolvedValueOnce({ text: "not json", finishReason: "stop" }),
    };

    const api = new CoreAPI(new ToolRegistry(), { dataDir: DATA_DIR });
    api.setModelProvider(provider);
    api.initMemoryManager({ autoRun: false, baseDelayMs: 10_000, jitterMs: 0 });

    const session = api.createSession("memory failure");
    api.appendUserMessage(session.id, "extract this", { dispatch: false });
    await api.runTurn(session.id);

    const report = await api.runMemoryMaintenance();

    expect(report.error).toContain("Unexpected token");
    expect(api.getSession(session.id)!.status).toBe("idle");
    expect(api.getMemoryStatus().state).toBe("degraded");
    const runtimeEvent = api.getThread(session.id).find((event) =>
      event.type === "runtime_event" && event.runtimeKind === "memory"
    );
    expect(runtimeEvent?.type).toBe("runtime_event");
    if (runtimeEvent?.type === "runtime_event") {
      expect(runtimeEvent.detail).toBe("degraded");
      expect(runtimeEvent.message).toContain("Memory runtime degraded");
    }
    expect(api.getSystemEvents().some((event) => event.detail === "memory_degraded")).toBe(true);
  });
});
