import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TabManager } from "../src/runtimes/browser/tab-manager.js";
import { BrowserRuntime, type LinkInfo } from "../src/runtimes/browser/browser-runtime.js";
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

  receive(data: string): void {
    this.onMessage?.(data);
  }

  receiveJson(msg: unknown): void {
    this.receive(JSON.stringify(msg));
  }

  lastSent(): unknown {
    if (this.sent.length === 0) throw new Error("No sent messages");
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }

  allSent(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

describe("TabManager", () => {
  let tabs: TabManager;

  beforeEach(() => {
    tabs = new TabManager();
  });

  it("attaches and retrieves a tab", () => {
    tabs.attach("s1", "tab_1");
    expect(tabs.getTab("s1")).toBe("tab_1");
  });

  it("returns undefined for unknown session", () => {
    expect(tabs.getTab("nope")).toBeUndefined();
  });

  it("detaches a session", () => {
    tabs.attach("s1", "tab_1");
    tabs.detach("s1");
    expect(tabs.getTab("s1")).toBeUndefined();
  });

  it("getSessions returns all session IDs with tabs", () => {
    tabs.attach("s1", "tab_1");
    tabs.attach("s2", "tab_2");
    const sessions = tabs.getSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions).toContain("s1");
    expect(sessions).toContain("s2");
  });

  it("getSessions excludes detached sessions", () => {
    tabs.attach("s1", "tab_1");
    tabs.attach("s2", "tab_2");
    tabs.detach("s1");
    expect(tabs.getSessions()).toEqual(["s2"]);
  });

  it("list returns a readonly map", () => {
    tabs.attach("s1", "tab_a");
    tabs.attach("s2", "tab_b");
    const map = tabs.list();
    expect(map.get("s1")).toBe("tab_a");
    expect(map.get("s2")).toBe("tab_b");
    expect(map.size).toBe(2);
  });

  it("overwrites tab for same session", () => {
    tabs.attach("s1", "tab_old");
    tabs.attach("s1", "tab_new");
    expect(tabs.getTab("s1")).toBe("tab_new");
    expect(tabs.getSessions()).toHaveLength(1);
  });

  it("stores and retrieves target info", () => {
    tabs.attach("s1", "tab_1", { targetId: "t1", cdpSessionId: "cs1" });
    const info = tabs.getTargetInfo("s1");
    expect(info).toEqual({ targetId: "t1", cdpSessionId: "cs1" });
    expect(tabs.getTab("s1")).toBe("tab_1");
  });

  it("restores a tab entry without emitting attachment changes", () => {
    const changes: unknown[] = [];
    tabs.onAttachmentChange((change) => changes.push(change));

    tabs.restore("s1", {
      tabId: "tab_restored",
      targetInfo: { targetId: "t1", cdpSessionId: "cs1" },
    });

    expect(tabs.getTab("s1")).toBe("tab_restored");
    expect(tabs.getTargetInfo("s1")).toEqual({ targetId: "t1", cdpSessionId: "cs1" });
    expect(changes).toHaveLength(0);
  });

  it("forgets a restored tab entry without emitting attachment changes", () => {
    const changes: unknown[] = [];
    tabs.restore("s1", { tabId: "tab_restored", targetInfo: null });
    tabs.onAttachmentChange((change) => changes.push(change));

    tabs.forget("s1");

    expect(tabs.getTab("s1")).toBeUndefined();
    expect(changes).toHaveLength(0);
  });

  it("getTargetInfo returns null for unknown session", () => {
    expect(tabs.getTargetInfo("nope")).toBeNull();
  });

  it("closeAll clears all tabs", () => {
    tabs.attach("s1", "tab_1");
    tabs.attach("s2", "tab_2", { targetId: "t2", cdpSessionId: "cs2" });
    tabs.closeAll();
    expect(tabs.getSessions()).toHaveLength(0);
  });
});

// ── CDP-mode tests ────────────────────────────

function mockFetch(wsUrl: string) {
  vi.stubGlobal("fetch", async (_url: string) => {
    return {
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: wsUrl }),
    } as Response;
  });
}

