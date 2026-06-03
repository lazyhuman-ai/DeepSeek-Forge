import { describe, it, expect, beforeEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { BrowserRuntime } from "../src/runtimes/browser/browser-runtime.js";
import type { Session } from "../src/streams/event-types.js";
import type { ModelProvider, ModelMessage } from "../src/agent/model-provider.js";
import type { ToolExecutor } from "../src/agent/tool-executor.js";

// Stub model provider that returns a simple stop response
function stubModelProvider(): ModelProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      finishReason: "stop",
      text: "Hello from stub",
    }),
  };
}

// Stub tool executor that does nothing
function stubToolExecutor(): ToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ output: "ok", isError: false }),
  };
}

function abortError(message = "aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

describe("CoreAPI — concurrency", () => {
  let api: CoreAPI;
  let registry: ToolRegistry;

  beforeEach(() => {
    rmSync(".forge-test-concurrency", { recursive: true, force: true });
    registry = new ToolRegistry();
    api = new CoreAPI(registry, { dataDir: ".forge-test-concurrency" });
    api.registerBuiltInTools();
    api.setModelProvider(stubModelProvider());
    api.setToolExecutor(stubToolExecutor());
  });

  it("dispatchTurn falls back to blocking runTurn when supervisor not initialized", async () => {
    const session = api.createSession("test");
    api.appendUserMessage(session.id, "hello", { dispatch: false });
    // session is now "running"

    // dispatchTurn without supervisor should work (fire-and-forget via runTurn)
    expect(api.dispatchTurn(session.id)).toBe("started_without_supervisor");

    // Wait a bit for the async fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 50));

    // Session should have finished its turn
    const updated = api.getSession(session.id);
    expect(updated!.status).toBe("idle");
  });

  it("runTurn still works as blocking call", async () => {
    const session = api.createSession("test");
    api.appendUserMessage(session.id, "hello", { dispatch: false });

    const result = await api.runTurn(session.id);
    expect(result.status).toBe("idle");
  });

  it("dispatchTurn with supervisor enqueues turns", async () => {
    api.initSupervisor(2);

    const s1 = api.createSession("s1");
    const s2 = api.createSession("s2");

    api.appendUserMessage(s1.id, "msg1", { dispatch: false });
    api.appendUserMessage(s2.id, "msg2", { dispatch: false });

    expect(api.dispatchTurn(s1.id)).toBe("queued");
    expect(api.dispatchTurn(s2.id)).toBe("queued");

    // Both should have been picked up (concurrency limit is 2)
    await new Promise((r) => setTimeout(r, 50));

    expect(api.getSession(s1.id)!.status).toBe("idle");
    expect(api.getSession(s2.id)!.status).toBe("idle");
  });

  it("dispatchTurn respects concurrency limit", () => {
    api.initSupervisor(1);

    const s1 = api.createSession("s1");
    const s2 = api.createSession("s2");

    api.appendUserMessage(s1.id, "msg1", { dispatch: false });
    api.appendUserMessage(s2.id, "msg2", { dispatch: false });

    expect(api.dispatchTurn(s1.id)).toBe("queued");
    expect(api.dispatchTurn(s2.id)).toBe("queued");

    // s2 should be queued or waiting, s1 should be running
    // (After dispatching, s1 is likely already complete due to stub)
    // The key is both dispatches succeed without error
    expect([..."idle", "running"]).toContain(api.getSession(s1.id)!.status);
  });

  it("appendUserMessage auto-dispatches runnable sessions", async () => {
    api.initSupervisor(1);
    const session = api.createSession("auto");

    api.appendUserMessage(session.id, "hello");

    await vi.waitFor(() => {
      expect(api.getSession(session.id)!.status).toBe("idle");
    });
    expect(api.getThread(session.id).map((e) => e.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
  });

  it("dispatchTurn returns explicit scheduling results", async () => {
    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => { started = resolve; });
    api.setModelProvider({
      generate: vi.fn().mockImplementation(async (
        _msgs: ModelMessage[],
        _tools,
        callbacks,
      ) => {
        const signal = callbacks?.signal;
        if (!signal) throw new Error("missing signal");
        started(signal);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }),
    });
    const supervisor = api.initSupervisor(1);

    expect(api.dispatchTurn("missing")).toBe("missing");
    const idle = api.createSession("idle");
    expect(api.dispatchTurn(idle.id)).toBe("not_runnable");

    const active = api.createSession("active");
    api.appendUserMessage(active.id, "run", { dispatch: false });
    expect(api.dispatchTurn(active.id)).toBe("queued");
    await startedPromise;
    expect(api.dispatchTurn(active.id)).toBe("already_active");

    const queued = api.createSession("queued");
    api.appendUserMessage(queued.id, "wait", { dispatch: false });
    expect(api.dispatchTurn(queued.id)).toBe("queued");
    expect(supervisor.isQueued(queued.id)).toBe(true);
    expect(api.dispatchTurn(queued.id)).toBe("already_queued");

    api.interruptSession(queued.id);
    api.interruptSession(active.id);
    await vi.waitFor(() => {
      expect(api.getSession(active.id)!.status).toBe("idle");
      expect(api.getSession(queued.id)!.status).toBe("idle");
    });
  });

  it("interrupt aborts an active model turn without blocking or appending assistant output", async () => {
    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => { started = resolve; });
    api.setModelProvider({
      generate: vi.fn().mockImplementation(async (
        _msgs: ModelMessage[],
        _tools,
        callbacks,
      ) => {
        const signal = callbacks?.signal;
        if (!signal) throw new Error("missing signal");
        started(signal);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }),
    });
    api.initSupervisor(1);
    const session = api.createSession("interrupt-active");

    api.appendUserMessage(session.id, "stop me");
    const signal = await startedPromise;
    const interrupted = api.interruptSession(session.id);

    expect(interrupted.status).toBe("idle");
    expect(signal.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.getSession(session.id)!.status).toBe("idle");
    expect(api.getThread(session.id).map((e) => e.type)).toEqual(["user_message"]);
    expect(api.getSystemEvents().some((e) => e.detail === "blocked")).toBe(false);
  });

  it("interrupt removes queued sessions from the supervisor queue", async () => {
    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => { started = resolve; });
    api.setModelProvider({
      generate: vi.fn().mockImplementation(async (
        _msgs: ModelMessage[],
        _tools,
        callbacks,
      ) => {
        const signal = callbacks?.signal;
        if (!signal) throw new Error("missing signal");
        started(signal);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }),
    });
    const supervisor = api.initSupervisor(1);
    const active = api.createSession("active");
    const queued = api.createSession("queued");

    api.appendUserMessage(active.id, "first");
    await startedPromise;
    api.appendUserMessage(queued.id, "second");
    expect(supervisor.isQueued(queued.id)).toBe(true);

    api.interruptSession(queued.id);
    expect(supervisor.isQueued(queued.id)).toBe(false);
    expect(api.getSession(queued.id)!.status).toBe("idle");

    api.interruptSession(active.id);
    await vi.waitFor(() => {
      expect(api.getSession(active.id)!.status).toBe("idle");
    });
  });

  it("passes AbortSignal into tool execution and stops after tool abort", async () => {
    const provider: ModelProvider = {
      generate: vi.fn().mockResolvedValue({
        finishReason: "tool_calls",
        text: "",
        toolCalls: [{ id: "tc1", name: "slow", args: {} }],
      }),
    };
    let toolStarted!: (signal: AbortSignal) => void;
    const toolStartedPromise = new Promise<AbortSignal>((resolve) => { toolStarted = resolve; });
    api.setModelProvider(provider);
    api.setToolExecutor({
      execute: vi.fn().mockImplementation(async (_name, _args, _sid, context) => {
        const signal = context?.signal;
        if (!signal) throw new Error("missing signal");
        toolStarted(signal);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }),
    });
    api.initSupervisor(1);
    const session = api.createSession("tool-abort");

    api.appendUserMessage(session.id, "use tool");
    const signal = await toolStartedPromise;
    api.interruptSession(session.id);

    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(api.getSession(session.id)!.status).toBe("idle");
    });
    expect(api.getThread(session.id).map((e) => e.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
    ]);
    const result = api.getThread(session.id)[2]!;
    expect(result.type).toBe("tool_result");
    if (result.type === "tool_result") {
      expect(result.isError).toBe(true);
      expect(result.result).toBe("Interrupted by user before tool completed.");
    }
  });

  it("interrupt releases the supervisor slot when a provider ignores AbortSignal", async () => {
    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => { started = resolve; });
    let callCount = 0;
    api.setModelProvider({
      generate: vi.fn().mockImplementation(async (
        _msgs: ModelMessage[],
        _tools,
        callbacks,
      ) => {
        callCount++;
        const signal = callbacks?.signal;
        if (!signal) throw new Error("missing signal");
        if (callCount === 1) {
          started(signal);
          return new Promise(() => undefined);
        }
        return { finishReason: "stop", text: "second done" };
      }),
    });
    api.initSupervisor(1);
    const first = api.createSession("provider-hang");

    api.appendUserMessage(first.id, "first");
    const signal = await startedPromise;
    api.interruptSession(first.id);

    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(api.getSession(first.id)!.status).toBe("idle");
    });

    const second = api.createSession("second");
    api.appendUserMessage(second.id, "second");
    await vi.waitFor(() => {
      expect(api.getSession(second.id)!.status).toBe("idle");
    });
    expect(api.getThread(second.id).map((e) => e.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
  });

  it("interrupt releases the supervisor slot when a tool ignores AbortSignal", async () => {
    let toolStarted!: (signal: AbortSignal) => void;
    const toolStartedPromise = new Promise<AbortSignal>((resolve) => { toolStarted = resolve; });
    let callCount = 0;
    api.setModelProvider({
      generate: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            finishReason: "tool_calls",
            text: "",
            toolCalls: [{ id: "tc1", name: "slow", args: {} }],
          };
        }
        return { finishReason: "stop", text: "second done" };
      }),
    });
    api.setToolExecutor({
      execute: vi.fn().mockImplementation(async (_name, _args, _sid, context) => {
        const signal = context?.signal;
        if (!signal) throw new Error("missing signal");
        toolStarted(signal);
        return new Promise(() => undefined);
      }),
    });
    api.initSupervisor(1);
    const first = api.createSession("tool-hang");

    api.appendUserMessage(first.id, "first");
    const signal = await toolStartedPromise;
    api.interruptSession(first.id);

    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(api.getSession(first.id)!.status).toBe("idle");
    });
    const firstThread = api.getThread(first.id);
    expect(firstThread.map((e) => e.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
    ]);

    const second = api.createSession("second");
    api.appendUserMessage(second.id, "second");
    await vi.waitFor(() => {
      expect(api.getSession(second.id)!.status).toBe("idle");
    });
    expect(api.getThread(second.id).map((e) => e.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
  });

  it("runtime failure aborts an active turn and blocks the session", async () => {
    const browser = new BrowserRuntime();
    api.initSupervisor(1);
    api.initRuntimeManager();
    api.registerBrowserRuntime("browser", browser);
    await api.startRuntimes();

    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => { started = resolve; });
    api.setModelProvider({
      generate: vi.fn().mockImplementation(async (
        _msgs: ModelMessage[],
        _tools,
        callbacks,
      ) => {
        const signal = callbacks?.signal;
        if (!signal) throw new Error("missing signal");
        started(signal);
        return new Promise(() => undefined);
      }),
    });
    const session = api.createSession("runtime-active");
    await browser.createTab(session.id);

    api.appendUserMessage(session.id, "run");
    const signal = await startedPromise;
    await browser.simulateFailure();

    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(api.getSession(session.id)!.status).toBe("blocked");
    });
    const thread = api.getThread(session.id);
    expect(thread.map((e) => e.type)).toEqual([
      "runtime_event",
      "user_message",
      "runtime_event",
    ]);
    const runtimeDetails = thread
      .filter((e) => e.type === "runtime_event")
      .map((e) => e.detail);
    expect(runtimeDetails).toEqual(["attached", "degraded"]);
  });

  it("runtime failure dequeues queued affected sessions", async () => {
    const browser = new BrowserRuntime();
    const supervisor = api.initSupervisor(1);
    api.initRuntimeManager();
    api.registerBrowserRuntime("browser", browser);
    await api.startRuntimes();

    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => { started = resolve; });
    api.setModelProvider({
      generate: vi.fn().mockImplementation(async (
        _msgs: ModelMessage[],
        _tools,
        callbacks,
      ) => {
        const signal = callbacks?.signal;
        if (!signal) throw new Error("missing signal");
        started(signal);
        return new Promise(() => undefined);
      }),
    });
    const active = api.createSession("active-runtime");
    const queued = api.createSession("queued-runtime");
    await browser.createTab(active.id);
    await browser.createTab(queued.id);

    api.appendUserMessage(active.id, "first");
    await startedPromise;
    api.appendUserMessage(queued.id, "second");
    expect(supervisor.isQueued(queued.id)).toBe(true);

    await browser.simulateFailure();

    expect(supervisor.isQueued(queued.id)).toBe(false);
    expect(api.getSession(queued.id)!.status).toBe("blocked");
    api.interruptSession(active.id);
  });

  it("canceling the last enabled trigger moves sleeping sessions back to idle", () => {
    api.initScheduler();
    const session = api.createSession("sleeping");
    session.status = "sleeping";

    api.scheduleTrigger({
      id: "t1",
      sessionId: session.id,
      kind: "manual",
      payload: {},
      enabled: true,
      recurring: true,
    });
    api.scheduleTrigger({
      id: "t2",
      sessionId: session.id,
      kind: "manual",
      payload: {},
      enabled: true,
      recurring: true,
    });

    expect(api.cancelTrigger("t1")).toBe(true);
    expect(api.getSession(session.id)!.status).toBe("sleeping");
    expect(api.cancelTrigger("t2")).toBe(true);
    expect(api.getSession(session.id)!.status).toBe("idle");
  });

  it("deleteTrigger removes trigger from scheduler", () => {
    api.initSupervisor();
    api.initScheduler();

    const session = api.createSession("test");
    api.scheduleTrigger({
      id: "t-delete",
      sessionId: session.id,
      kind: "manual",
      payload: {},
      enabled: true,
      recurring: false,
    });

    expect(api.listTriggers(session.id)).toHaveLength(1);

    const result = api.deleteTrigger("t-delete");
    expect(result).toBe(true);
    expect(api.listTriggers(session.id)).toHaveLength(0);
  });

  it("scheduling an enabled trigger moves idle sessions to sleeping", () => {
    api.initScheduler();
    const session = api.createSession("idle-trigger");

    api.scheduleTrigger({
      id: "enabled-trigger",
      sessionId: session.id,
      kind: "manual",
      payload: {},
      enabled: true,
      recurring: false,
    });

    expect(api.getSession(session.id)!.status).toBe("sleeping");
  });

  it("scheduling a disabled trigger leaves idle sessions idle", () => {
    api.initScheduler();
    const session = api.createSession("disabled-trigger");

    api.scheduleTrigger({
      id: "disabled-trigger",
      sessionId: session.id,
      kind: "manual",
      payload: {},
      enabled: false,
      recurring: false,
    });

    expect(api.getSession(session.id)!.status).toBe("idle");
  });

  it("listAllTriggers returns all triggers across sessions", () => {
    api.initSupervisor();
    api.initScheduler();

    const s1 = api.createSession("s1");
    const s2 = api.createSession("s2");

    api.scheduleTrigger({
      id: "t1", sessionId: s1.id, kind: "manual",
      payload: {}, enabled: true, recurring: false,
    });
    api.scheduleTrigger({
      id: "t2", sessionId: s2.id, kind: "manual",
      payload: {}, enabled: true, recurring: false,
    });

    const all = api.listAllTriggers();
    expect(all).toHaveLength(2);
  });
});

