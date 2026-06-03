import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { getMemoryStoreForTools } from "./memory-shared.js";

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
): Promise<unknown> {
  const memoryStore = getMemoryStoreForTools();
  if (!memoryStore) {
    return "Memory store is not available. The system may not have memory persistence configured.";
  }

  const id = typeof args.id === "string" ? args.id.trim() : undefined;
  const path = typeof args.path === "string" ? args.path.trim() : undefined;
  if (!id && !path) {
    return "memory_get requires either id or path.";
  }

  const offset = typeof args.offset === "number" && Number.isFinite(args.offset)
    ? Math.max(0, Math.floor(args.offset))
    : 0;
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(50_000, Math.floor(args.limit)))
    : 50_000;

  const result = memoryStore.read({ id, path }, { offset, limit });
  if (result === null) {
    return id ? `Memory not found: ${id}` : `Memory path not found or not allowed: ${path}`;
  }
  return result;
}

export const memoryGetTool: ExecutableToolDefinition = buildTool({
  name: "memory_get",
  description: "Read an exact long-term memory excerpt by id or source path returned from memory_search.",
  params: {
    id: {
      type: "string",
      description: "Memory id returned by memory_search",
      optional: true,
    },
    path: {
      type: "string",
      description: "Memory source path returned by memory_search",
      optional: true,
    },
    offset: {
      type: "number",
      description: "Character offset to start reading from",
      optional: true,
    },
    limit: {
      type: "number",
      description: "Maximum characters to read (default and max 50000)",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["memory.read"],
  maxResultSizeChars: Infinity,
});
