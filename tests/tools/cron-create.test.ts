import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Scheduler } from "../../src/core/scheduler.js";
import { SessionThreadStore } from "../../src/streams/session-thread-store.js";
import { NotificationHub } from "../../src/core/notification-hub.js";
import { SystemStreamStore } from "../../src/streams/system-stream-store.js";
import { setSchedulerForTools } from "../../src/tools/built-in/scheduler-shared.js";
import { cronCreateTool } from "../../src/tools/built-in/cron-create.js";
import type { Session } from "../../src/streams/event-types.js";

type ToolResultLike = { output: unknown; isError: boolean };

async function runCronCreate(args: Record<string, unknown>, sessionId: string): Promise<ToolResultLike> {
  return await cronCreateTool.handler!(args, sessionId) as ToolResultLike;
}

describe("cron_create tool", () => {
  let scheduler: Scheduler;
  let sessions: Map<string, Session>;
  let seq: number;

  beforeEach(() => {
    sessions = new Map();
    seq = 1;
    scheduler = new Scheduler(
      new SessionThreadStore(),
      sessions,
      new NotificationHub(),
      new SystemStreamStore(),
      () => seq++,
      () => new Date().toISOString(),
    );
    setSchedulerForTools(scheduler);
    vi.useFakeTimers();
  });

  afterEach(() => {
    scheduler.stop();
    setSchedulerForTools(null);
    vi.useRealTimers();
  });

  it("creates a one-shot time trigger with ms interval", async () => {
    const result = await runCronCreate(
      { schedule: "60000", prompt: "check status", recurring: false },
      "session-1",
    );

    expect(result.isError).toBe(false);
    expect(String(result.output)).toContain("Created one-shot trigger");
    expect(String(result.output)).toContain("schedule: 60000");

    const triggers = scheduler.listTriggers("session-1");
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.kind).toBe("time");
    expect(triggers[0]!.recurring).toBe(false);
  });

  it("creates a recurring trigger with cron expression", async () => {
    const result = await runCronCreate(
      { schedule: "*/5 * * * *", prompt: "every 5 min check" },
      "session-2",
    );

    expect(result.isError).toBe(false);
    expect(String(result.output)).toContain("recurring");

    const triggers = scheduler.listTriggers("session-2");
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.recurring).toBe(true);
  });

  it("returns error for empty schedule", async () => {
    const result = await runCronCreate(
      { schedule: "", prompt: "test" },
      "s",
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain("Error");
  });

  it("returns error for empty prompt", async () => {
    const result = await runCronCreate(
      { schedule: "60000", prompt: "" },
      "s",
    );
    expect(result.isError).toBe(true);
  });

  it("returns error for invalid schedule", async () => {
    const result = await runCronCreate(
      { schedule: "not valid", prompt: "test" },
      "s",
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain("Error");
  });

  it("returns error when scheduler not initialized", async () => {
    setSchedulerForTools(null);
    const result = await runCronCreate(
      { schedule: "60000", prompt: "test" },
      "s",
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain("not initialized");
  });
});
