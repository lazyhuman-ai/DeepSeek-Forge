import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RuntimeManager } from "../src/core/runtime-manager.js";
import { BrowserRuntime } from "../src/runtimes/browser/browser-runtime.js";
import { SessionThreadStore } from "../src/streams/session-thread-store.js";
import { NotificationHub } from "../src/core/notification-hub.js";
import { SystemStreamStore } from "../src/streams/system-stream-store.js";
import type { Session } from "../src/streams/event-types.js";

async function flushTimers(): Promise<void> {
  // Advance enough to resolve all pending setTimeout(1) in BrowserRuntime
  await vi.advanceTimersByTimeAsync(100);
}

describe("RuntimeManager", () => {
  let sessions: Map<string, Session>;
  let threadStore: SessionThreadStore;
  let hub: NotificationHub;
  let systemStream: SystemStreamStore;
  let manager: RuntimeManager;
  let browser: BrowserRuntime;
  let seq: number;
  function fakeNow(): string {
    return new Date().toISOString();
  }

  beforeEach(() => {
    sessions = new Map();
    threadStore = new SessionThreadStore();
    hub = new NotificationHub();
    systemStream = new SystemStreamStore();
    seq = 1;
    manager = new RuntimeManager(
      threadStore,
      sessions,
      hub,
      systemStream,
      () => seq++,
      () => fakeNow(),
    );
    browser = new BrowserRuntime();
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  function makeSession(id: string): Session {
    const s: Session = {
      id,
      title: `session ${id}`,
      status: "idle",
      muted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    sessions.set(id, s);
    return s;
  }

  it("registers and starts a runtime", async () => {
    manager.registerRuntime("chrome", browser);
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    expect(browser.status).toBe("online");
  });

  it("getStatus returns runtime status", async () => {
    manager.registerRuntime("chrome", browser);
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    expect(manager.getStatus("chrome")).toBe("online");
  });

  it("getStatus returns undefined for unknown runtime", () => {
    expect(manager.getStatus("nope")).toBeUndefined();
  });

  it("listRuntimes returns all registered", async () => {
    const b2 = new BrowserRuntime();
    manager.registerRuntime("chrome", browser);
    manager.registerRuntime("shell", b2);
    const promise = manager.startAll();
    await flushTimers();
    await promise;

    const list = manager.listRuntimes();
    expect(list).toHaveLength(2);
  });

  it("blocks affected sessions when runtime goes degraded", async () => {
    manager.registerRuntime("chrome", browser);
    const s = makeSession("s1");
    s.status = "running";
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    // Create tab AFTER startAll so the "online" status change doesn't write a recover event for this session
    await browser.createTab("s1");

    await browser.simulateFailure();
    expect(browser.status).toBe("degraded");
    expect(s.status).toBe("blocked");

    const thread = threadStore.getThread("s1");
    const details = thread.filter((e) => e.type === "runtime_event").map((e) => e.detail);
    expect(details).toContain("attached");
    expect(details).toContain("degraded");
  });

  it("records tab attachment and detachment as runtime events", async () => {
    manager.registerRuntime("chrome", browser);
    makeSession("s1");
    const promise = manager.startAll();
    await flushTimers();
    await promise;

    await browser.createTab("s1");
    await browser.closeTab("s1");

    const thread = threadStore.getThread("s1");
    const details = thread.filter((e) => e.type === "runtime_event").map((e) => e.detail);
    expect(details).toEqual(["attached", "detached"]);
    const attached = thread.find((e) => e.type === "runtime_event" && e.detail === "attached");
    expect(attached?.type).toBe("runtime_event");
    if (attached?.type === "runtime_event") {
      expect(attached.payload).toEqual({
        kind: "attachment",
        tabId: expect.stringContaining("tab_s1_"),
        targetInfo: null,
      });
    }
  });

  it("rehydrates latest attachment snapshot from runtime event payload", async () => {
    manager.registerRuntime("chrome", browser);
    makeSession("s1");
    threadStore.append("s1", {
      type: "runtime_event",
      seq: seq++,
      timestamp: fakeNow(),
      sessionId: "s1",
      runtimeKind: "chrome",
      detail: "attached",
      message: "human text without parseable ids",
      payload: {
        kind: "attachment",
        tabId: "tab-restored",
        targetInfo: null,
      },
    });

    const report = await manager.rehydrateFromThreads();

    expect(report.attachmentsRestored).toBe(1);
    expect(browser.tabs.getTab("s1")).toBe("tab-restored");
  });

  it("does not restore attachment when detached is the final payload event", async () => {
    manager.registerRuntime("chrome", browser);
    makeSession("s1");
    threadStore.append("s1", {
      type: "runtime_event",
      seq: seq++,
      timestamp: fakeNow(),
      sessionId: "s1",
      runtimeKind: "chrome",
      detail: "attached",
      message: "attached",
      payload: {
        kind: "attachment",
        tabId: "tab-restored",
        targetInfo: null,
      },
    });
    threadStore.append("s1", {
      type: "runtime_event",
      seq: seq++,
      timestamp: fakeNow(),
      sessionId: "s1",
      runtimeKind: "chrome",
      detail: "detached",
      message: "detached",
      payload: {
        kind: "attachment",
        tabId: "tab-restored",
        targetInfo: null,
      },
    });

    const report = await manager.rehydrateFromThreads();

    expect(report.attachmentsRestored).toBe(0);
    expect(browser.tabs.getTab("s1")).toBeUndefined();
  });

  it("reconstructs runtime-blocked ownership and recovers online runtimes", async () => {
    const onRecovered = vi.fn();
    manager.stop();
    manager = new RuntimeManager(
      threadStore,
      sessions,
      hub,
      systemStream,
      () => seq++,
      () => fakeNow(),
      { onRecovered },
    );
    manager.registerRuntime("chrome", browser);
    const s = makeSession("s1");
    s.status = "blocked";
    threadStore.append("s1", {
      type: "runtime_event",
      seq: seq++,
      timestamp: fakeNow(),
      sessionId: "s1",
      runtimeKind: "chrome",
      detail: "degraded",
      message: "Runtime chrome is degraded",
      payload: {
        kind: "runtime_block",
        blockedSession: true,
      },
    });

    const start = manager.startAll();
    await flushTimers();
    await start;
    const report = await manager.rehydrateFromThreads();

    expect(s.status).toBe("running");
    expect(report.runtimeBlockedSessions).toBe(1);
    expect(report.recoveredSessions).toEqual(["s1"]);
    expect(onRecovered).toHaveBeenCalledWith("s1");
    const recovered = threadStore
      .getThread("s1")
      .find((e) => e.type === "runtime_event" && e.detail === "recovered");
    expect(recovered?.type).toBe("runtime_event");
    if (recovered?.type === "runtime_event") {
      expect(recovered.payload).toEqual({
        kind: "runtime_recovered",
        recoveredSession: true,
      });
    }
  });

  it("does not recover blocked sessions without runtime block payload", async () => {
    const onRecovered = vi.fn();
    manager.stop();
    manager = new RuntimeManager(
      threadStore,
      sessions,
      hub,
      systemStream,
      () => seq++,
      () => fakeNow(),
      { onRecovered },
    );
    manager.registerRuntime("chrome", browser);
    const s = makeSession("s1");
    s.status = "blocked";
    threadStore.append("s1", {
      type: "runtime_event",
      seq: seq++,
      timestamp: fakeNow(),
      sessionId: "s1",
      runtimeKind: "core",
      detail: "failed",
      message: "Session blocked: ModelProvider is not set.",
    });

    const start = manager.startAll();
    await flushTimers();
    await start;
    const report = await manager.rehydrateFromThreads();

    expect(s.status).toBe("blocked");
    expect(report.recoveredSessions).toEqual([]);
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it("does not block sleeping or archived sessions", async () => {
    manager.registerRuntime("chrome", browser);
    const sSleeping = makeSession("s1");
    sSleeping.status = "sleeping";
    const sArchived = makeSession("s2");
    sArchived.status = "archived";
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    // Attach tabs after start so "online" event doesn't pre-write events
    await browser.createTab("s1");
    await browser.createTab("s2");

    await browser.simulateFailure();

    expect(sSleeping.status).toBe("sleeping");
    expect(sArchived.status).toBe("archived");
  });

  it("records runtime failure for idle sessions without illegal transition", async () => {
    manager.registerRuntime("chrome", browser);
    const s = makeSession("s1");
    s.status = "idle";
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    await browser.createTab("s1");

    await expect(browser.simulateFailure()).resolves.toBeUndefined();

    expect(s.status).toBe("idle");
    const thread = threadStore.getThread("s1");
    const details = thread.filter((e) => e.type === "runtime_event").map((e) => e.detail);
    expect(details).toContain("attached");
    expect(details).toContain("degraded");
  });

  it("recovers blocked sessions when runtime comes back online", async () => {
    manager.registerRuntime("chrome", browser);
    const s = makeSession("s1");
    s.status = "running";
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    // Attach tab after start so "online" event doesn't pre-write a recovery event
    await browser.createTab("s1");

    await browser.simulateFailure();
    expect(s.status).toBe("blocked");

    await browser.simulateFailure(); // degraded → recovering
    expect(browser.status).toBe("recovering");

    const recoverPromise = browser.recover();
    await flushTimers();
    await recoverPromise;
    expect(browser.status).toBe("online");

    expect(s.status).toBe("running");

    const thread = threadStore.getThread("s1");
    const details = thread.filter((e) => e.type === "runtime_event").map((e) => e.detail);
    expect(details).toContain("attached");
    expect(details).toContain("degraded");
    expect(details).toContain("recovered");
  });

  it("calls recovery callback after restoring a runtime-blocked session", async () => {
    const onRecovered = vi.fn();
    manager.stop();
    manager = new RuntimeManager(
      threadStore,
      sessions,
      hub,
      systemStream,
      () => seq++,
      () => fakeNow(),
      { onRecovered },
    );
    manager.registerRuntime("chrome", browser);
    const s = makeSession("s1");
    s.status = "running";
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    await browser.createTab("s1");

    await browser.simulateFailure();
    await browser.simulateFailure();
    const recoverPromise = browser.recover();
    await flushTimers();
    await recoverPromise;

    expect(s.status).toBe("running");
    expect(onRecovered).toHaveBeenCalledWith("s1");
  });

  it("calls blocked callback before blocking a running session", async () => {
    const onBlocked = vi.fn();
    manager.stop();
    manager = new RuntimeManager(
      threadStore,
      sessions,
      hub,
      systemStream,
      () => seq++,
      () => fakeNow(),
      { onBlocked },
    );
    manager.registerRuntime("chrome", browser);
    const s = makeSession("s1");
    s.status = "running";
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    await browser.createTab("s1");

    await browser.simulateFailure();

    expect(onBlocked).toHaveBeenCalledWith("s1");
    expect(s.status).toBe("blocked");
  });

  it("does not recover sessions blocked for non-runtime reasons", async () => {
    manager.registerRuntime("chrome", browser);
    const s = makeSession("s1");
    s.status = "blocked";
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    await browser.createTab("s1");

    await browser.simulateFailure();
    await browser.simulateFailure();
    const recoverPromise = browser.recover();
    await flushTimers();
    await recoverPromise;

    expect(s.status).toBe("blocked");
  });

  it("does not call recovery callback for non-runtime blocked sessions", async () => {
    const onRecovered = vi.fn();
    manager.stop();
    manager = new RuntimeManager(
      threadStore,
      sessions,
      hub,
      systemStream,
      () => seq++,
      () => fakeNow(),
      { onRecovered },
    );
    manager.registerRuntime("chrome", browser);
    const s = makeSession("s1");
    s.status = "blocked";
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    await browser.createTab("s1");

    await browser.simulateFailure();
    await browser.simulateFailure();
    const recoverPromise = browser.recover();
    await flushTimers();
    await recoverPromise;

    expect(s.status).toBe("blocked");
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it("health poll detects failure", async () => {
    manager.registerRuntime("chrome", browser);
    const promise = manager.startAll();
    await flushTimers();
    await promise;
    expect(browser.status).toBe("online");

    await browser.disconnect();
    expect(browser.status).toBe("offline");

    await vi.advanceTimersByTimeAsync(30_000);
    // Already offline, no-op but verifies polling doesn't crash
  });

  it("does not affect sessions without tabs on the runtime", async () => {
    manager.registerRuntime("chrome", browser);
    makeSession("no-tab-session");
    const promise = manager.startAll();
    await flushTimers();
    await promise;

    await browser.simulateFailure();

    const s = sessions.get("no-tab-session")!;
    expect(s.status).toBe("idle");
  });
});
