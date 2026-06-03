import type { ExecutableToolDefinition } from "../schemas.js";

export const webSearchTool: ExecutableToolDefinition = {
  name: "web_search",
  description:
    "Search the web for current information. Use this to find up-to-date facts, news, prices, documentation, or any information that may have changed since your training data.",
  params: {},
  handler: async () => {
    throw new Error("web_search is server-side only");
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["network.http"],
  anthropicServerType: "web_search_20250305",
};
