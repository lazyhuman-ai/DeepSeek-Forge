import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { ModelPricing } from "../agent/model-provider.js";
import { loadEnv } from "../core/env.js";

export type ProviderKind = "deepseek";

export type ProviderConfig = {
  provider: ProviderKind;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  contextWindowTokens?: number;
  pricing?: ModelPricing;
  updatedAt: string;
};

export type ProviderConfigInput = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  contextWindowTokens?: number;
};

export type EffectiveProviderConfig = {
  provider: ProviderKind;
  configured: boolean;
  source: "local_config" | "env" | "missing";
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindowTokens: number;
  updatedAt?: string;
};

export type SetupStatus = {
  provider: {
    provider: ProviderKind;
    configured: boolean;
    source: "local_config" | "env" | "missing";
    apiKeyMasked: string | null;
    baseUrl: string;
    model: string;
    contextWindowTokens: number;
    updatedAt?: string;
  };
};

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

loadEnv();

export class ProviderConfigStore {
  #dir: string;
  #file: string;

  constructor(dir = ".forge/config") {
    this.#dir = resolve(dir);
    this.#file = join(this.#dir, "provider.json");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.#dir, 0o700);
    } catch {
      // Best effort on platforms/filesystems that do not support chmod.
    }
  }

  get path(): string {
    return this.#file;
  }

  readStored(): ProviderConfig | null {
    if (!existsSync(this.#file)) return null;
    const parsed = JSON.parse(readFileSync(this.#file, "utf-8")) as Partial<ProviderConfig>;
    return normalizeStoredConfig(parsed);
  }

  getEffectiveConfig(): EffectiveProviderConfig {
    const stored = this.readStored();
    const envApiKey = process.env.API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
    const apiKey = stored?.apiKey ?? envApiKey;
    const baseUrl = stored?.baseUrl ?? process.env.BASE_URL ?? DEFAULT_BASE_URL;
    const model = stored?.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
    const contextWindowTokens = stored?.contextWindowTokens
      ?? parseNumber(process.env.CONTEXT_WINDOW_TOKENS)
      ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const configured = apiKey.length > 0;
    const source = stored?.apiKey
      ? "local_config"
      : envApiKey
        ? "env"
        : "missing";

    const result: EffectiveProviderConfig = {
      provider: "deepseek",
      configured,
      source,
      apiKey,
      baseUrl,
      model,
      contextWindowTokens,
    };
    if (stored?.updatedAt) result.updatedAt = stored.updatedAt;
    return result;
  }

  getStatus(): SetupStatus {
    const effective = this.getEffectiveConfig();
    const status: SetupStatus = {
      provider: {
        provider: effective.provider,
        configured: effective.configured,
        source: effective.source,
        apiKeyMasked: effective.apiKey ? maskSecret(effective.apiKey) : null,
        baseUrl: effective.baseUrl,
        model: effective.model,
        contextWindowTokens: effective.contextWindowTokens,
      },
    };
    if (effective.updatedAt) status.provider.updatedAt = effective.updatedAt;
    return status;
  }

  save(input: ProviderConfigInput): SetupStatus {
    const current = this.readStored();
    const existingEffective = this.getEffectiveConfig();
    const next: ProviderConfig = {
      provider: "deepseek",
      baseUrl: normalizeOptionalString(input.baseUrl) ?? current?.baseUrl ?? existingEffective.baseUrl,
      model: normalizeOptionalString(input.model) ?? current?.model ?? existingEffective.model,
      contextWindowTokens: normalizePositiveInteger(input.contextWindowTokens)
        ?? current?.contextWindowTokens
        ?? existingEffective.contextWindowTokens,
      updatedAt: new Date().toISOString(),
    };
    const apiKey = normalizeOptionalString(input.apiKey) ?? current?.apiKey;
    if (apiKey) next.apiKey = apiKey;

    const tmp = `${this.#file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best effort only.
    }
    renameSync(tmp, this.#file);
    try {
      chmodSync(this.#file, 0o600);
    } catch {
      // Best effort only.
    }
    return this.getStatus();
  }
}

export function deepSeekOptionsFromConfig(config: EffectiveProviderConfig): {
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindowTokens: number;
} {
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    contextWindowTokens: config.contextWindowTokens,
  };
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "••••";
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

function normalizeStoredConfig(parsed: Partial<ProviderConfig>): ProviderConfig | null {
  if (parsed.provider !== "deepseek") return null;
  const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString();
  const result: ProviderConfig = {
    provider: "deepseek",
    updatedAt,
  };
  const apiKey = normalizeOptionalString(parsed.apiKey);
  if (apiKey) result.apiKey = apiKey;
  const baseUrl = normalizeOptionalString(parsed.baseUrl);
  if (baseUrl) result.baseUrl = baseUrl;
  const model = normalizeOptionalString(parsed.model);
  if (model) result.model = model;
  const contextWindowTokens = normalizePositiveInteger(parsed.contextWindowTokens);
  if (contextWindowTokens !== undefined) result.contextWindowTokens = contextWindowTokens;
  if (parsed.pricing) result.pricing = parsed.pricing;
  return result;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