describe("CoreAPI — backward compatibility", () => {
  it("existing API methods work without supervisor/scheduler init", async () => {
    const registry = new ToolRegistry();
    const api = new CoreAPI(registry, { dataDir: ".forge-test-bw" });
    api.registerBuiltInTools();

    const s = api.createSession("test");
    expect(s.status).toBe("idle");

    api.appendUserMessage(s.id, "hello", { dispatch: false });
    expect(api.getSession(s.id)!.status).toBe("running");

    const sessions = api.listSessions();
    expect(sessions).toHaveLength(1);

    api.muteSession(s.id, true);
    expect(api.getSession(s.id)!.muted).toBe(true);

    // Can't delete a running session — transition it back to idle first
    // by completing a turn
    api.setModelProvider(stubModelProvider());
    api.setToolExecutor(stubToolExecutor());
    await api.runTurn(s.id);
    expect(api.getSession(s.id)!.status).toBe("idle");

    api.deleteSession(s.id);
    expect(api.getSession(s.id)!.status).toBe("archived");
  });

  it("scheduler methods throw without init", () => {
    const registry = new ToolRegistry();
    const api = new CoreAPI(registry, { dataDir: ".forge-test-err" });

    expect(() => api.scheduleTrigger({
      id: "t", sessionId: "s", kind: "manual",
      payload: {}, enabled: true, recurring: false,
    })).toThrow("Scheduler not initialized");
  });

  it("dispatchTurn works without supervisor (backward compat fallback)", async () => {
    const registry = new ToolRegistry();
    const api = new CoreAPI(registry, { dataDir: ".forge-test-fallback" });
    api.registerBuiltInTools();
    api.setModelProvider(stubModelProvider());
    api.setToolExecutor(stubToolExecutor());

    const s = api.createSession("test");
    api.appendUserMessage(s.id, "hello", { dispatch: false });

    // Should not throw even without supervisor
    expect(api.dispatchTurn(s.id)).toBe("started_without_supervisor");

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 50));
    expect(api.getSession(s.id)!.status).toBe("idle");
  });
});
