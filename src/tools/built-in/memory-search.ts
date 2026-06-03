import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { getMemoryStoreForTools } from "./memory-shared.js";
import type { MemoryType } from "../../memory/memory-store.js";

const VALID_TYPES = new Set<MemoryType>(["instruction", "profile", "project", "procedure", "episode"]);

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
): Promise<unknown> {
  const memoryStore = getMemoryStoreForTools();
  if (!memoryStore) {
    return "Memory store is not available. The system may not have memory persistence configured.";
  }

  const query = typeof args.query === "string" ? args.query : "";

  if (!query || query.trim().length === 0) {
    return "Search query cannot be empty.";
  }

  const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(50, Math.floor(args.limit)))
    : 20;
  const types = Array.isArray(args.types)
    ? args.types.filter((value): value is MemoryType => typeof value === "string" && VALID_TYPES.has(value as MemoryType))
    : undefined;
  const results = memoryStore.searchDetailed(query, { types, limit });

  if (results.length === 0) {
    return `No memories found matching "${query}".`;
  }

  const formatted = results
    .map(
      (r) =>
        [
          `[${r.entry.id.slice(0, 8)}] ${r.entry.type} | score=${r.score.toFixed(2)} | updated=${new Date(r.entry.updatedAt).toLocaleDateString()}`,
          `Title: ${r.entry.title}`,
          `Source: ${r.source}`,
          `Snippet: ${r.snippet}`,
        ].join("\n"),
    )
    .join("\n\n");

  return `Found ${results.length} memories matching "${query}":\n\n${formatted}`;
}

export const memorySearchTool: ExecutableToolDefinition = buildTool({
  name: "memory_search",
  description: `Search saved memories for relevant information.

Usage:
- Searches memory title, tags, type, and content using lexical ranking.
- Returns short snippets only. Use memory_get with the returned id or source path before relying on exact details.
- Use this to recall past context, user preferences, previous decisions, procedures, or project history.`,
  params: {
    query: {
      type: "string",
      description: "The search query to find relevant memories",
    },
    types: {
      type: "array",
      description: "Optional memory types to search: instruction, profile, project, procedure, episode",
      items: { type: "string", description: "Memory type" },
      optional: true,
    },
    limit: {
      type: "number",
      description: "Maximum number of results to return (default 20, max 50)",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["memory.read"],
});
