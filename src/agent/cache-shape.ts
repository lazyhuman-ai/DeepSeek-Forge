import { createHash } from "node:crypto";
import type { ToolDefinition } from "../tools/schemas.js";
import type { ModelMessage, ModelUsage } from "./model-provider.js";

export type CacheShape = {
  systemHash: string;
  toolsHash: string;
  stableContextHash: string;
  dynamicTailHash: string;
};

export type CacheShapeDiagnostics = {
  prefixChanged: boolean;
  reasons: string[];
  cacheHitRate?: number;
  cacheMissTokens?: number;
};

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function toolShape(tool: ToolDefinition): unknown {
  return {
    name: tool.name,
    description: tool.description,
    params: tool.params,
    parametersJsonSchema: tool.parametersJsonSchema,
    isReadOnly: tool.isReadOnly === true,
    isConcurrencySafe: tool.isConcurrencySafe === true,
    capabilities: tool.capabilities ?? [],
    source: tool.source,
  };
}

export function buildCacheShape(messages: ModelMessage[], tools?: ToolDefinition[]): CacheShape {
  const systemMessages = messages.filter((message) => message.role === "system").map((message) => message.content);
  const nonSystem = messages.filter((message) => message.role !== "system");
  const stableContext = nonSystem.slice(0, Math.max(0, nonSystem.length - 8)).map((message) => ({
    role: message.role,
    content: message.content,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls?.map((call) => ({ name: call.name, args: call.args })),
  }));
  const dynamicTail = nonSystem.slice(-8).map((message) => ({
    role: message.role,
    content: message.content,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls?.map((call) => ({ name: call.name, args: call.args })),
  }));
  return {
    systemHash: sha(systemMessages),
    toolsHash: sha((tools ?? []).map(toolShape).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))),
    stableContextHash: sha(stableContext),
    dynamicTailHash: sha(dynamicTail),
  };
}

function inferCacheMiss(usage: ModelUsage): number | undefined {
  if (usage.cache_miss_tokens !== undefined) return usage.cache_miss_tokens;
  if (usage.cache_hit_tokens === undefined) return undefined;
  return Math.max(0, usage.input_tokens - usage.cache_hit_tokens);
}

export function compareCacheShape(
  previous: CacheShape | undefined,
  current: CacheShape,
  usage?: ModelUsage,
): CacheShapeDiagnostics {
  const reasons: string[] = [];
  if (!previous) {
    reasons.push("first_call");
  } else {
    if (previous.systemHash !== current.systemHash) reasons.push("system_prompt_changed");
    if (previous.toolsHash !== current.toolsHash) reasons.push("tool_schema_changed");
    if (previous.stableContextHash !== current.stableContextHash) reasons.push("stable_context_changed");
    if (previous.dynamicTailHash !== current.dynamicTailHash) reasons.push("dynamic_tail_changed");
  }

  const cacheMissTokens = usage ? inferCacheMiss(usage) : undefined;
  const cacheHitRate = usage?.cache_hit_tokens !== undefined && usage.input_tokens > 0
    ? usage.cache_hit_tokens / usage.input_tokens
    : undefined;
  if (cacheHitRate !== undefined && cacheHitRate < 0.35 && reasons.length === 0) {
    reasons.push("provider_reported_low_cache_hit_without_prefix_hash_change");
  }

  return {
    prefixChanged: reasons.some((reason) => reason !== "dynamic_tail_changed"),
    reasons,
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
    ...(cacheMissTokens !== undefined ? { cacheMissTokens } : {}),
  };
}
