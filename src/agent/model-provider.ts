import type { ToolDefinition } from "../tools/schemas.js";

export type ModelMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: ToolCallRequest[];
  tool_call_id?: string;
  reasoning_content?: string;
  anthropicContent?: unknown[];
};

export type ToolCallRequest = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ModelResponse = {
  text: string;
  toolCalls?: ToolCallRequest[];
  finishReason: "stop" | "tool_calls";
  reasoningContent?: string;
  rawContent?: unknown[];
  rawUsage?: ModelUsage;
};

export type ModelUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  reasoning_tokens?: number;
  estimated?: boolean;
};

export type ModelPricing = {
  cacheHit: number;
  input: number;
  output: number;
  currency: string;
};

export type ModelProviderMetadata = {
  provider: string;
  model: string;
  contextWindowTokens?: number;
  requiresUsage?: boolean;
  pricing?: ModelPricing;
};

export interface ModelProvider {
  generate(
    messages: ModelMessage[],
    tools?: ToolDefinition[],
    callbacks?: {
      onToken?: (token: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<ModelResponse>;
  getMetadata?(): ModelProviderMetadata;
}
