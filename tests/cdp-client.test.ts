import { describe, it, expect } from "vitest";
import { CdpClient, type CdpTransport } from "../src/runtimes/browser/cdp-client.js";

class MockCdpTransport implements CdpTransport {
  onMessage: ((data: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((err: Error) => void) | null = null;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onClose?.();
  }

  /** Simulate receiving a CDP message from the server */
  receive(data: string): void {
    this.onMessage?.(data);
  }

  /** Simulate receiving a CDP message as a JSON object */
  receiveJson(msg: unknown): void {
    this.receive(JSON.stringify(msg));
  }

  /** Get the last sent message parsed as JSON */
  lastSent(): unknown {
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }

  /** Get all sent messages parsed */
  allSent(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

describe("CdpClient", () => {
  it("send returns a promise that resolves with the response result", async () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const promise = client.send("Page.navigate", { url: "https://example.com" });

    const sent = transport.lastSent() as Record<string, unknown>;
    expect(sent.method).toBe("Page.navigate");
    expect(sent.params).toEqual({ url: "https://example.com" });
    expect(sent.id).toBe(1);

    transport.receiveJson({ id: 1, result: { frameId: "abc" } });
    const result = await promise;
    expect(result).toEqual({ frameId: "abc" });
  });

  it("send rejects on CDP error response", async () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const promise = client.send("Page.navigate", { url: "bad" });
    transport.receiveJson({
      id: 1,
      error: { code: -32000, message: "No such page" },
    });

    await expect(promise).rejects.toThrow("CDP error -32000: No such page");
  });

  it("send rejects when transport is closed", async () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const promise = client.send("Page.navigate", { url: "x" });
    transport.onClose?.();

    await expect(promise).rejects.toThrow("CDP transport closed");
  });

  it("send rejects when client is closed before response", async () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const promise = client.send("Page.navigate", { url: "x" });
    client.close();

    await expect(promise).rejects.toThrow("CDP client closed");
  });

  it("send after close returns rejected promise", async () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);
    client.close();

    await expect(
      client.send("Page.navigate", { url: "x" }),
    ).rejects.toThrow("CDP client is closed");
  });

  it("matches responses by id for concurrent commands", async () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const p1 = client.send("Page.navigate", { url: "a" });
    const p2 = client.send("Page.navigate", { url: "b" });
    const p3 = client.send("Runtime.evaluate", { expression: "1+1" });

    // Respond out of order
    transport.receiveJson({ id: 3, result: { value: 2 } });
    transport.receiveJson({ id: 1, result: { frameId: "f1" } });
    transport.receiveJson({ id: 2, result: { frameId: "f2" } });

    await expect(p1).resolves.toEqual({ frameId: "f1" });
    await expect(p2).resolves.toEqual({ frameId: "f2" });
    await expect(p3).resolves.toEqual({ value: 2 });
  });

  it("increments message ids", () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    client.send("A");
    client.send("B");
    client.send("C");

    const all = transport.allSent() as Array<Record<string, unknown>>;
    expect(all[0]!.id).toBe(1);
    expect(all[1]!.id).toBe(2);
    expect(all[2]!.id).toBe(3);
  });

  it("includes sessionId in messages when provided", () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    client.send("Page.navigate", { url: "x" }, "session-123");

    const sent = transport.lastSent() as Record<string, unknown>;
    expect(sent.sessionId).toBe("session-123");
  });

  it("onEvent receives matching events", () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const received: unknown[] = [];
    client.onEvent("Page.loadEventFired", (params) => {
      received.push(params);
    });

    transport.receiveJson({
      method: "Page.loadEventFired",
      params: { timestamp: 100 },
    });

    expect(received).toEqual([{ timestamp: 100 }]);
  });

  it("onEvent ignores non-matching methods", () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const received: unknown[] = [];
    client.onEvent("Page.loadEventFired", (params) => {
      received.push(params);
    });

    transport.receiveJson({
      method: "Network.requestWillBeSent",
      params: { requestId: "1" },
    });

    expect(received).toHaveLength(0);
  });

  it("onEvent respects sessionId filter", () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const received: unknown[] = [];
    client.onEvent("Page.loadEventFired", (params) => {
      received.push(params);
    }, "s1");

    // Event with matching sessionId
    transport.receiveJson({
      method: "Page.loadEventFired",
      sessionId: "s1",
      params: { timestamp: 100 },
    });
    // Event with different sessionId
    transport.receiveJson({
      method: "Page.loadEventFired",
      sessionId: "s2",
      params: { timestamp: 200 },
    });

    expect(received).toEqual([{ timestamp: 100 }]);
  });

  it("onEvent without sessionId filter receives all sessions", () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const received: unknown[] = [];
    client.onEvent("Page.loadEventFired", (params) => {
      received.push(params);
    });

    transport.receiveJson({
      method: "Page.loadEventFired",
      sessionId: "s1",
      params: { timestamp: 100 },
    });
    transport.receiveJson({
      method: "Page.loadEventFired",
      sessionId: "s2",
      params: { timestamp: 200 },
    });

    expect(received).toHaveLength(2);
  });

  it("unsubscribe removes event handler", () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    const received: unknown[] = [];
    const unsub = client.onEvent("Page.loadEventFired", (params) => {
      received.push(params);
    });

    unsub();

    transport.receiveJson({
      method: "Page.loadEventFired",
      params: { timestamp: 100 },
    });

    expect(received).toHaveLength(0);
  });

  it("ignores malformed JSON", () => {
    const transport = new MockCdpTransport();
    const client = new CdpClient(transport);

    // Should not throw
    transport.receive("not json");
  });
});
