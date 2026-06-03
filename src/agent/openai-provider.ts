import type { ModelProvider, ModelMessage, ModelProviderMetadata, ModelResponse, ModelUsage } from "./model-provider.js";
import type { ToolDefinition, ToolParamSchema } from "../tools/schemas.js";
import { createLogger } from "../core/logger.js";
import { loadEnv } from "../core/env.js";
import { fetchWithRetry, type RetryOptions } from "../core/http-client.js";

const logger = createLogger("openai-provider");
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("OpenAI request aborted");
    err.name = "AbortError";
    throw err;
  }
}

// Load .env at module import time
loadEnv();

export class OpenAIProvider implements ModelProvider {
  #baseUrl: string;
  #apiKey: string;
  #model: string;
  #requestTimeoutMs: number;
  #retryOptions: RetryOptions;

  constructor(options?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    requestTimeoutMs?: number;
    maxRetries?: number;
  }) {
    this.#baseUrl =
      options?.baseUrl ??
      process.env.BASE_URL ??
      "https://api.openai.com";
    this.#baseUrl = this.#baseUrl.replace(/\/+$/, "");
    this.#apiKey = options?.apiKey ?? process.env.API_KEY ?? "";
    this.#model = options?.model ?? process.env.LLM_MODEL ?? "gpt-4o";
    this.#requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#retryOptions = {
      timeoutMs: this.#requestTimeoutMs,
    };
    if (options?.maxRetries !== undefined) {
      this.#retryOptions.maxRetries = options.maxRetries;
    }
  }

  async generate(
    messages: ModelMessage[],
    tools?: ToolDefinition[],
    callbacks?: { onToken?: (token: string) => void; signal?: AbortSignal },
  ): Promise<ModelResponse> {
    throwIfAborted(callbacks?.signal);
    const wireMessages = messages.map(convertMessage);

    const body: Record<string, unknown> = {
      model: this.#model,
      messages: wireMessages,
    };

    if (tools && tools.length > 0) {
      const clientTools = tools.filter((t) => !t.anthropicServerType);
      if (clientTools.length > 0) {
        body.tools = clientTools.map(convertTool);
      }
    }

    const hasCallback = !!callbacks?.onToken;
    if (hasCallback) {
      body.stream = true;
    }

    logger.debug("API request starting", {
      model: this.#model,
      stream: hasCallback,
    });

    const retryOptions: RetryOptions = { ...this.#retryOptions };
    if (callbacks?.signal) retryOptions.signal = callbacks.signal;

    const resp = await fetchWithRetry(
      `${this.#baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
      },
      retryOptions,
    );
    throwIfAborted(callbacks?.signal);

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "unknown error");
      logger.error("API request failed", {
        status: resp.status,
        statusText: resp.statusText,
        error: errorText,
      });
      throw new Error(
        `API error ${resp.status}: ${resp.statusText} — ${errorText}`,
      );
    }

    logger.debug("API request succeeded", { status: resp.status });

    if (!hasCallback || !resp.body) {
      return this.#parseNonStreaming(resp);
    }

    return this.#parseStreaming(resp.body, callbacks!.onToken!, callbacks?.signal);
  }

  getMetadata(): ModelProviderMetadata {
    return {
      provider: "openai",
      model: this.#model,
      requiresUsage: false,
    };
  }

  async #parseNonStreaming(resp: Response): Promise<ModelResponse> {
    const data = (await resp.json()) as {
      choices: Array<{
        message: {
          role: string;
          content?: string | null;
          reasoning_content?: string;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) {
      throw new Error("No choices in API response");
    }

    const msg = choice.message;
    const finishReason =
      choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";

    const rawUsage = data.usage
      ? {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      }
      : undefined;

    if (
      finishReason === "tool_calls" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      const response: ModelResponse = {
        text: msg.content ?? "",
        finishReason: "tool_calls",
        toolCalls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: parseToolArgs(tc.function.arguments),
        })),
      };
      if (msg.reasoning_content) response.reasoningContent = msg.reasoning_content;
      if (rawUsage) response.rawUsage = rawUsage;
      return response;
    }

    const response: ModelResponse = {
      text: msg.content ?? "",
      finishReason: "stop",
    };
    if (msg.reasoning_content) response.reasoningContent = msg.reasoning_content;
    if (rawUsage) response.rawUsage = rawUsage;
    return response;
  }

  async #parseStreaming(
    body: ReadableStream<Uint8Array>,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const textParts: string[] = [];
    const toolCallBuilders = new Map<number, { id?: string; name?: string; argsFragments: string[] }>();
    let finishReason: "stop" | "tool_calls" = "stop";
    let rawUsage: ModelUsage | undefined;
    let reasoningContent: string | undefined;

    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);

        if (payload === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{
              index?: number;
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          };

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (delta) {
            if (delta.content) {
              textParts.push(delta.content);
              if (!signal?.aborted) onToken(delta.content);
            }
            if (delta.reasoning_content) {
              reasoningContent = (reasoningContent ?? "") + delta.reasoning_content;
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const builder = toolCallBuilders.get(tc.index) ?? { argsFragments: [] };
                toolCallBuilders.set(tc.index, builder);
                if (tc.id) builder.id = tc.id;
                if (tc.function?.name) builder.name = tc.function.name;
                if (tc.function?.arguments) builder.argsFragments.push(tc.function.arguments);
              }
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";
          }

          if (chunk.usage) {
            rawUsage = {
              input_tokens: chunk.usage.prompt_tokens,
              output_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    const remaining = buffer.trim();
    throwIfAborted(signal);
    if (remaining.startsWith("data: ")) {
      const payload = remaining.slice(6);
      if (payload !== "[DONE]") {
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          };
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            textParts.push(delta.content);
            if (!signal?.aborted) onToken(delta.content);
          }
          if (delta?.reasoning_content) {
            reasoningContent = (reasoningContent ?? "") + delta.reasoning_content;
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const builder = toolCallBuilders.get(tc.index) ?? { argsFragments: [] };
              toolCallBuilders.set(tc.index, builder);
              if (tc.id) builder.id = tc.id;
              if (tc.function?.name) builder.name = tc.function.name;
              if (tc.function?.arguments) builder.argsFragments.push(tc.function.arguments);
            }
          }
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";
          }
          if (chunk.usage) {
            rawUsage = {
              input_tokens: chunk.usage.prompt_tokens,
              output_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    const toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }> = [];

    for (const builder of toolCallBuilders.values()) {
      if (builder.id && builder.name) {
        const jsonStr = builder.argsFragments.join("");
        toolCalls.push({
          id: builder.id,
          name: builder.name,
          args: parseToolArgs(jsonStr),
        });
      }
    }

    if (toolCalls.length > 0) {
      finishReason = "tool_calls";
    }

    const response: ModelResponse = {
      text: textParts.join(""),
      finishReason,
    };
    if (toolCalls.length > 0) response.toolCalls = toolCalls;
    if (reasoningContent) response.reasoningContent = reasoningContent;
    if (rawUsage) response.rawUsage = rawUsage;
    return response;
  }
}

function convertMessage(msg: ModelMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.reasoning_content) {
    wire.reasoning_content = msg.reasoning_content;
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    wire.tool_calls = msg.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args),
      },
    }));
  }

  if (msg.tool_call_id) {
    wire.tool_call_id = msg.tool_call_id;
  }

  return wire;
}

function convertTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema ?? convertParams(tool.params),
    },
  };
}

function convertParams(
  params: Record<string, ToolParamSchema>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, schema] of Object.entries(params)) {
    properties[name] = convertParamSchema(schema);
    if (!schema.optional) required.push(name);
  }

  const result: Record<string, unknown> = {
    type: "object",
    properties,
  };
  if (required.length > 0) result.required = required;
  return result;
}

function convertParamSchema(schema: ToolParamSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: schema.type,
    description: schema.description,
  };

  if (schema.properties) {
    result.properties = {};
    for (const [name, prop] of Object.entries(schema.properties)) {
      (result.properties as Record<string, unknown>)[name] =
        convertParamSchema(prop);
    }
  }

  if (schema.items) {
    result.items = convertParamSchema(schema.items);
  }

  return result;
}

function parseToolArgs(jsonStr: string): Record<string, unknown> {
  if (!jsonStr.trim()) return {};
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid model output should become a tool error path, not crash parsing.
  }
  return {};
}
