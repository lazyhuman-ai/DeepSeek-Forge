import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import type { MemoryStore, MemoryType } from "../../memory/memory-store.js";
import { getMemoryStoreForTools } from "./memory-shared.js";

const VALID_TYPES = new Set<MemoryType>(["instruction", "profile", "project", "procedure", "episode"]);

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
): Promise<unknown> {
  const memoryStore = getMemoryStoreForTools();
  if (!memoryStore) {
    return "Memory store is not available. The system may not have memory persistence configured.";
  }

  const content = typeof args.content === "string" ? args.content : "";
  const typeArg = typeof args.type === "string" ? args.type : undefined;
  const legacyKind = typeof args.kind === "string" ? args.kind : undefined;
  const type = typeArg && VALID_TYPES.has(typeArg as MemoryType)
    ? typeArg as MemoryType
    : legacyKind === "episode"
      ? "episode"
      : legacyKind === "procedure"
        ? "procedure"
        : "project";
  const title = typeof args.title === "string" ? args.title : undefined;
  const tags = Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : [];

  if (!content || content.trim().length === 0) {
    return "Cannot save empty memory.";
  }

  try {
    const entry = memoryStore.store({
      sessionId,
      type,
      title,
      content,
      tags,
      sources: [{ sessionId, note: "memory_add" }],
    });

    return [
      `Memory saved [${entry.id.slice(0, 8)}]: type=${entry.type}, tags=[${entry.tags.join(", ")}]`,
      `Source: ${memoryStore.relativePath(entry.path)}`,
    ].join("\n");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export const memoryAddTool: ExecutableToolDefinition = buildTool({
  name: "memory_add",
  description: `Save a persistent long-term memory entry. Memories survive across sessions and can be searched later.

Usage:
- Use this when the user explicitly asks you to remember something, or when you are highly confident a stable user/project/procedure fact should persist.
- Include relevant tags to make the memory easier to find later.
- Choose type: "instruction" (durable user/project rules), "profile" (user preferences/background), "project" (stable project facts/decisions), "procedure" (reusable workflow), or "episode" (specific past event).`,
  params: {
    content: {
      type: "string",
      description: "The memory content to save",
    },
    title: {
      type: "string",
      description: "Short title for the memory",
      optional: true,
    },
    type: {
      type: "string",
      description: "Memory type: instruction, profile, project, procedure, or episode (default: project)",
      optional: true,
    },
    kind: {
      type: "string",
      description: "Deprecated compatibility field: fact, episode, or procedure",
      optional: true,
    },
    tags: {
      type: "array",
      description: "Tags to categorize the memory for later searching",
      items: { type: "string", description: "A memory tag" },
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["memory.write"],
});
