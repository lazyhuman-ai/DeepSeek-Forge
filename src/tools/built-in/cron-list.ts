import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { getSchedulerForTools } from "./scheduler-shared.js";

export const cronListTool: ExecutableToolDefinition = buildTool({
  name: "cron_list",
  description: "List all scheduled triggers for the current session.",
  params: {},
  handler: async (_args, sessionId) => {
    const scheduler = getSchedulerForTools();
    if (!scheduler) {
      return { output: "Error: Scheduler not initialized.", isError: true };
    }

    const triggers = scheduler.listTriggers(sessionId);

    if (triggers.length === 0) {
      return { output: "No scheduled triggers for this session.", isError: false };
    }

    const lines = triggers.map((t) => {
      const nextFire = t.nextFire ? new Date(t.nextFire).toISOString() : "N/A";
      const status = t.enabled ? "enabled" : "disabled";
      return `  ${t.id.slice(0, 8)}  ${t.kind}  ${status}  schedule=${t.schedule || "manual"}  next=${nextFire}  recurring=${t.recurring}`;
    });

    return {
      output: `${triggers.length} trigger(s):\n${lines.join("\n")}`,
      isError: false,
    };
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["scheduler.read"],
});
