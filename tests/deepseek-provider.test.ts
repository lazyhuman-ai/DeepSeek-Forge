import { describe, it, expect, vi, afterEach } from "vitest";
import { DeepSeekProvider } from "../src/agent/deepseek-provider.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function streamThatErrors(chunks: string[], error: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.error(error);
    },
  });
}

function streamThatErrorsAfterReadingChunks(chunks: string[], error: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]!));
        return;
      }
      controller.error(error);
    },
  });
}

describe("DeepSeekProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests streaming usage and parses DeepSeek cache and reasoning usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: streamFromChunks([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":200,"total_tokens":1200,"prompt_cache_hit_tokens":900,"prompt_cache_miss_tokens":100,"completion_tokens_details":{"reasoning_tokens":75}}}\n\n',
        "data: [DONE]\n\n",
      ]),
      status: 200,
      statusText: "OK",
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new DeepSeekProvider({
      baseUrl: "https://deepseek.test",
      apiKey: "k",
      model: "deepseek-v4-pro",
    });
    const onToken = vi.fn();
    const response = await provider.generate(
      [{ role: "user", content: "hello" }],
      undefined,
      { onToken },
    );

    expect(response.text).toBe("done");
    expect(onToken).toHaveBeenCalledWith("done");
    expect(response.reasoningContent).toBe("thinking");
    expect(response.rawUsage).toEqual({
      input_tokens: 1000,
      output_tokens: 200,
      total_tokens: 1200,
      cache_hit_tokens: 900,
      cache_miss_tokens: 100,
      reasoning_tokens: 75,
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("derives cache miss from nested cached tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 1,
          total_tokens: 1001,
          prompt_tokens_details: { cached_tokens: 600 },
        },
      }),
    }));

    const provider = new DeepSeekProvider({ baseUrl: "https://deepseek.test", apiKey: "k", model: "m" });
    const response = await provider.generate([{ role: "user", content: "hello" }]);

    expect(response.rawUsage?.cache_hit_tokens).toBe(600);
    expect(response.rawUsage?.cache_miss_tokens).toBe(400);
  });

  it("sends historical reasoning_content back to DeepSeek when context requires it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new DeepSeekProvider({ baseUrl: "https://deepseek.test", apiKey: "k", model: "m" });
    await provider.generate([
      { role: "assistant", content: "previous", reasoning_content: "thinking trace to resend" },
      { role: "user", content: "continue" },
    ]);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.messages[0]).toMatchObject({
      role: "assistant",
      content: "previous",
      reasoning_content: "thinking trace to resend",
    });
  });

  it("adds a readable reasoning_content placeholder for recovered assistant tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new DeepSeekProvider({ baseUrl: "https://deepseek.test", apiKey: "k", model: "m" });
    await provider.generate([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc_1", name: "read_file", args: { file_path: "src/math.ts" } }],
      },
      { role: "tool", content: "Process restarted before this tool completed.", tool_call_id: "tc_1" },
      { role: "user", content: "continue" },
    ]);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.messages[0]).toMatchObject({
      role: "assistant",
      reasoning_content: "[reasoning_content unavailable in durable thread]",
    });
  });

  it("reports retry status through callbacks", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const statuses: string[] = [];
    const provider = new DeepSeekProvider({
      baseUrl: "https://deepseek.test",
      apiKey: "k",
      model: "m",
      maxRetries: 1,
    });
    const response = await provider.generate(
      [{ role: "user", content: "hello" }],
      undefined,
      { onStatus: (message) => statuses.push(message) },
    );

    expect(response.text).toBe("ok");
    expect(statuses).toEqual([
      "DeepSeek request failed (fetch failed); retrying in 1s (1/1).",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    randomSpy.mockRestore();
  });

  it("retries a streaming body termination before any visible token is emitted", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: streamThatErrors([], new Error("terminated")),
        status: 200,
        statusText: "OK",
      })
      .mockResolvedValueOnce({
        ok: true,
        body: streamFromChunks([
          'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n',
          "data: [DONE]\n\n",
        ]),
        status: 200,
        statusText: "OK",
      });
    vi.stubGlobal("fetch", fetchMock);

    const statuses: string[] = [];
    const onToken = vi.fn();
    const provider = new DeepSeekProvider({
      baseUrl: "https://deepseek.test",
      apiKey: "k",
      model: "m",
      maxRetries: 1,
    });
    const response = await provider.generate(
      [{ role: "user", content: "hello" }],
      undefined,
      { onToken, onStatus: (message) => statuses.push(message) },
    );

    expect(response.text).toBe("recovered");
    expect(response.rawUsage).toEqual({ input_tokens: 12, output_tokens: 3, total_tokens: 15 });
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([
      "DeepSeek stream ended unexpectedly (terminated); retrying in 1s (1/1).",
    ]);
    randomSpy.mockRestore();
  });

  it("does not retry a streaming body termination after visible tokens were emitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: streamThatErrorsAfterReadingChunks([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      ], new Error("terminated")),
      status: 200,
      statusText: "OK",
    });
    vi.stubGlobal("fetch", fetchMock);

    const onToken = vi.fn();
    const provider = new DeepSeekProvider({
      baseUrl: "https://deepseek.test",
      apiKey: "k",
      model: "m",
      maxRetries: 1,
    });

    await expect(provider.generate(
      [{ role: "user", content: "hello" }],
      undefined,
      { onToken },
    )).rejects.toThrow("terminated");

    expect(onToken).toHaveBeenCalledWith("partial");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
