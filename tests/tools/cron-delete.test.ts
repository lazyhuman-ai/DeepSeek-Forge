import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Scheduler } from "../../src/core/scheduler.js";
import { SessionThreadStore } from "../../src/streams/session-thread-store.js";
import { NotificationHub } from "../../src/core/notification-hub.js";
import { SystemStreamStore } from "../../src/streams/system-stream-store.js";
import { setSchedulerForTools } from "../../src/tools/built-in/scheduler-shared.js";
import { cronDeleteTool } from "../../src/tools/built-in/cron-delete.js";

type ToolResultLike = { output: unknown; isError: boolean };

async function runCronDelete(args: Record<string, unknown>, sessionId: string): Promise<ToolResultLike> {
  return await cronDeleteTool.handler!(args, sessionId) as ToolResultLike;
}

describe("cron_delete tool", () => {
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

  it("deletes a trigger by exact ID", async () => {
    scheduler.schedule({
      id: "abc-123", sessionId: "s1", kind: "manual",
      payload: {}, enabled: true, recurring: false,
    });

    const result = await runCronDelete({ id: "abc-123" }, "s1");
    expect(result.isError).toBe(false);
    expect(String(result.output)).toContain("Deleted trigger");

    expect(scheduler.listTriggers("s1")).toHaveLength(0);
  });

  it("deletes a trigger by prefix", async () => {
    scheduler.schedule({
      id: "abcdef-12345", sessionId: "s1", kind: "manual",
      payload: {}, enabled: true, recurring: false,
    });

    const result = await runCronDelete({ id: "abc" }, "s1");
    expect(result.isError).toBe(false);
    expect(scheduler.listTriggers("s1")).toHaveLength(0);
  });

  it("returns error for non-existent trigger", async () => {
    const result = await runCronDelete({ id: "nonexistent" }, "s1");
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain("No trigger matching");
  });

  it("returns error for trigger from other session", async () => {
    scheduler.schedule({
      id: "other-trigger", sessionId: "s2", kind: "manual",
      payload: {}, enabled: true, recurring: false,
    });

    const result = await runCronDelete({ id: "other-trigger" }, "s1");
    expect(result.isError).toBe(true);
    expect(scheduler.listTriggers("s2")).toHaveLength(1); // still exists
  });

  it("returns error for empty id", async () => {
    const result = await runCronDelete({ id: "" }, "s1");
    expect(result.isError).toBe(true);
  });

  it("returns error when scheduler not initialized", async () => {
    setSchedulerForTools(null);
    const result = await runCronDelete({ id: "test" }, "s1");
    expect(result.isError).toBe(true);
  });
});
