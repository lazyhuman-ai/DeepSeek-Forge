export const FORGE_AGENT_APP_NAME = "DeepSeek-Forge";
export const LEGACY_FORGE_AGENT_APP_NAME = "ForgeAgent";
export const FORGE_AGENT_VERSION = "0.1.0";

export function isDeepSeekForgeAppName(value: unknown): boolean {
  return value === FORGE_AGENT_APP_NAME || value === LEGACY_FORGE_AGENT_APP_NAME;
}
