import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { getSchedulerForTools } from "./scheduler-shared.js";

export const cronDeleteTool: ExecutableToolDefinition = buildTool({
  name: "cron_delete",
  description: "Delete a scheduled trigger by ID. Only triggers belonging to the current session can be deleted.",
  params: {
    id: {
      type: "string",
      description: "The trigger ID (or prefix) to delete",
    },
  },
  handler: async (args, sessionId) => {
    const rawId = String(args.id || "").trim();
    if (!rawId) {
      return { output: "Error: trigger ID is required", isError: true };
    }

    const scheduler = getSchedulerForTools();
    if (!scheduler) {
      return { output: "Error: Scheduler not initialized.", isError: true };
    }

    // Find trigger by ID or prefix
    const triggers = scheduler.listTriggers(sessionId);
    const match = triggers.find(
      (t) => t.id === rawId || t.id.startsWith(rawId),
    );

    if (!match) {
      return {
        output: `Error: No trigger matching "${rawId}" found in this session.`,
        isError: true,
      };
    }

    const deleted = scheduler.delete(match.id);
    if (deleted) {
      return {
        output: `Deleted trigger ${match.id} (schedule: ${match.schedule || "manual"}).`,
        isError: false,
      };
    }

    return { output: `Error: Failed to delete trigger ${match.id}.`, isError: true };
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["scheduler.write"],
});
