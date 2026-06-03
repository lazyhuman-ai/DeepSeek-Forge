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

  it("does not send reasoning_content back to DeepSeek", async () => {
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
      { role: "assistant", content: "previous", reasoning_content: "do not resend" },
      { role: "user", content: "continue" },
    ]);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(JSON.stringify(body.messages)).not.toContain("reasoning_content");
    expect(JSON.stringify(body.messages)).not.toContain("do not resend");
  });
});
