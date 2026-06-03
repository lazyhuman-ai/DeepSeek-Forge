import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { validateSchedule, parseCronSchedule } from "../../core/cron-parser.js";
import { getSchedulerForTools } from "./scheduler-shared.js";

export const cronCreateTool: ExecutableToolDefinition = buildTool({
  name: "cron_create",
  description: `Schedule a recurring or one-shot trigger for the current session.

The schedule can be:
- A millisecond interval as a string (e.g. "60000" for every minute)
- A 5-field cron expression: "M H DoM Mon DoW"
  Examples: "*/5 * * * *" (every 5 min), "0 9 * * 1-5" (weekdays 9am), "0 0 1 * *" (midnight on 1st)

The prompt is injected as a trigger event into this session's thread when the trigger fires.
Set recurring=false for one-shot triggers that auto-delete after firing.`,
  params: {
    schedule: {
      type: "string",
      description: "Cron expression (5-field: 'M H DoM Mon DoW') or ms interval as string (e.g. '60000')",
    },
    prompt: {
      type: "string",
      description: "The prompt/message to inject when this trigger fires",
    },
    recurring: {
      type: "boolean",
      description: "Whether this trigger repeats (default: true). Set false for one-shot.",
      optional: true,
    },
  },
  handler: async (args, sessionId) => {
    const schedule = String(args.schedule || "");
    const prompt = String(args.prompt || "");
    const recurring = args.recurring !== false;

    if (!schedule) {
      return { output: "Error: schedule is required", isError: true };
    }
    if (!prompt) {
      return { output: "Error: prompt is required", isError: true };
    }

    const validationError = validateSchedule(schedule);
    if (validationError) {
      return { output: `Error: ${validationError}`, isError: true };
    }

    const scheduler = getSchedulerForTools();
    if (!scheduler) {
      return { output: "Error: Scheduler not initialized. Call api.initScheduler() first.", isError: true };
    }

    const parsed = parseCronSchedule(schedule);
    const id = crypto.randomUUID();

    const trigger = {
      id,
      sessionId,
      kind: "time",
      schedule,
      payload: { prompt },
      enabled: true,
      recurring,
    } as const;

    scheduler.schedule(parsed
      ? { ...trigger, nextFire: parsed.nextFire }
      : trigger);

    const nextFireStr = parsed ? new Date(parsed.nextFire).toISOString() : "unknown";
    const type = recurring ? "recurring" : "one-shot";

    return {
      output: `Created ${type} trigger ${id} (schedule: ${schedule}). Next fire: ${nextFireStr}`,
      isError: false,
    };
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["scheduler.write"],
});
