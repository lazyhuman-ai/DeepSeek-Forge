import type { ModelProvider, ModelMessage, ModelProviderMetadata, ModelResponse, ModelUsage } from "./model-provider.js";
import type { ToolDefinition, ToolParamSchema } from "../tools/schemas.js";
import { createLogger } from "../core/logger.js";
import { loadEnv } from "../core/env.js";
import { fetchWithRetry, type RetryOptions } from "../core/http-client.js";

const logger = createLogger("anthropic-provider");
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("Anthropic request aborted");
    err.name = "AbortError";
    throw err;
  }
}

function normalizeUsage(raw: AnthropicUsage, previous?: ModelUsage): ModelUsage {
  const hasInputFields = raw.input_tokens !== undefined
    || raw.cache_creation_input_tokens !== undefined
    || raw.cache_read_input_tokens !== undefined;
  const inputTokens = hasInputFields
    ? (raw.input_tokens ?? 0)
      + (raw.cache_creation_input_tokens ?? 0)
      + (raw.cache_read_input_tokens ?? 0)
    : previous?.input_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: raw.output_tokens ?? previous?.output_tokens ?? 0,
    total_tokens: inputTokens + (raw.output_tokens ?? previous?.output_tokens ?? 0),
  };
}

loadEnv();

export class AnthropicProvider implements ModelProvider {
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
      "https://api.deepseek.com";
    this.#baseUrl = this.#baseUrl.replace(/\/+$/, "");
    this.#apiKey = options?.apiKey ?? process.env.API_KEY ?? "";
    this.#model =
      options?.model ?? process.env.LLM_MODEL ?? "deepseek-v4-pro";
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
    callbacks?: { onToken?: (token: string) => void; onStatus?: (message: string) => void; signal?: AbortSignal },
  ): Promise<ModelResponse> {
    throwIfAborted(callbacks?.signal);
    const systemMessages = messages.filter((m) => m.role === "system");
    const conversationMessages = messages.filter((m) => m.role !== "system");

    const systemPrompt = systemMessages
      .map((m) => m.content)
      .join("\n\n");

    const wireMessagesRaw = convertMessages(conversationMessages);
    const wireMessages = mergeWireMessages(wireMessagesRaw);

    const wireTools: Record<string, unknown>[] = [];

    if (tools && tools.length > 0) {
      wireTools.push(...tools.map(convertTool));
    }

    const body: Record<string, unknown> = {
      model: this.#model,
      max_tokens: 4096,
      messages: wireMessages,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (wireTools.length > 0) {
      body.tools = wireTools;
    }

    const hasCallback = !!callbacks?.onToken;
    if (hasCallback) {
      body.stream = true;
    }

    logger.debug("API request starting", {
      model: this.#model,
      stream: hasCallback,
      toolCount: wireTools.length,
    });

    const retryOptions: RetryOptions = { ...this.#retryOptions };
    if (callbacks?.signal) retryOptions.signal = callbacks.signal;
    if (callbacks?.onStatus) {
      retryOptions.onRetry = (event) => {
        callbacks.onStatus?.(
          `Model request failed (${event.reason}); retrying in ${Math.ceil(event.delayMs / 1000)}s ` +
          `(${event.attempt}/${event.maxRetries}).`,
        );
      };
    }

    const resp = await fetchWithRetry(
      `${this.#baseUrl}/anthropic/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
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
      provider: "anthropic-compatible",
      model: this.#model,
      requiresUsage: false,
    };
  }

  async #parseNonStreaming(resp: Response): Promise<ModelResponse> {
    const data = (await resp.json()) as {
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        results?: unknown[];
        query?: string;
      }>;
      stop_reason?: string;
      reasoning_content?: string;
      usage?: AnthropicUsage;
    };

    const content = data.content ?? [];
    const textParts: string[] = [];
    const toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }> = [];

    for (const block of content) {
      switch (block.type) {
        case "text":
          if (block.text) textParts.push(block.text);
          break;
        case "tool_use":
          if (block.id && block.name) {
            toolCalls.push({
              id: block.id,
              name: block.name,
              args: block.input ?? {},
            });
          }
          break;
        case "server_tool_use":
          if (block.name && block.input) {
            textParts.push(
              `[Server tool: ${block.name}(${JSON.stringify(block.input)})]`,
            );
          }
          break;
        case "web_search_tool_result": {
          if (block.results && Array.isArray(block.results)) {
            const summaries = block.results.map(
              (r: unknown) => (r as Record<string, unknown>)?.title ?? "",
            ).filter(Boolean);
            if (summaries.length > 0) {
              textParts.push(
                `[Search results: ${summaries.join("; ")}]`,
              );
            }
          }
        }
          break;
      }
    }

    const finishReason =
      toolCalls.length > 0 ? "tool_calls" : "stop";

    const response: ModelResponse = {
      text: textParts.join("\n"),
      finishReason,
      rawContent: content.filter(
        (b) => b.type !== "server_tool_use" && b.type !== "web_search_tool_result",
      ),
    };
    if (toolCalls.length > 0) response.toolCalls = toolCalls;
    if (data.reasoning_content) response.reasoningContent = data.reasoning_content;
    if (data.usage) response.rawUsage = normalizeUsage(data.usage);
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
    let currentEvent = "";
    let dataLines: string[] = [];

    const textParts: string[] = [];
    const toolCallBuilders = new Map<number, { id?: string; name?: string; jsonFragments: string[] }>();
    let finishReason: "stop" | "tool_calls" = "stop";
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    const contentBlocks: Array<Record<string, unknown>> = [];
    const blockAccumulators = new Map<number, Record<string, unknown>>();
    let sseError: { type: string; message: string } | null = null;

    const processEvent = (eventType: string, eventData: string): void => {
      if (!eventData) return;

      try {
        const parsed = JSON.parse(eventData) as Record<string, unknown>;
        const effectiveType = eventType || (parsed.type as string | undefined) || "";
        const index = parsed.index as number | undefined;

        if (effectiveType === "content_block_start") {
          const block = parsed.content_block as Record<string, unknown> | undefined;
          if (block && index !== undefined) {
            blockAccumulators.set(index, { ...block });
            if (block.type === "tool_use") {
              const builder: { id?: string; name?: string; jsonFragments: string[] } = {
                jsonFragments: [],
              };
              if (typeof block.id === "string") builder.id = block.id;
              if (typeof block.name === "string") builder.name = block.name;
              toolCallBuilders.set(index, builder);
            }
          }
        } else if (effectiveType === "content_block_delta") {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta && index !== undefined) {
            const block = blockAccumulators.get(index);
            if (block) {
              if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                block.thinking = ((block.thinking as string) ?? "") + delta.thinking;
              } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
                block.signature = delta.signature;
              } else if (delta.type === "text_delta" && typeof delta.text === "string") {
                textParts.push(delta.text);
                if (!signal?.aborted) onToken(delta.text);
                block.text = ((block.text as string) ?? "") + delta.text;
              } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const builder = toolCallBuilders.get(index);
                if (builder) {
                  builder.jsonFragments.push(delta.partial_json);
                }
              }
            }
          }
        } else if (effectiveType === "content_block_stop") {
          if (index !== undefined) {
            const block = blockAccumulators.get(index);
            if (block) {
              const builder = toolCallBuilders.get(index);
              if (builder && block.type === "tool_use") {
                block.input = parseToolInput(builder.jsonFragments.join(""));
              }
              contentBlocks.push(block);
              blockAccumulators.delete(index);
            }
          }
        } else if (effectiveType === "message_start") {
          const msg = parsed.message as Record<string, unknown> | undefined;
          if (msg?.usage) {
            usage = normalizeUsage(msg.usage as AnthropicUsage, usage);
          }
        } else if (effectiveType === "error") {
          const err = parsed.error as { type?: string; message?: string } | undefined;
          sseError = {
            type: err?.type ?? "unknown",
            message: err?.message ?? JSON.stringify(parsed),
          };
        } else if (effectiveType === "message_delta") {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason === "tool_use") {
            finishReason = "tool_calls";
          }
          if (parsed.usage) {
            usage = normalizeUsage(parsed.usage as AnthropicUsage, usage);
          }
        }
      } catch {
        // Skip malformed SSE data
      }
    };

    const processLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        if (dataLines.length > 0) {
          processEvent(currentEvent, dataLines.join("\n"));
        }
        currentEvent = "";
        dataLines = [];
        return;
      }
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    };

    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak !== -1) {
        const line = buffer.slice(0, lineBreak);
        buffer = buffer.slice(lineBreak + 1);
        processLine(line);
        lineBreak = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    throwIfAborted(signal);
    if (buffer.length > 0) {
      processLine(buffer);
      buffer = "";
    }
    if (dataLines.length > 0) {
      processEvent(currentEvent, dataLines.join("\n"));
      currentEvent = "";
      dataLines = [];
    }

    if (sseError) {
      const err = sseError as { type: string; message: string };
      throw new Error(`SSE error [${err.type}]: ${err.message}`);
    }

    // Build tool calls from accumulated fragments
    const toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }> = [];
    for (const builder of toolCallBuilders.values()) {
      if (builder.id && builder.name) {
        const jsonStr = builder.jsonFragments.join("");
        toolCalls.push({
          id: builder.id,
          name: builder.name,
          args: parseToolInput(jsonStr),
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
    const rawContent = contentBlocks.filter(
      (b) => b.type !== "server_tool_use" && b.type !== "web_search_tool_result",
    );
    if (rawContent.length > 0) response.rawContent = rawContent;
    if (usage) response.rawUsage = usage;
    return response;
  }

}

function formatSyntheticToolCall(tc: { id: string; name: string; args: Record<string, unknown> }): string {
  return [
    "[Historical tool call reference]",
    `Tool call id: ${tc.id}`,
    `Tool: ${tc.name}`,
    `Arguments: ${JSON.stringify(tc.args)}`,
  ].join("\n");
}

function formatSyntheticToolResult(toolCallId: string, content: string): string {
  return [
    "[Historical tool result reference]",
    `Tool call id: ${toolCallId}`,
    content,
  ].join("\n");
}

function collectAnthropicToolUseIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is { type: string; id: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_use" &&
      typeof (block as { id?: unknown }).id === "string",
    )
    .map((block) => block.id);
}

function convertMessages(messages: ModelMessage[]): Record<string, unknown>[] {
  const validAnthropicToolUseIds = new Set<string>();
  return messages.map((msg) => convertMessage(msg, validAnthropicToolUseIds));
}

function convertMessage(
  msg: ModelMessage,
  validAnthropicToolUseIds: Set<string>,
): Record<string, unknown> {
  let content: Record<string, unknown>[];

  if (msg.anthropicContent) {
    content = msg.anthropicContent as Record<string, unknown>[];
    for (const id of collectAnthropicToolUseIds(content)) {
      validAnthropicToolUseIds.add(id);
    }
  } else if (msg.tool_calls && msg.tool_calls.length > 0) {
    content = [{
      type: "text",
      text: msg.tool_calls.map(formatSyntheticToolCall).join("\n\n"),
    }];
  } else if (msg.tool_call_id) {
    if (validAnthropicToolUseIds.has(msg.tool_call_id)) {
      content = [{
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: msg.content,
      }];
    } else {
      content = [{
        type: "text",
        text: formatSyntheticToolResult(msg.tool_call_id, msg.content),
      }];
    }
  } else {
    content = [{ type: "text", text: msg.content }];
  }

  const wire: Record<string, unknown> = {
    role: msg.role === "tool" ? "user" : msg.role,
    content,
  };

  if (msg.reasoning_content) {
    wire.reasoning_content = msg.reasoning_content;
  }

  return wire;
}

function mergeWireMessages(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let pendingToolResults: Record<string, unknown>[] = [];

  function flushToolResults(): void {
    if (pendingToolResults.length === 0) return;
    result.push({
      role: "user",
      content: pendingToolResults,
    });
    pendingToolResults = [];
  }

  for (const msg of messages) {
    const content = msg.content as Record<string, unknown>[] | undefined;
    if (!content || content.length === 0) continue;

    const blockTypes = content.map((b) => b.type);

    if (msg.role === "user" && blockTypes.some((t) => t === "tool_result")) {
      pendingToolResults.push(...content);
      continue;
    }

    flushToolResults();
    result.push(msg);
  }

  flushToolResults();
  return result;
}

function convertTool(tool: ToolDefinition): Record<string, unknown> {
  if (tool.anthropicServerType) {
    return { type: tool.anthropicServerType, name: tool.name };
  }
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parametersJsonSchema ?? convertParams(tool.params),
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

  const result: Record<string, unknown> = { type: "object", properties };
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

function parseToolInput(jsonStr: string): Record<string, unknown> {
  if (!jsonStr.trim()) return {};
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid model output should become empty args instead of crashing parsing.
  }
  return {};
}
