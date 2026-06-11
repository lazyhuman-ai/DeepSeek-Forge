import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelPricing, ModelUsage } from "../agent/model-provider.js";

export type UsageRecord = {
  id: string;
  seq: number;
  timestamp: string;
  sessionId: string;
  provider: string;
  model: string;
  requestKind: string;
  usage: ModelUsage;
  contextWindowTokens?: number;
  contextUsedPercent?: number;
  cachePrefixChanged?: boolean;
  cachePrefixReasons?: string[];
  cacheHitRate?: number;
  pricing?: ModelPricing;
  cost?: number;
};

export type SessionUsageSummary = {
  sessionId: string;
  latest?: UsageRecord;
  records: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  cost?: number;
  currency?: string;
  contextWindowTokens?: number;
  contextUsedPercent?: number;
  currentContextTokens?: number;
  currentContextWindowTokens?: number;
  currentContextUsedPercent?: number;
  currentContextEstimated?: boolean;
  currentContextSource?: "provider_usage" | "local_estimate";
  currentContextReason?: string;
  currentContextMessage?: string;
  cacheHitRateNow?: number;
  cacheHitRateSession?: number;
  estimated: boolean;
};

export class UsageLedger {
  #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  append(record: UsageRecord): UsageRecord {
    mkdirSync(this.#root, { recursive: true });
    appendFileSync(this.#path(record.sessionId), JSON.stringify(record) + "\n", "utf-8");
    return record;
  }

  list(sessionId: string, afterSeq = 0): UsageRecord[] {
    const path = this.#path(sessionId);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    return lines
      .map((line) => JSON.parse(line) as UsageRecord)
      .filter((record) => record.seq > afterSeq);
  }

  summarize(sessionId: string): SessionUsageSummary {
    const records = this.list(sessionId);
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let cacheHitTokens = 0;
    let cacheMissTokens = 0;
    let reasoningTokens = 0;
    let cost = 0;
    let hasCost = false;
    let currency: string | undefined;
    let estimated = false;

    for (const record of records) {
      inputTokens += record.usage.input_tokens;
      outputTokens += record.usage.output_tokens;
      totalTokens += record.usage.total_tokens ?? record.usage.input_tokens + record.usage.output_tokens;
      cacheHitTokens += record.usage.cache_hit_tokens ?? 0;
      cacheMissTokens += inferCacheMiss(record.usage);
      reasoningTokens += record.usage.reasoning_tokens ?? 0;
      estimated ||= record.usage.estimated === true;
      if (record.cost !== undefined) {
        cost += record.cost;
        hasCost = true;
      }
      if (record.pricing?.currency) currency = record.pricing.currency;
    }

    const latest = records[records.length - 1];
    const summary: SessionUsageSummary = {
      sessionId,
      records: records.length,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheHitTokens,
      cacheMissTokens,
      reasoningTokens,
      estimated,
    };
    if (latest) {
      summary.latest = latest;
      if (latest.contextWindowTokens !== undefined) summary.contextWindowTokens = latest.contextWindowTokens;
      if (latest.contextUsedPercent !== undefined) {
        summary.contextUsedPercent = latest.contextUsedPercent;
        summary.currentContextTokens = latest.usage.input_tokens;
        if (latest.contextWindowTokens !== undefined) {
          summary.currentContextWindowTokens = latest.contextWindowTokens;
        }
        summary.currentContextUsedPercent = latest.contextUsedPercent;
        summary.currentContextEstimated = latest.usage.estimated === true;
        summary.currentContextSource = "provider_usage";
      }
      const nowDenom = (latest.usage.cache_hit_tokens ?? 0) + inferCacheMiss(latest.usage);
      if (nowDenom > 0) summary.cacheHitRateNow = ((latest.usage.cache_hit_tokens ?? 0) / nowDenom) * 100;
    }
    const sessionDenom = cacheHitTokens + cacheMissTokens;
    if (sessionDenom > 0) summary.cacheHitRateSession = (cacheHitTokens / sessionDenom) * 100;
    if (hasCost) summary.cost = cost;
    if (currency !== undefined) summary.currency = currency;
    return summary;
  }

  #path(sessionId: string): string {
    return join(this.#root, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
  }
}

export function inferCacheMiss(usage: ModelUsage): number {
  if (usage.cache_miss_tokens !== undefined) return usage.cache_miss_tokens;
  if (usage.cache_hit_tokens !== undefined && usage.input_tokens > usage.cache_hit_tokens) {
    return usage.input_tokens - usage.cache_hit_tokens;
  }
  return 0;
}

export function usageCost(usage: ModelUsage, pricing: ModelPricing | undefined): number | undefined {
  if (!pricing) return undefined;
  const cacheHit = usage.cache_hit_tokens ?? 0;
  const cacheMiss = inferCacheMiss(usage);
  return (
    cacheHit * pricing.cacheHit +
    cacheMiss * pricing.input +
    usage.output_tokens * pricing.output
  ) / 1_000_000;
}
