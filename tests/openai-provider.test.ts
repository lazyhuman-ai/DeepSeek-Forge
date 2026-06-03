import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "../src/agent/openai-provider.js";
import type { ToolDefinition } from "../src/tools/schemas.js";

const sampleTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file from the filesystem",
  params: {
    path: { type: "string", description: "Path to the file" },
  },
};

describe("OpenAIProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchResponse(status: number, data: unknown) {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      text: async () => JSON.stringify(data),
      json: async () => data,
    });
  }

  it("sends messages to the API and returns text response", async () => {
    mockFetchResponse(200, {
      choices: [
        {
          message: { role: "assistant", content: "Hello, user!" },
          finish_reason: "stop",
        },
      ],
    });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "test-key",
      model: "test-model",
    });

    const response = await provider.generate([
      { role: "user", content: "Hi!" },
    ]);

    expect(response.text).toBe("Hello, user!");
    expect(response.finishReason).toBe("stop");
    expect(response.toolCalls).toBeUndefined();

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://test.api.com/v1/chat/completions");
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "Hi!" }]);
    expect(call[1].headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
  });

  it("parses tool_calls from response", async () => {
    mockFetchResponse(200, {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"/etc/hosts"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
    });

    const response = await provider.generate([
      { role: "user", content: "Read hosts file" },
    ]);

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0]!.name).toBe("read_file");
    expect(response.toolCalls![0]!.args).toEqual({ path: "/etc/hosts" });
  });

  it("includes tools in request body", async () => {
    mockFetchResponse(200, {
      choices: [
        {
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
    });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
    });

    await provider.generate([{ role: "user", content: "x" }], [sampleTool]);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from the filesystem",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the file" },
            },
            required: ["path"],
          },
        },
      },
    ]);
  });

  it("does not include tools key when tools array is empty", async () => {
    mockFetchResponse(200, {
      choices: [
        {
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
    });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
    });

    await provider.generate([{ role: "user", content: "x" }], []);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.tools).toBeUndefined();
  });

  it("throws on non-ok API response", async () => {
    mockFetchResponse(401, { error: "Unauthorized" });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "bad-key",
      model: "m",
    });

    await expect(
      provider.generate([{ role: "user", content: "x" }]),
    ).rejects.toThrow("API error 401");
  });

  it("throws when response has no choices", async () => {
    mockFetchResponse(200, { choices: [] });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
    });

    await expect(
      provider.generate([{ role: "user", content: "x" }]),
    ).rejects.toThrow("No choices in API response");
  });

  it("handles multiple tool calls in one response", async () => {
    mockFetchResponse(200, {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_a",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"/a"}',
                },
              },
              {
                id: "call_b",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"/b"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
    });

    const response = await provider.generate([
      { role: "user", content: "Read both files" },
    ]);

    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls![0]!.args).toEqual({ path: "/a" });
    expect(response.toolCalls![1]!.args).toEqual({ path: "/b" });
  });

  it("uses environment variables when no options provided", async () => {
    vi.stubEnv("BASE_URL", "https://env.api.com");
    vi.stubEnv("API_KEY", "env-key");
    vi.stubEnv("LLM_MODEL", "env-model");

    mockFetchResponse(200, {
      choices: [
        {
          message: { role: "assistant", content: "env response" },
          finish_reason: "stop",
        },
      ],
    });

    const provider = new OpenAIProvider();
    await provider.generate([{ role: "user", content: "x" }]);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://env.api.com/v1/chat/completions");
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe("env-model");
    expect(call[1].headers).toMatchObject({
      Authorization: "Bearer env-key",
    });
  });

  it("returns empty text when content is null and finish is stop", async () => {
    mockFetchResponse(200, {
      choices: [
        {
          message: { role: "assistant", content: null },
          finish_reason: "stop",
        },
      ],
    });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
    });

    const response = await provider.generate([
      { role: "user", content: "x" },
    ]);

    expect(response.text).toBe("");
    expect(response.finishReason).toBe("stop");
  });

  it("handles nested tool parameters", async () => {
    const complexTool: ToolDefinition = {
      name: "search",
      description: "Search for items",
      params: {
        query: { type: "string", description: "Search query" },
        filters: {
          type: "object",
          description: "Search filters",
          properties: {
            category: { type: "string", description: "Category filter" },
            price: { type: "number", description: "Max price" },
          },
        },
        tags: {
          type: "array",
          description: "Tags to filter by",
          items: { type: "string", description: "A tag" },
        },
      },
    };

    mockFetchResponse(200, {
      choices: [
        {
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
    });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
    });

    await provider.generate([{ role: "user", content: "search" }], [complexTool]);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    const converted = body.tools[0].function.parameters;

    expect(converted.properties.filters.properties.category.type).toBe("string");
    expect(converted.properties.tags.items.type).toBe("string");
  });

  it("omits optional tool parameters from the required list", async () => {
    const searchTool: ToolDefinition = {
      name: "search",
      description: "Search docs",
      params: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Maximum results", optional: true },
      },
    };

    mockFetchResponse(200, {
      choices: [
        {
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
    });

    const provider = new OpenAIProvider({
      baseUrl: "https://test.api.com",
      apiKey: "k",
      model: "m",
    });

    await provider.generate([{ role: "user", content: "search" }], [searchTool]);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.tools[0].function.parameters.required).toEqual(["query"]);
  });
});
