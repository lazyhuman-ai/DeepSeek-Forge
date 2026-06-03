import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicProvider } from "../src/agent/anthropic-provider.js";
import type { ToolDefinition } from "../src/tools/schemas.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "Evaluate a math expression",
  params: {
    expression: { type: "string", description: "Expression to evaluate" },
  },
};

describe("AnthropicProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses streaming tool_use blocks across chunk boundaries", async () => {
    const chunks = [
      'event: message_start\n',
      'data: {"message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      'event: content_block_start\n',
      'data: {"index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"calculator","input":{}}}\n\n',
      'event: content_block_delta\n',
      'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"expression\\""}}\n\n',
      'event: content_block_delta\n',
      'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":":\\"2+2\\"}"}}\n\n',
      'event: content_block_stop\n',
      'data: {"index":0}\n\n',
      'event: message_delta\n',
      'data: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}\n\n',
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: streamFromChunks(chunks),
    }));

    const provider = new AnthropicProvider({
      baseUrl: "https://test.api.com/",
      apiKey: "k",
      model: "m",
    });

    const response = await provider.generate(
      [{ role: "user", content: "calculate" }],
      [calculatorTool],
      { onToken: vi.fn() },
    );

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      {
        id: "toolu_1",
        name: "calculator",
        args: { expression: "2+2" },
      },
    ]);
    expect(response.rawContent).toEqual([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "calculator",
        input: { expression: "2+2" },
      },
    ]);
  });

  it("renders synthetic historical tool calls as readable text instead of Anthropic tool_use blocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
    });

    await provider.generate([
      { role: "user", content: "resume" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "dangling", name: "bash", args: { command: "npm test" } }],
      },
      {
        role: "tool",
        content: "Process restarted before this tool completed.",
        tool_call_id: "dangling",
      },
    ]);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    const serialized = JSON.stringify(body.messages);
    expect(serialized).toContain("Historical tool call reference");
    expect(serialized).toContain("Historical tool result reference");
    expect(serialized).not.toContain("\"tool_use\"");
    expect(serialized).not.toContain("\"tool_result\"");
  });

  it("rejects when the API request times out after retries exhausted", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }));

    const provider = new AnthropicProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
      requestTimeoutMs: 10,
      maxRetries: 0,
    });

    await expect(
      provider.generate([{ role: "user", content: "hello" }]),
    ).rejects.toThrow("API request timed out after 10ms");
  }, 10000);
});