describe("BrowserRuntime CDP mode", () => {
  let browserTransport: MockCdpTransport;
  let browser: BrowserRuntime;

  beforeEach(() => {
    browserTransport = new MockCdpTransport();
    mockFetch("ws://localhost:9222/devtools/browser/test");
    browser = new BrowserRuntime({
      cdpUrl: "http://localhost:9222",
      wsTransport: async () => browserTransport,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * Set up a CDP tab. Must yield between sending responses so createTab's
   * internal awaits can process and issue the next CDP command.
   */
  async function setupTab(sessionId: string): Promise<string> {
    const tabPromise = browser.createTab(sessionId);

    // Yield so createTab's first send() pushes to transport
    await tick();
    // Respond to Target.createTarget
    const createMsg = lastSent();
    browserTransport.receiveJson({
      id: createMsg.id,
      result: { targetId: "target-001" },
    });

    // Yield so createTab processes response and sends Target.attachToTarget
    await tick();
    // Respond to Target.attachToTarget
    const attachMsg = lastSent();
    browserTransport.receiveJson({
      id: attachMsg.id,
      result: { sessionId: "session-001" },
    });

    return tabPromise;
  }

  /** Get the last sent message, asserting it exists */
  function lastSent(): Record<string, unknown> {
    const all = browserTransport.allSent();
    const msg = all[all.length - 1] as Record<string, unknown> | undefined;
    if (!msg) throw new Error("No sent messages");
    return msg;
  }

  /** Process one microtask tick */
  function tick(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
  }

  it("connect fetches version info and creates CdpClient", async () => {
    await browser.connect();
    expect(browser.status).toBe("online");
    expect(browser.browserCdp).toBeInstanceOf(CdpClient);
  });

  it("connect throws if cdpUrl returns non-ok", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));
    const b = new BrowserRuntime({
      cdpUrl: "http://localhost:9222",
      wsTransport: async () => new MockCdpTransport(),
    });

    await expect(b.connect()).rejects.toThrow("Failed to fetch CDP version info");
  });

  it("connect throws if /json/version has no webSocketDebuggerUrl", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({}),
    }));
    const b = new BrowserRuntime({
      cdpUrl: "http://localhost:9222",
      wsTransport: async () => new MockCdpTransport(),
    });

    await expect(b.connect()).rejects.toThrow("No webSocketDebuggerUrl");
  });

  it("createTab calls Target.createTarget and Target.attachToTarget", async () => {
    await browser.connect();
    const tabId = await setupTab("s1");

    expect(tabId).toContain("tab_s1_");
    const createMsgs = browserTransport.allSent() as Array<Record<string, unknown>>;
    const createTarget = createMsgs.find((m) => m.method === "Target.createTarget");
    const attachTarget = createMsgs.find((m) => m.method === "Target.attachToTarget");

    expect(createTarget).toBeDefined();
    expect(createTarget!.params).toEqual({ url: "about:blank" });
    expect(attachTarget).toBeDefined();
    expect(attachTarget!.params).toEqual({ targetId: "target-001", flatten: true });

    const info = browser.tabs.getTargetInfo("s1");
    expect(info?.targetId).toBe("target-001");
    expect(info?.cdpSessionId).toBe("session-001");
  });

  it("restoreAttachment reattaches an existing CDP target", async () => {
    await browser.connect();

    const restorePromise = browser.restoreAttachment("s1", "tab-old", {
      targetId: "target-001",
      cdpSessionId: "old-session",
    });
    await tick();
    const attachMsg = lastSent();
    browserTransport.receiveJson({
      id: attachMsg.id,
      result: { sessionId: "session-new" },
    });

    await expect(restorePromise).resolves.toBe(true);
    expect(attachMsg.method).toBe("Target.attachToTarget");
    expect(attachMsg.params).toEqual({ targetId: "target-001", flatten: true });
    expect(browser.tabs.getTargetInfo("s1")).toEqual({
      targetId: "target-001",
      cdpSessionId: "session-new",
    });
  });

  it("restoreAttachment returns false and forgets the tab when the CDP target is gone", async () => {
    await browser.connect();

    const restorePromise = browser.restoreAttachment("s1", "tab-old", {
      targetId: "target-missing",
      cdpSessionId: "old-session",
    });
    await tick();
    const attachMsg = lastSent();
    browserTransport.receiveJson({
      id: attachMsg.id,
      error: { code: -32000, message: "No target with given id" },
    });

    await expect(restorePromise).resolves.toBe(false);
    expect(browser.tabs.getTab("s1")).toBeUndefined();
  });

  it("closeTab calls Target.closeTarget", async () => {
    await browser.connect();
    await setupTab("s1");

    const closePromise = browser.closeTab("s1");
    const lastMsg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({ id: lastMsg.id, result: {} });
    await closePromise;

    expect(lastMsg.method).toBe("Target.closeTarget");
  });

  it("navigate calls Page.enable and Page.navigate on tab session", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const navPromise = browser.navigate("s1", "https://example.com");

    // Page.enable (first)
    await tick();
    const enableMsg = lastSent();
    browserTransport.receiveJson({ id: enableMsg.id, result: {} });

    // Page.navigate (second)
    await tick();
    const navMsg = lastSent();
    browserTransport.receiveJson({ id: navMsg.id, result: { frameId: "f1" } });

    await navPromise;

    const allSent = browserTransport.allSent() as Array<Record<string, unknown>>;
    expect(allSent[0]!.method).toBe("Page.enable");
    expect(allSent[0]!.sessionId).toBe("session-001");
    expect(allSent[1]!.method).toBe("Page.navigate");
    expect(allSent[1]!.params).toEqual({ url: "https://example.com" });
    expect(allSent[1]!.sessionId).toBe("session-001");
  });

  it("navigate throws without a tab", async () => {
    await browser.connect();
    await expect(browser.navigate("no-tab", "https://x.com")).rejects.toThrow(
      "No CDP session for no-tab",
    );
  });

  it("click evaluates click on selector", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const clickPromise = browser.click("s1", "#btn");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({ id: msg.id, result: {} });
    await clickPromise;

    expect(msg.method).toBe("Runtime.evaluate");
    const expr = (msg.params as Record<string, string>).expression;
    expect(expr).toContain('"#btn"');
    expect(expr).toContain(".click()");
  });

  it("throws readable errors for Runtime.evaluate exceptionDetails", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const clickPromise = browser.click("s1", "#missing");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({
      id: msg.id,
      result: {
        result: { type: "object", subtype: "error" },
        exceptionDetails: {
          text: "Uncaught",
          exception: {
            description: "Error: Element not found: #missing",
          },
        },
      },
    });

    await expect(clickPromise).rejects.toThrow("Element not found: #missing");
  });

  it("typeText sets input value and dispatches events", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const typePromise = browser.typeText("s1", "#input", "hello world");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({ id: msg.id, result: {} });
    await typePromise;

    const expr = (msg.params as Record<string, string>).expression;
    expect(expr).toContain('"#input"');
    expect(expr).toContain("hello world");
    expect(expr).toContain("dispatchEvent");
  });

  it("pressKey dispatches keyDown and keyUp events", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const pressPromise = browser.pressKey("s1", "Enter");
    await tick();
    const downMsg = lastSent();
    browserTransport.receiveJson({ id: downMsg.id, result: {} });
    await tick();
    const upMsg = lastSent();
    browserTransport.receiveJson({ id: upMsg.id, result: {} });
    await pressPromise;

    expect(downMsg.method).toBe("Input.dispatchKeyEvent");
    expect(downMsg.params).toEqual({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    expect(upMsg.params).toEqual({
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  });

  it("scroll calls window.scrollBy", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const scrollPromise = browser.scroll("s1", 500);
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({ id: msg.id, result: {} });
    await scrollPromise;

    const expr = (msg.params as Record<string, string>).expression;
    expect(expr).toBe("window.scrollBy(0, 500)");
  });

  it("scrollToBottom scrolls to document.body.scrollHeight", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const scrollPromise = browser.scrollToBottom("s1");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({ id: msg.id, result: {} });
    await scrollPromise;

    const expr = (msg.params as Record<string, string>).expression;
    expect(expr).toContain("document.body.scrollHeight");
  });

  it("extract returns innerText", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const extractPromise = browser.extract("s1");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({
      id: msg.id,
      result: { result: { value: "Hello World" } },
    });
    const text = await extractPromise;

    expect(text).toBe("Hello World");
    const expr = (msg.params as Record<string, string>).expression;
    expect(expr).toContain("document.body?.innerText");
  });

  it("extract with selector returns selector text", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const extractPromise = browser.extract("s1", ".content");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({
      id: msg.id,
      result: { result: { value: "Selected text" } },
    });
    const text = await extractPromise;

    expect(text).toBe("Selected text");
    const expr = (msg.params as Record<string, string>).expression;
    expect(expr).toContain('".content"');
  });

  it("extractLinks collects href and text from anchors", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const linksPromise = browser.extractLinks("s1", "a.video");
    const msg = browserTransport.lastSent() as Record<string, unknown>;

    const expectedLinks: LinkInfo[] = [
      { href: "https://example.com/1", text: "Video 1" },
      { href: "https://example.com/2", text: "Video 2" },
    ];
    browserTransport.receiveJson({
      id: msg.id,
      result: { result: { value: expectedLinks } },
    });
    const links = await linksPromise;

    expect(links).toEqual(expectedLinks);
    const expr = (msg.params as Record<string, string>).expression;
    expect(expr).toContain('"a.video"');
    expect(expr).toContain("querySelectorAll");
  });

  it("screenshot calls Page.captureScreenshot", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const ssPromise = browser.screenshot("s1");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({ id: msg.id, result: { data: "base64png" } });
    const data = await ssPromise;

    expect(data).toBe("base64png");
    expect(msg.method).toBe("Page.captureScreenshot");
  });

  it("evaluate runs arbitrary JS and returns value", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const evalPromise = browser.evaluate("s1", "document.title");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({
      id: msg.id,
      result: { result: { value: "My Page Title" } },
    });
    const value = await evalPromise;

    expect(value).toBe("My Page Title");
    expect((msg.params as Record<string, unknown>).expression).toBe("document.title");
  });

  it("waitForSelector returns true when element found", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const waitPromise = browser.waitForSelector("s1", ".ready", 500);
    const firstMsg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({
      id: firstMsg.id,
      result: { result: { value: true } },
    });

    expect(await waitPromise).toBe(true);
  });

  it("waitForSelector returns false when element never found", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    // Use a short timeout so the test finishes quickly
    const waitPromise = browser.waitForSelector("s1", ".ghost", 100);

    // Respond to each poll with "not found"
    let pollCount = 0;
    while (pollCount < 5) {
      await tick();
      const msg = lastSent();
      if (!msg || !msg.id) break;
      browserTransport.receiveJson({
        id: msg.id,
        result: { result: { value: false } },
      });
      pollCount++;
    }

    const result = await waitPromise;
    expect(result).toBe(false);
  });

  it("getCookies calls Network.getCookies", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const cookiesPromise = browser.getCookies("s1", "https://example.com");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({
      id: msg.id,
      result: { cookies: [{ name: "session", value: "abc", domain: ".example.com" }] },
    });
    const cookies = await cookiesPromise;

    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.name).toBe("session");
    expect(msg.method).toBe("Network.getCookies");
    expect((msg.params as Record<string, unknown>).urls).toEqual(["https://example.com"]);
  });

  it("setCookies calls Network.setCookie for each cookie", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const setPromise = browser.setCookies("s1", [
      { name: "a", value: "1", domain: ".ex.com" },
      { name: "b", value: "2", domain: ".ex.com" },
    ]);

    // First cookie
    await tick();
    const msg1 = lastSent();
    browserTransport.receiveJson({ id: msg1.id, result: {} });

    // Second cookie
    await tick();
    const msg2 = lastSent();
    browserTransport.receiveJson({ id: msg2.id, result: {} });

    await setPromise;

    const allSent = browserTransport.allSent() as Array<Record<string, unknown>>;
    expect(allSent).toHaveLength(2);
    expect(allSent[0]!.method).toBe("Network.setCookie");
    expect(allSent[1]!.method).toBe("Network.setCookie");
  });

  it("disconnect closes browser CdpClient and all tabs", async () => {
    await browser.connect();
    await setupTab("s1");
    await setupTab("s2");

    await browser.disconnect();
    expect(browser.tabs.getSessions()).toHaveLength(0);
    expect(browser.status).toBe("offline");
    expect(browserTransport.closed).toBe(true);
  });

  it("healthCheck pings Browser.getVersion in CDP mode", async () => {
    await browser.connect();

    const healthPromise = browser.healthCheck();
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({ id: msg.id, result: {} });

    expect(await healthPromise).toBe(true);
    expect(msg.method).toBe("Browser.getVersion");
  });

  it("healthCheck returns false on CDP error", async () => {
    await browser.connect();

    const healthPromise = browser.healthCheck();
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({
      id: msg.id,
      error: { code: -32000, message: "Browser disconnected" },
    });

    expect(await healthPromise).toBe(false);
  });

  it("getPageHeight returns document.body.scrollHeight", async () => {
    await browser.connect();
    await setupTab("s1");
    browserTransport.sent = [];

    const heightPromise = browser.getPageHeight("s1");
    const msg = browserTransport.lastSent() as Record<string, unknown>;
    browserTransport.receiveJson({
      id: msg.id,
      result: { result: { value: 2500 } },
    });

    expect(await heightPromise).toBe(2500);
  });

  it("automatically reconnects and reattaches existing targets after unexpected close", async () => {
    const initialTransport = new MockCdpTransport();
    const reconnectTransport = new MockCdpTransport();
    const transports = [initialTransport, reconnectTransport];
    mockFetch("ws://localhost:9222/devtools/browser/test");
    browser = new BrowserRuntime({
      cdpUrl: "http://localhost:9222",
      wsTransport: async () => transports.shift()!,
      baseDelayMs: 10,
      maxDelayMs: 10,
      giveUpAfterMs: 100,
      jitterMs: 0,
    });
    browserTransport = initialTransport;

    await browser.connect();
    await setupTab("s1");
    expect(browser.status).toBe("online");

    vi.useFakeTimers();
    initialTransport.close();
    expect(browser.status).toBe("recovering");

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    const attachMsg = reconnectTransport.lastSent() as Record<string, unknown>;
    expect(attachMsg.method).toBe("Target.attachToTarget");
    expect(attachMsg.params).toEqual({ targetId: "target-001", flatten: true });
    reconnectTransport.receiveJson({
      id: attachMsg.id,
      result: { sessionId: "session-reconnected" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(browser.status).toBe("online");
    expect(browser.tabs.getTargetInfo("s1")?.cdpSessionId).toBe("session-reconnected");
  });

  it("recovers and detaches tabs whose targets disappeared after reconnect", async () => {
    const initialTransport = new MockCdpTransport();
    const reconnectTransport = new MockCdpTransport();
    const transports = [initialTransport, reconnectTransport];
    const changes: unknown[] = [];
    mockFetch("ws://localhost:9222/devtools/browser/test");
    browser = new BrowserRuntime({
      cdpUrl: "http://localhost:9222",
      wsTransport: async () => transports.shift()!,
      baseDelayMs: 10,
      maxDelayMs: 10,
      giveUpAfterMs: 100,
      jitterMs: 0,
    });
    browser.tabs.onAttachmentChange((change) => changes.push(change));
    browserTransport = initialTransport;

    await browser.connect();
    await setupTab("s1");

    vi.useFakeTimers();
    initialTransport.close();
    expect(browser.status).toBe("recovering");

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    const attachMsg = reconnectTransport.lastSent() as Record<string, unknown>;
    reconnectTransport.receiveJson({
      id: attachMsg.id,
      error: { code: -32000, message: "No target with given id" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(browser.status).toBe("online");
    expect(browser.tabs.getTab("s1")).toBeUndefined();
    expect(changes.some((change) => (change as { kind?: string }).kind === "detached")).toBe(true);
  });

  it("enters failed after reconnect give-up budget is exhausted", async () => {
    vi.useFakeTimers();
    const initialTransport = new MockCdpTransport();
    let transportCalls = 0;
    mockFetch("ws://localhost:9222/devtools/browser/test");
    browser = new BrowserRuntime({
      cdpUrl: "http://localhost:9222",
      wsTransport: async () => {
        transportCalls++;
        if (transportCalls === 1) return initialTransport;
        throw new Error("still disconnected");
      },
      baseDelayMs: 10,
      maxDelayMs: 10,
      giveUpAfterMs: 25,
      jitterMs: 0,
    });

    await browser.connect();
    initialTransport.close();
    expect(browser.status).toBe("recovering");

    await vi.advanceTimersByTimeAsync(40);
    await Promise.resolve();

    expect(browser.status).toBe("failed");
  });

  it("does not reconnect after explicit disconnect", async () => {
    vi.useFakeTimers();
    const initialTransport = new MockCdpTransport();
    let transportCalls = 0;
    mockFetch("ws://localhost:9222/devtools/browser/test");
    browser = new BrowserRuntime({
      cdpUrl: "http://localhost:9222",
      wsTransport: async () => {
        transportCalls++;
        return initialTransport;
      },
      baseDelayMs: 10,
      maxDelayMs: 10,
      giveUpAfterMs: 100,
      jitterMs: 0,
    });

    await browser.connect();
    await browser.disconnect();
    await vi.advanceTimersByTimeAsync(100);

    expect(browser.status).toBe("offline");
    expect(transportCalls).toBe(1);
  });
});

// ── Simulation mode tests ─────────────────────

describe("BrowserRuntime simulation mode", () => {
  let browser: BrowserRuntime;

  beforeEach(() => {
    browser = new BrowserRuntime();
  });

  it("connect transitions offline → starting → online", async () => {
    await browser.connect();
    expect(browser.status).toBe("online");
  });

  it("disconnect transitions online → offline", async () => {
    await browser.connect();
    await browser.disconnect();
    expect(browser.status).toBe("offline");
  });

  it("healthCheck returns true when online", async () => {
    await browser.connect();
    expect(await browser.healthCheck()).toBe(true);
  });

  it("healthCheck returns true when degraded", async () => {
    await browser.connect();
    await browser.simulateFailure();
    expect(browser.status).toBe("degraded");
    expect(await browser.healthCheck()).toBe(true);
  });

  it("simulateFailure transitions online → degraded", async () => {
    await browser.connect();
    await browser.simulateFailure();
    expect(browser.status).toBe("degraded");
  });

  it("simulateFailure from degraded → recovering", async () => {
    await browser.connect();
    await browser.simulateFailure(); // online → degraded
    await browser.simulateFailure(); // degraded → recovering
    expect(browser.status).toBe("recovering");
  });

  it("recover restores online from recovering", async () => {
    await browser.connect();
    await browser.simulateFailure();
    await browser.simulateFailure();
    expect(browser.status).toBe("recovering");

    const result = await browser.recover();
    expect(result).toBe(true);
    expect(browser.status).toBe("online");
  });

  it("recover returns false when not recovering", async () => {
    await browser.connect();
    expect(await browser.recover()).toBe(false);
  });

  it("createTab returns a tab id", async () => {
    const tabId = await browser.createTab("s1");
    expect(tabId).toContain("tab_s1_");
    expect(browser.tabs.getTab("s1")).toBe(tabId);
  });

  it("closeTab removes session from tabs", async () => {
    await browser.createTab("s1");
    await browser.closeTab("s1");
    expect(browser.tabs.getTab("s1")).toBeUndefined();
  });

  it("onStatusChange notifies listeners", async () => {
    const statuses: string[] = [];
    browser.onStatusChange((s) => statuses.push(s));
    await browser.connect();
    expect(statuses).toEqual(["starting", "online"]);
  });

  it("getPageHeight throws without CDP", async () => {
    await expect(browser.getPageHeight("s1")).rejects.toThrow("CDP not connected");
  });

  it("extract throws without CDP", async () => {
    await expect(browser.extract("s1")).rejects.toThrow("CDP not connected");
  });

  it("navigate throws without CDP", async () => {
    await expect(browser.navigate("s1", "https://x.com")).rejects.toThrow("CDP not connected");
  });

  it("interface methods throw without CDP", async () => {
    await expect(browser.click("s1", "#btn")).rejects.toThrow("CDP not connected");
    await expect(browser.typeText("s1", "#in", "x")).rejects.toThrow("CDP not connected");
    await expect(browser.scroll("s1", 100)).rejects.toThrow("CDP not connected");
    await expect(browser.scrollToBottom("s1")).rejects.toThrow("CDP not connected");
    await expect(browser.screenshot("s1")).rejects.toThrow("CDP not connected");
    await expect(browser.evaluate("s1", "1+1")).rejects.toThrow("CDP not connected");
    await expect(browser.waitForSelector("s1", ".x")).rejects.toThrow("CDP not connected");
    await expect(browser.getCookies("s1")).rejects.toThrow("CDP not connected");
    await expect(browser.setCookies("s1", [])).rejects.toThrow("CDP not connected");
    await expect(browser.extractLinks("s1")).rejects.toThrow("CDP not connected");
  });
});
