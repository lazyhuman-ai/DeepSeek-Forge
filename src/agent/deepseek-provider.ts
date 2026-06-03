import type {
  ModelMessage,
  ModelPricing,
  ModelProvider,
  ModelProviderMetadata,
  ModelResponse,
  ModelUsage,
} from "./model-provider.js";
import type { ToolDefinition, ToolParamSchema } from "../tools/schemas.js";
import { createLogger } from "../core/logger.js";
import { loadEnv } from "../core/env.js";
import { fetchWithRetry, type RetryOptions } from "../core/http-client.js";

const logger = createLogger("deepseek-provider");
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
const DEFAULT_PRICING: ModelPricing = {
  cacheHit: 0.02,
  input: 1,
  output: 2,
  currency: "¥",
};

type WireUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("DeepSeek request aborted");
    err.name = "AbortError";
    throw err;
  }
}

function parseNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pricingFromEnv(): ModelPricing {
  return {
    cacheHit: parseNumberEnv("DEEPSEEK_PRICE_CACHE_HIT") ?? DEFAULT_PRICING.cacheHit,
    input: parseNumberEnv("DEEPSEEK_PRICE_INPUT") ?? DEFAULT_PRICING.input,
    output: parseNumberEnv("DEEPSEEK_PRICE_OUTPUT") ?? DEFAULT_PRICING.output,
    currency: process.env.DEEPSEEK_PRICE_CURRENCY ?? DEFAULT_PRICING.currency,
  };
}

function normalizeUsage(raw: WireUsage): ModelUsage {
  const inputTokens = raw.prompt_tokens ?? 0;
  const outputTokens = raw.completion_tokens ?? 0;
  let cacheHit = raw.prompt_cache_hit_tokens ?? 0;
  let cacheMiss = raw.prompt_cache_miss_tokens ?? 0;
  if (cacheHit === 0 && raw.prompt_tokens_details?.cached_tokens) {
    cacheHit = raw.prompt_tokens_details.cached_tokens;
  }
  if (cacheMiss === 0 && cacheHit > 0 && inputTokens > cacheHit) {
    cacheMiss = inputTokens - cacheHit;
  }

  const usage: ModelUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: raw.total_tokens ?? inputTokens + outputTokens,
  };
  if (cacheHit > 0) usage.cache_hit_tokens = cacheHit;
  if (cacheMiss > 0) usage.cache_miss_tokens = cacheMiss;
  if (raw.completion_tokens_details?.reasoning_tokens) {
    usage.reasoning_tokens = raw.completion_tokens_details.reasoning_tokens;
  }
  return usage;
}

loadEnv();

export class DeepSeekProvider implements ModelProvider {
  #baseUrl: string;
  #apiKey: string;
  #model: string;
  #requestTimeoutMs: number;
  #retryOptions: RetryOptions;
  #contextWindowTokens: number;
  #pricing: ModelPricing;

  constructor(options?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    requestTimeoutMs?: number;
    maxRetries?: number;
    contextWindowTokens?: number;
    pricing?: ModelPricing;
  }) {
    this.#baseUrl = (
      options?.baseUrl ??
      process.env.BASE_URL ??
      "https://api.deepseek.com"
    ).replace(/\/+$/, "");
    this.#apiKey = options?.apiKey ?? process.env.API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
    this.#model = options?.model ?? process.env.LLM_MODEL ?? "deepseek-v4-pro";
    this.#requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#retryOptions = {
      timeoutMs: this.#requestTimeoutMs,
    };
    if (options?.maxRetries !== undefined) {
      this.#retryOptions.maxRetries = options.maxRetries;
    }
    this.#contextWindowTokens = options?.contextWindowTokens
      ?? parseNumberEnv("CONTEXT_WINDOW_TOKENS")
      ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.#pricing = options?.pricing ?? pricingFromEnv();
  }

  getMetadata(): ModelProviderMetadata {
    return {
      provider: "deepseek",
      model: this.#model,
      contextWindowTokens: this.#contextWindowTokens,
      requiresUsage: true,
      pricing: this.#pricing,
    };
  }

  async generate(
    messages: ModelMessage[],
    tools?: ToolDefinition[],
    callbacks?: { onToken?: (token: string) => void; signal?: AbortSignal },
  ): Promise<ModelResponse> {
    throwIfAborted(callbacks?.signal);
    const body: Record<string, unknown> = {
      model: this.#model,
      messages: messages.map(convertMessage),
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
      body.stream_options = { include_usage: true };
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
      throw new Error(`API error ${resp.status}: ${resp.statusText} — ${errorText}`);
    }

    if (!hasCallback || !resp.body) {
      return this.#parseNonStreaming(resp);
    }
    return this.#parseStreaming(resp.body, callbacks!.onToken!, callbacks?.signal);
  }

  async #parseNonStreaming(resp: Response): Promise<ModelResponse> {
    const data = (await resp.json()) as {
      choices: Array<{
        message: {
          content?: string | null;
          reasoning_content?: string;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: WireUsage;
    };

    const choice = data.choices[0];
    if (!choice) throw new Error("No choices in API response");
    const msg = choice.message;
    const finishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";

    const response: ModelResponse = {
      text: msg.content ?? "",
      finishReason,
    };
    if (msg.reasoning_content) response.reasoningContent = msg.reasoning_content;
    if (data.usage) response.rawUsage = normalizeUsage(data.usage);
    if (finishReason === "tool_calls" && msg.tool_calls?.length) {
      response.toolCalls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: parseToolArgs(tc.function.arguments),
      }));
    }
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
            usage?: WireUsage;
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
            rawUsage = normalizeUsage(chunk.usage);
          }
        } catch {
          // Skip malformed chunks.
        }
      }
    }

    const toolCalls = [...toolCallBuilders.values()]
      .filter((builder) => builder.id && builder.name)
      .map((builder) => ({
        id: builder.id!,
        name: builder.name!,
        args: parseToolArgs(builder.argsFragments.join("")),
      }));
    if (toolCalls.length > 0) finishReason = "tool_calls";

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

function convertParams(params: Record<string, ToolParamSchema>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, spec] of Object.entries(params)) {
    properties[key] = convertParamSchema(spec);
    if (!spec.optional) required.push(key);
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
      (result.properties as Record<string, unknown>)[name] = convertParamSchema(prop);
    }
  }
  if (schema.items) {
    result.items = convertParamSchema(schema.items);
  }
  return result;
}

function parseToolArgs(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
