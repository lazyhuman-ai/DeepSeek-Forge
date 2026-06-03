import { describe, expect, it } from "vitest";
import { WebridgeRuntime } from "../src/runtimes/webridge/webridge-runtime.js";

describe("WebridgeRuntime", () => {
  it("queues browser commands for a connected Chrome extension client", async () => {
    const runtime = new WebridgeRuntime({ commandTimeoutMs: 1_000 });
    const client = runtime.registerClient({ name: "ForgeWebridge Test" });

    const createPromise = runtime.createTab("s1");
    const command = await runtime.pollCommand(client.clientId, 10);

    expect(command).toMatchObject({
      kind: "create_tab",
      sessionId: "s1",
      payload: {},
    });

    runtime.submitResult(client.clientId, {
      commandId: command!.id,
      ok: true,
      output: { tabId: "tab-1" },
    });

    await expect(createPromise).resolves.toBe("tab-1");
  });

  it("sends follow-up commands with the session tab id", async () => {
    const runtime = new WebridgeRuntime({ commandTimeoutMs: 1_000 });
    const client = runtime.registerClient();

    const createPromise = runtime.createTab("s1");
    const createCommand = await runtime.pollCommand(client.clientId, 10);
    runtime.submitResult(client.clientId, {
      commandId: createCommand!.id,
      ok: true,
      output: { tabId: "tab-1" },
    });
    await createPromise;

    const navigatePromise = runtime.navigate("s1", "https://example.com");
    const navigateCommand = await runtime.pollCommand(client.clientId, 10);
    expect(navigateCommand).toMatchObject({
      kind: "navigate",
      sessionId: "s1",
      tabId: "tab-1",
      payload: { url: "https://example.com" },
    });

    runtime.submitResult(client.clientId, {
      commandId: navigateCommand!.id,
      ok: true,
    });
    await expect(navigatePromise).resolves.toBeUndefined();
  });

  it("returns a readable setup error when no extension client is connected", async () => {
    const runtime = new WebridgeRuntime({ commandTimeoutMs: 1_000 });

    await expect(runtime.createTab("s1")).rejects.toThrow("ForgeWebridge Chrome extension is offline");
    await expect(runtime.createTab("s1")).rejects.toThrow("refresh the extension from chrome://extensions");
  });

  it("re-registers a stale extension client id after gateway restart", async () => {
    const runtime = new WebridgeRuntime({ commandTimeoutMs: 1_000 });

    await expect(runtime.pollCommand("stale-client", 1)).resolves.toBeNull();

    expect(runtime.listClients()).toEqual([
      expect.objectContaining({
        clientId: "stale-client",
        name: "ForgeWebridge",
      }),
    ]);
  });

  it("reports online, stale, and offline health from lastSeenAt", () => {
    let currentMs = Date.parse("2026-01-01T00:00:00.000Z");
    const runtime = new WebridgeRuntime({
      commandTimeoutMs: 1_000,
      staleAfterMs: 1_000,
      offlineAfterMs: 2_000,
      healthCheckIntervalMs: 0,
      now: () => new Date(currentMs).toISOString(),
    });

    runtime.registerClient({ clientId: "client-1" });
    expect(runtime.getHealth().state).toBe("online");
    expect(runtime.listClients()[0]!.health).toBe("online");

    currentMs += 1_500;
    expect(runtime.getHealth().state).toBe("stale");
    expect(runtime.listClients()[0]!.health).toBe("stale");

    currentMs += 1_000;
    expect(runtime.getHealth().state).toBe("offline");
    expect(runtime.listClients()[0]!.health).toBe("offline");
  });

  it("heartbeat refreshes stale clients and restores online health", () => {
    let currentMs = Date.parse("2026-01-01T00:00:00.000Z");
    const runtime = new WebridgeRuntime({
      commandTimeoutMs: 1_000,
      staleAfterMs: 1_000,
      offlineAfterMs: 2_000,
      healthCheckIntervalMs: 0,
      now: () => new Date(currentMs).toISOString(),
    });

    runtime.registerClient({ clientId: "client-1", name: "ForgeWebridge" });
    currentMs += 1_500;
    expect(runtime.getHealth().state).toBe("stale");

    runtime.heartbeatClient({ clientId: "client-1", name: "ForgeWebridge", extensionState: "polling" });

    expect(runtime.getHealth().state).toBe("online");
    expect(runtime.listClients()[0]).toEqual(expect.objectContaining({
      clientId: "client-1",
      extensionState: "polling",
    }));
  });

  it("fails browser commands fast when all known clients are offline", async () => {
    let currentMs = Date.parse("2026-01-01T00:00:00.000Z");
    const runtime = new WebridgeRuntime({
      commandTimeoutMs: 1_000,
      staleAfterMs: 1_000,
      offlineAfterMs: 2_000,
      healthCheckIntervalMs: 0,
      now: () => new Date(currentMs).toISOString(),
    });

    runtime.registerClient({ clientId: "client-1", name: "ForgeWebridge" });
    currentMs += 3_000;

    await expect(runtime.createTab("s1")).rejects.toThrow("ForgeWebridge Chrome extension is offline");
  });

  it("releases long-poll waiters on shutdown", async () => {
    const runtime = new WebridgeRuntime({ commandTimeoutMs: 1_000 });
    const client = runtime.registerClient();

    const poll = runtime.pollCommand(client.clientId, 10_000);
    runtime.shutdown();

    await expect(poll).resolves.toBeNull();
  });

  it("does not create new long-poll waiters after shutdown", async () => {
    const runtime = new WebridgeRuntime({ commandTimeoutMs: 1_000 });
    const client = runtime.registerClient();

    runtime.shutdown();

    await expect(runtime.pollCommand(client.clientId, 10_000)).resolves.toBeNull();
    await expect(runtime.pollCommand("stale-client", 10_000)).resolves.toBeNull();
  });

  it("rejects new commands after shutdown with a readable error", async () => {
    const runtime = new WebridgeRuntime({ commandTimeoutMs: 1_000 });
    runtime.registerClient();

    runtime.shutdown();

    await expect(runtime.createTab("s1")).rejects.toThrow("ForgeWebridge runtime is shutting down");
  });
});
