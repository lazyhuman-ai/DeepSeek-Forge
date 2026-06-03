import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionSupervisor, transition, validTransitions } from "../src/core/session-supervisor.js";
import type { Session } from "../src/streams/event-types.js";

function makeSession(id: string, status: Session["status"] = "idle"): Session {
  return {
    id,
    title: `session ${id}`,
    status,
    muted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("SessionSupervisor — queue manager", () => {
  let sessions: Map<string, Session>;
  let runLog: string[];
  let runResolvers: Map<string, () => void>;
  let supervisor: SessionSupervisor;

  beforeEach(() => {
    sessions = new Map();
    runLog = [];
    runResolvers = new Map();

    const runTurn = async (sessionId: string): Promise<void> => {
      runLog.push(`start:${sessionId}`);
      return new Promise<void>((resolve) => {
        runResolvers.set(sessionId, () => {
          runLog.push(`end:${sessionId}`);
          resolve();
        });
      });
    };

    supervisor = new SessionSupervisor(sessions, 2, runTurn);
  });

  it("enqueues and runs a session turn", async () => {
    const s = makeSession("s1", "running");
    sessions.set("s1", s);

    const result = supervisor.enqueue("s1");
    expect(result).toBe(true);
    expect(supervisor.activeCount).toBe(1);
    expect(supervisor.isActive("s1")).toBe(true);
    expect(runLog).toContain("start:s1");
  });

  it("deduplicates — refuses to enqueue already active session", () => {
    const s = makeSession("s1", "running");
    sessions.set("s1", s);

    supervisor.enqueue("s1");
    const result = supervisor.enqueue("s1");
    expect(result).toBe(false);
    expect(supervisor.activeCount).toBe(1);
  });

  it("deduplicates — refuses to enqueue already queued session", () => {
    const s1 = makeSession("s1", "running");
    const s2 = makeSession("s2", "running");
    sessions.set("s1", s1);
    sessions.set("s2", s2);

    // Fill active slots with s1 and s2
    supervisor.enqueue("s1");
    supervisor.enqueue("s2");
    // s3 should be queued (active slots full)
    sessions.set("s3", makeSession("s3", "running"));
    supervisor.enqueue("s3");

    // Try to enqueue s3 again while it's still queued
    const result = supervisor.enqueue("s3");
    expect(result).toBe(false);
    expect(supervisor.queueLength).toBe(1); // s3 is in queue
  });

  it("respects maxConcurrent limit", () => {
    sessions.set("s1", makeSession("s1", "running"));
    sessions.set("s2", makeSession("s2", "running"));
    sessions.set("s3", makeSession("s3", "running"));

    supervisor.enqueue("s1");
    supervisor.enqueue("s2");
    supervisor.enqueue("s3");

    expect(supervisor.activeCount).toBe(2); // maxConcurrent=2
    expect(supervisor.queueLength).toBe(1); // s3 waiting
    expect(supervisor.isActive("s1")).toBe(true);
    expect(supervisor.isActive("s2")).toBe(true);
    expect(supervisor.isActive("s3")).toBe(false);
    expect(supervisor.isQueued("s3")).toBe(true);
  });

  it("drains queue when active slot frees up", async () => {
    sessions.set("s1", makeSession("s1", "running"));
    sessions.set("s2", makeSession("s2", "running"));
    sessions.set("s3", makeSession("s3", "running"));

    supervisor.enqueue("s1");
    supervisor.enqueue("s2");
    supervisor.enqueue("s3");

    expect(supervisor.activeCount).toBe(2);
    expect(supervisor.queueLength).toBe(1);

    // Complete s1 → s3 should start
    const resolveS1 = runResolvers.get("s1");
    expect(resolveS1).toBeDefined();
    resolveS1!();

    // Flush microtasks: resolve → finally → drain → enqueue s3
    await new Promise<void>((r) => setTimeout(r, 5));

    expect(supervisor.isActive("s2")).toBe(true);
    expect(supervisor.isActive("s3")).toBe(true);
    expect(supervisor.isActive("s1")).toBe(false);
    expect(supervisor.queueLength).toBe(0);
    expect(runLog).toContain("end:s1");
  });

  it("handles runTurn throwing gracefully", async () => {
    const sessions2 = new Map<string, Session>();
    sessions2.set("s1", makeSession("s1", "running"));
    sessions2.set("s2", makeSession("s2", "running"));

    let throwCount = 0;
    const failingSupervisor = new SessionSupervisor(sessions2, 2, async (sid) => {
      throwCount++;
      if (sid === "s1") throw new Error("simulated failure");
    });

    failingSupervisor.enqueue("s1");
    failingSupervisor.enqueue("s2");

    // s1 fails but s2 should still start (it's in a separate active slot)
    await vi.waitFor(() => throwCount >= 2, { timeout: 100 });
    expect(throwCount).toBeGreaterThanOrEqual(2);
  });

  it("refuses to enqueue session not in running status", () => {
    const s = makeSession("s1", "idle");
    sessions.set("s1", s);

    expect(supervisor.enqueue("s1")).toBe(false);
    expect(supervisor.activeCount).toBe(0);
  });

  it("refuses to enqueue non-existent session", () => {
    expect(supervisor.enqueue("nope")).toBe(false);
  });

  it("dequeues a queued session", () => {
    const s1 = makeSession("s1", "running");
    const s2 = makeSession("s2", "running");
    sessions.set("s1", s1);
    sessions.set("s2", s2);
    const blockingSupervisor = new SessionSupervisor(sessions, 1, async () => {
      await new Promise(() => undefined);
    });

    expect(blockingSupervisor.enqueue("s1")).toBe(true);
    expect(blockingSupervisor.enqueue("s2")).toBe(true);
    expect(blockingSupervisor.isQueued("s2")).toBe(true);
    expect(blockingSupervisor.dequeue("s2")).toBe(true);
    expect(blockingSupervisor.isQueued("s2")).toBe(false);
  });
});

describe("SessionSupervisor — transition and validTransitions still work", () => {
  it("transition from idle → running on user_message", () => {
    expect(transition("idle", { kind: "user_message" })).toBe("running");
  });

  it("transition from running → idle on turn_finished", () => {
    expect(transition("running", { kind: "turn_finished" })).toBe("idle");
  });

  it("throws on illegal transition", () => {
    expect(() => transition("idle", { kind: "turn_finished" })).toThrow();
  });

  it("validTransitions returns expected keys", () => {
    const vt = validTransitions("idle");
    expect(vt).toContain("user_message");
    expect(vt).toContain("trigger_fired");
    expect(vt).toContain("user_interrupt");
    expect(vt).toContain("user_archive");
  });

  it("archived accepts no transitions", () => {
    expect(validTransitions("archived")).toEqual([]);
  });
});
