import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Scheduler } from "../../src/core/scheduler.js";
import { SessionThreadStore } from "../../src/streams/session-thread-store.js";
import { NotificationHub } from "../../src/core/notification-hub.js";
import { SystemStreamStore } from "../../src/streams/system-stream-store.js";
import { setSchedulerForTools } from "../../src/tools/built-in/scheduler-shared.js";
import { cronListTool } from "../../src/tools/built-in/cron-list.js";

type ToolResultLike = { output: unknown; isError: boolean };

async function runCronList(args: Record<string, unknown>, sessionId: string): Promise<ToolResultLike> {
  return await cronListTool.handler!(args, sessionId) as ToolResultLike;
}

describe("cron_list tool", () => {
  let scheduler: Scheduler;
  let seq: number;

  beforeEach(() => {
    seq = 1;
    scheduler = new Scheduler(
      new SessionThreadStore(),
      new Map(),
      new NotificationHub(),
      new SystemStreamStore(),
      () => seq++,
      () => new Date().toISOString(),
    );
    setSchedulerForTools(scheduler);
  });

  afterEach(() => {
    scheduler.stop();
    setSchedulerForTools(null);
  });

  it("lists triggers for the current session", async () => {
    scheduler.schedule({
      id: "t1", sessionId: "s1", kind: "time",
      schedule: "60000", nextFire: Date.now() + 60000,
      payload: {}, enabled: true, recurring: true,
    });
    scheduler.schedule({
      id: "t2", sessionId: "s1", kind: "manual",
      payload: {}, enabled: true, recurring: false,
    });
    scheduler.schedule({
      id: "t3", sessionId: "s2", kind: "time",
      schedule: "3600000", payload: {}, enabled: true, recurring: true,
    });

    const result = await runCronList({}, "s1");
    expect(result.isError).toBe(false);
    expect(String(result.output)).toContain("2 trigger(s)");
    expect(String(result.output)).toContain("t1");
    expect(String(result.output)).toContain("t2");
    expect(String(result.output)).not.toContain("t3");
  });

  it("returns empty message when no triggers exist", async () => {
    const result = await runCronList({}, "empty-session");
    expect(result.isError).toBe(false);
    expect(String(result.output)).toContain("No scheduled triggers");
  });

  it("returns error when scheduler not initialized", async () => {
    setSchedulerForTools(null);
    const result = await runCronList({}, "s1");
    expect(result.isError).toBe(true);
  });
});
