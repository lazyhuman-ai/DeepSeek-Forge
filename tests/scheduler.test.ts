import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { Scheduler } from "../src/core/scheduler.js";
import type { Trigger } from "../src/core/scheduler.js";
import { SessionThreadStore } from "../src/streams/session-thread-store.js";
import { NotificationHub } from "../src/core/notification-hub.js";
import { SystemStreamStore } from "../src/streams/system-stream-store.js";
import type { Session } from "../src/streams/event-types.js";

function makeTrigger(
  overrides: Partial<Trigger> = {},
): Trigger {
  return {
    id: "t1",
    sessionId: "s1",
    kind: "manual",
    payload: {},
    enabled: true,
    recurring: false,
    ...overrides,
  };
}

describe("Scheduler", () => {
  let sessions: Map<string, Session>;
  let threadStore: SessionThreadStore;
  let hub: NotificationHub;
  let systemStream: SystemStreamStore;
  let scheduler: Scheduler;
  let seq: number;

  function fakeNow(): string {
    return new Date().toISOString();
  }

  function makeSession(id: string, status: Session["status"] = "sleeping"): Session {
    const s: Session = {
      id,
      title: `session ${id}`,
      status,
      muted: false,
      createdAt: fakeNow(),
      updatedAt: fakeNow(),
    };
    sessions.set(id, s);
    return s;
  }

  beforeEach(() => {
    sessions = new Map();
    threadStore = new SessionThreadStore();
    hub = new NotificationHub();
    systemStream = new SystemStreamStore();
    seq = 1;
    scheduler = new Scheduler(
      threadStore,
      sessions,
      hub,
      systemStream,
      () => seq++,
      () => fakeNow(),
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it("fire appends TriggerEvent to thread", async () => {
    makeSession("s1", "sleeping");
    scheduler.schedule(makeTrigger());

    await scheduler.fire("t1");

    const thread = threadStore.getThread("s1");
    expect(thread).toHaveLength(1);
    expect(thread[0]!.type).toBe("trigger_event");
  });

  it("fire wakes sleeping session", async () => {
    const s = makeSession("s1", "sleeping");
    scheduler.schedule(makeTrigger());

    await scheduler.fire("t1");

    expect(s.status).toBe("running");
  });

  it("fire on archived session records event but does not wake", async () => {
    const s = makeSession("s1", "archived");
    scheduler.schedule(makeTrigger());

    await scheduler.fire("t1");

    expect(s.status).toBe("archived");
    // Event still recorded
    const thread = threadStore.getThread("s1");
    expect(thread).toHaveLength(1);
    expect(thread[0]!.type).toBe("trigger_event");
  });

  it("fire emits session event through hub", async () => {
    makeSession("s1", "sleeping");
    scheduler.schedule(makeTrigger());

    const received: string[] = [];
    hub.onSessionEvent((sid) => received.push(sid));

    await scheduler.fire("t1");
    expect(received).toEqual(["s1"]);
  });

  it("fire emits system event through hub", async () => {
    makeSession("s1", "sleeping");
    scheduler.schedule(makeTrigger());

    const received: string[] = [];
    hub.onSystemEvent((evt) => received.push(evt.detail));

    await scheduler.fire("t1");
    expect(received).toContain("trigger_fired");
  });

  it("fire disables non-recurring trigger", async () => {
    makeSession("s1", "sleeping");
    const trigger = makeTrigger({ recurring: false });
    scheduler.schedule(trigger);

    await scheduler.fire("t1");

    expect(trigger.enabled).toBe(false);
  });

  it("recurring trigger stays enabled after fire", async () => {
    makeSession("s1", "sleeping");
    const trigger = makeTrigger({ recurring: true, kind: "time", schedule: "1000", nextFire: Date.now() + 1000 });
    scheduler.schedule(trigger);

    await scheduler.fire("t1");

    expect(trigger.enabled).toBe(true);
  });

  it("cancel removes timer and disables trigger", () => {
    makeSession("s1", "sleeping");
    const trigger = makeTrigger({ kind: "time", nextFire: Date.now() + 5000 });
    scheduler.schedule(trigger);

    const result = scheduler.cancel("t1");

    expect(result).toBe(true);
    expect(trigger.enabled).toBe(false);
  });

  it("cancel returns false for unknown trigger", () => {
    expect(scheduler.cancel("nope")).toBe(false);
  });

  it("time-based trigger fires after delay", async () => {
    const s = makeSession("s1", "sleeping");
    const trigger = makeTrigger({
      kind: "time",
      nextFire: Date.now() + 1000,
      recurring: false,
    });
    scheduler.schedule(trigger);

    // Not fired yet
    expect(s.status).toBe("sleeping");

    await vi.advanceTimersByTimeAsync(1000);

    expect(s.status).toBe("running");
    const thread = threadStore.getThread("s1");
    expect(thread).toHaveLength(1);
    expect(thread[0]!.type).toBe("trigger_event");
  });

  it("recurring time-based trigger re-schedules after firing", async () => {
    makeSession("s1", "sleeping");
    const trigger = makeTrigger({
      kind: "time",
      schedule: "500",
      nextFire: Date.now() + 500,
      recurring: true,
    });
    scheduler.schedule(trigger);

    await vi.advanceTimersByTimeAsync(500);
    expect(threadStore.getThread("s1")).toHaveLength(1);

    // Reset session to sleeping so next fire can wake it again
    sessions.get("s1")!.status = "sleeping";

    await vi.advanceTimersByTimeAsync(500);
    expect(threadStore.getThread("s1")).toHaveLength(2);
  });

  it("listTriggers returns triggers for a session", () => {
    scheduler.schedule(makeTrigger({ id: "a", sessionId: "s1" }));
    scheduler.schedule(makeTrigger({ id: "b", sessionId: "s1" }));
    scheduler.schedule(makeTrigger({ id: "c", sessionId: "s2" }));

    expect(scheduler.listTriggers("s1")).toHaveLength(2);
    expect(scheduler.listTriggers("s2")).toHaveLength(1);
    expect(scheduler.listTriggers("s3")).toHaveLength(0);
  });

  it("getTrigger returns trigger by id", () => {
    const trigger = makeTrigger({ id: "my-trigger" });
    scheduler.schedule(trigger);

    expect(scheduler.getTrigger("my-trigger")).toBe(trigger);
    expect(scheduler.getTrigger("nope")).toBeUndefined();
  });

  it("stop clears all timers", async () => {
    makeSession("s1", "sleeping");
    scheduler.schedule(makeTrigger({
      kind: "time",
      nextFire: Date.now() + 1000,
    }));

    scheduler.stop();

    await vi.advanceTimersByTimeAsync(2000);

    // Trigger should not have fired
    expect(threadStore.getThread("s1")).toHaveLength(0);
  });

  it("fire is no-op for disabled trigger", async () => {
    makeSession("s1", "sleeping");
    const trigger = makeTrigger({ enabled: false });
    scheduler.schedule(trigger);

    await scheduler.fire("t1");

    expect(threadStore.getThread("s1")).toHaveLength(0);
  });

  it("fire is no-op for unknown trigger", async () => {
    await scheduler.fire("nope");
    // Should not throw
  });

  // ── New: onWake callback ──

  it("fire calls onWake when waking sleeping session", async () => {
    const onWakeCalls: string[] = [];
    const sched = new Scheduler(
      threadStore, sessions, hub, systemStream,
      () => seq++, () => fakeNow(),
      { onWake: async (sid) => { onWakeCalls.push(sid); } },
    );
    makeSession("s1", "sleeping");
    sched.schedule(makeTrigger());

    await sched.fire("t1");
    expect(onWakeCalls).toEqual(["s1"]);
    sched.stop();
  });

  it("fire does not call onWake for archived session", async () => {
    const onWakeCalls: string[] = [];
    const sched = new Scheduler(
      threadStore, sessions, hub, systemStream,
      () => seq++, () => fakeNow(),
      { onWake: async (sid) => { onWakeCalls.push(sid); } },
    );
    makeSession("s1", "archived");
    sched.schedule(makeTrigger());

    await sched.fire("t1");
    expect(onWakeCalls).toEqual([]);
    sched.stop();
  });

  // ── New: delete vs cancel ──

  it("delete fully removes trigger from store", () => {
    scheduler.schedule(makeTrigger({ id: "to-delete" }));
    expect(scheduler.getTrigger("to-delete")).toBeDefined();

    const result = scheduler.delete("to-delete");
    expect(result).toBe(true);
    expect(scheduler.getTrigger("to-delete")).toBeUndefined();
  });

  it("delete returns false for unknown trigger", () => {
    expect(scheduler.delete("nope")).toBe(false);
  });

  it("delete clears timer for time-based trigger", () => {
    const trigger = makeTrigger({ kind: "time", nextFire: Date.now() + 5000 });
    scheduler.schedule(trigger);

    scheduler.delete("t1");

    // Trigger should be gone
    expect(scheduler.getTrigger("t1")).toBeUndefined();
  });

  // ── New: listAllTriggers ──

  it("listAllTriggers returns triggers across all sessions", () => {
    scheduler.schedule(makeTrigger({ id: "a", sessionId: "s1" }));
    scheduler.schedule(makeTrigger({ id: "b", sessionId: "s2" }));

    const all = scheduler.listAllTriggers();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });

  // ── New: persistence ──

  it("static loadFromFile returns empty array for non-existent file", () => {
    const triggers = Scheduler.loadFromFile("/tmp/non-existent-forge-test.json");
    expect(triggers).toEqual([]);
  });

  it("static loadFromFile loads triggers from JSON file", () => {
    const path = "/tmp/forge-scheduler-test.json";
    const triggers: Trigger[] = [
      {
        id: "t1", sessionId: "s1", kind: "manual",
        payload: {}, enabled: true, recurring: false,
      },
    ];
    writeFileSync(path, JSON.stringify(triggers));

    const loaded = Scheduler.loadFromFile(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("t1");

    unlinkSync(path);
  });

  it("loadTriggers loads persisted triggers and arms timers", async () => {
    const triggers: Trigger[] = [
      {
        id: "persisted-t1",
        sessionId: "s1",
        kind: "time",
        nextFire: Date.now() + 500,
        payload: { test: true },
        enabled: true,
        recurring: false,
      },
    ];

    makeSession("s1", "sleeping");
    scheduler.loadTriggers(triggers);

    expect(scheduler.getTrigger("persisted-t1")).toBeDefined();

    await vi.advanceTimersByTimeAsync(500);
    expect(threadStore.getThread("s1")).toHaveLength(1);
    expect(threadStore.getThread("s1")[0]!.type).toBe("trigger_event");
  });

  it("loadTriggers recalculates expired nextFire times", () => {
    makeSession("s1", "sleeping");
    const triggers: Trigger[] = [
      {
        id: "expired",
        sessionId: "s1",
        kind: "time",
        schedule: "60000", // 60s interval
        nextFire: Date.now() - 10000, // already passed
        payload: {},
        enabled: true,
        recurring: true,
      },
    ];

    scheduler.loadTriggers(triggers);

    const loaded = scheduler.getTrigger("expired");
    expect(loaded).toBeDefined();
    // nextFire should have been recalculated to be in the future
    expect(loaded!.nextFire!).toBeGreaterThan(Date.now());
  });
});
