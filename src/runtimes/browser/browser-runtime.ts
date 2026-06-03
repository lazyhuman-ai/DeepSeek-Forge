import { TabManager } from "./tab-manager.js";
import { CdpClient, type CdpTransport } from "./cdp-client.js";
import {
  transitionRuntime,
  type RuntimeStatus,
  type RuntimeStateEvent,
} from "../runtime-status.js";

type StatusListener = (status: RuntimeStatus) => void;

export type BrowserOptions = {
  cdpUrl?: string;
  wsTransport?: (url: string) => Promise<CdpTransport>;
  autoReconnect?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  giveUpAfterMs?: number;
  jitterMs?: number;
};

export type LinkInfo = {
  href: string;
  text: string;
};

type RuntimeEvaluateResponse = {
  result?: {
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      value?: unknown;
      description?: string;
    };
  };
};

export class BrowserRuntime {
  #status: RuntimeStatus = "offline";
  #tabs = new TabManager();
  #listeners = new Set<StatusListener>();
  #options: BrowserOptions;
  #browserCdp: CdpClient | null = null;
  #wsTransport: (url: string) => Promise<CdpTransport>;
  #autoReconnect: boolean;
  #baseDelayMs: number;
  #maxDelayMs: number;
  #giveUpAfterMs: number;
  #jitterMs: number;
  #reconnectStopped = false;
  #reconnectActive = false;
  #explicitDisconnect = false;

  constructor(options?: BrowserOptions) {
    this.#options = options ?? {};
    this.#wsTransport = options?.wsTransport ?? defaultWsTransport;
    this.#autoReconnect = options?.autoReconnect ?? true;
    this.#baseDelayMs = options?.baseDelayMs ?? 1_000;
    this.#maxDelayMs = options?.maxDelayMs ?? 30_000;
    this.#giveUpAfterMs = options?.giveUpAfterMs ?? 600_000;
    this.#jitterMs = options?.jitterMs ?? 500;
  }

  get status(): RuntimeStatus {
    return this.#status;
  }

  get tabs(): TabManager {
    return this.#tabs;
  }

  // ── Connection ──────────────────────────────

  async connect(): Promise<void> {
    this.#reconnectStopped = false;
    this.#apply("start");

    if (!this.#options.cdpUrl) {
      await delay(1);
      this.#apply("connected");
      return;
    }

    try {
      await this.#connectCdp();
      this.#apply("connected");
    } catch (err) {
      this.#apply("recover_failed");
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.stopReconnect();
    this.#explicitDisconnect = true;
    this.#tabs.closeAll();
    this.#browserCdp?.close();
    this.#browserCdp = null;
    this.#explicitDisconnect = false;
    this.#apply("disconnect");
  }

  async healthCheck(): Promise<boolean> {
    if (!this.#browserCdp) {
      await delay(0);
      return this.#status === "online" || this.#status === "degraded";
    }

    try {
      await this.#browserCdp.send("Browser.getVersion");
      return true;
    } catch {
      return false;
    }
  }

  async simulateFailure(): Promise<void> {
    if (this.#status === "online" || this.#status === "degraded") {
      this.#apply("healthcheck_failed");
      this.#startReconnectLoop();
    }
  }

  async recover(): Promise<boolean> {
    if (this.#status === "failed") {
      this.#apply("start");
    }
    if (this.#status !== "recovering") return false;

    try {
      if (this.#options.cdpUrl) {
        await this.#connectCdp();
        await this.#reattachExistingTargets();
      } else if (this.#browserCdp) {
        await this.#browserCdp.send("Browser.getVersion");
      } else {
        await delay(1);
      }
    } catch {
      this.#apply("recover_failed");
      return false;
    }
    if (!this.#options.cdpUrl && !this.#browserCdp) {
      await delay(1);
    }
    this.#apply("recover_success");
    return true;
  }

  // ── Tab management ──────────────────────────

  async createTab(sessionId: string): Promise<string> {
    const tabId = `tab_${sessionId}_${Date.now()}`;

    if (this.#browserCdp) {
      const result = (await this.#browserCdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };
      const targetId = result.targetId;

      const attachResult = (await this.#browserCdp.send(
        "Target.attachToTarget",
        { targetId, flatten: true },
      )) as { sessionId: string };
      const sessionId2 = attachResult.sessionId;

      this.#tabs.attach(sessionId, tabId, {
        targetId,
        cdpSessionId: sessionId2,
      });
    } else {
      this.#tabs.attach(sessionId, tabId);
    }

    return tabId;
  }

  async closeTab(sessionId: string): Promise<void> {
    const info = this.#tabs.getTargetInfo(sessionId);
    if (info?.targetId && this.#browserCdp) {
      try {
        await this.#browserCdp.send("Target.closeTarget", {
          targetId: info.targetId,
        });
      } catch {
        // Tab may already be closed
      }
    }
    this.#tabs.detach(sessionId);
  }

  async restoreAttachment(
    sessionId: string,
    tabId: string,
    targetInfo: { targetId: string; cdpSessionId: string } | null,
  ): Promise<boolean> {
    if (!this.#options.cdpUrl) {
      this.#tabs.restore(sessionId, { tabId, targetInfo });
      return true;
    }

    if (!this.#browserCdp || !targetInfo?.targetId) {
      return false;
    }

    this.#tabs.restore(sessionId, { tabId, targetInfo });
    try {
      const attachResult = (await this.#browserCdp.send(
        "Target.attachToTarget",
        { targetId: targetInfo.targetId, flatten: true },
      )) as { sessionId: string };
      this.#tabs.attach(sessionId, tabId, {
        targetId: targetInfo.targetId,
        cdpSessionId: attachResult.sessionId,
      });
      return true;
    } catch {
      this.#tabs.forget(sessionId);
      return false;
    }
  }

  // ── Page interaction (real mode only) ────────

  async navigate(sessionId: string, url: string): Promise<void> {
    const cdpSessionId = this.#getCdpSessionId(sessionId);
    await this.#browserCdp!.send("Page.enable", {}, cdpSessionId);
    await this.#browserCdp!.send("Page.navigate", { url }, cdpSessionId);
  }

  async click(sessionId: string, selector: string): Promise<void> {
    const js = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Element not found: ${selector}");
        el.click();
      })()
    `;
    await this.#evaluate(sessionId, js);
  }

  async typeText(
    sessionId: string,
    selector: string,
    text: string,
  ): Promise<void> {
    const js = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Element not found: ${selector}");
        el.focus();
        const text = ${JSON.stringify(text)};
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
        } else if (el.isContentEditable) {
          el.textContent = text;
        } else {
          throw new Error("Element is not a text input, textarea, or contenteditable: ${selector}");
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `;
    await this.#evaluate(sessionId, js);
  }

  async pressKey(
    sessionId: string,
    key: string,
  ): Promise<void> {
    const cdpSessionId = this.#getCdpSessionId(sessionId);
    const descriptor = keyDescriptor(key);
    await this.#browserCdp!.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown", ...descriptor },
      cdpSessionId,
    );
    await this.#browserCdp!.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...descriptor },
      cdpSessionId,
    );
  }

  async scroll(
    sessionId: string,
    deltaY: number,
  ): Promise<void> {
    const js = `window.scrollBy(0, ${deltaY})`;
    await this.#evaluate(sessionId, js);
  }

  async scrollToBottom(sessionId: string): Promise<void> {
    const js = "window.scrollTo(0, document.body.scrollHeight)";
    await this.#evaluate(sessionId, js);
  }

  async getPageHeight(sessionId: string): Promise<number> {
    return await this.#evaluate(sessionId, "document.body.scrollHeight") as number;
  }

  async extract(
    sessionId: string,
    selector?: string,
  ): Promise<string> {
    const target = selector
      ? `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`
      : "document.body?.innerText ?? ''";
    const js = `(() => ${target})()`;
    return await this.#evaluate(sessionId, js) as string;
  }

  async extractLinks(
    sessionId: string,
    selector = "a[href]",
  ): Promise<LinkInfo[]> {
    const js = `
      (() => {
        const links = document.querySelectorAll(${JSON.stringify(selector)});
        return Array.from(links).map(a => ({
          href: a.href,
          text: a.textContent?.trim() ?? '',
        }));
      })()
    `;
    return await this.#evaluate(sessionId, js) as LinkInfo[];
  }

  async screenshot(
    sessionId: string,
  ): Promise<string> {
    const cdpSessionId = this.#getCdpSessionId(sessionId);
    const result = (await this.#browserCdp!.send(
      "Page.captureScreenshot",
      { format: "png" },
      cdpSessionId,
    )) as { data: string };
    return result.data;
  }

  async currentPage(sessionId: string): Promise<{
    title: string;
    url: string;
    textPreview: string;
  }> {
    const js = `
      (() => ({
        title: document.title ?? '',
        url: location.href,
        textPreview: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 2000),
      }))()
    `;
    return await this.#evaluate(sessionId, js) as {
      title: string;
      url: string;
      textPreview: string;
    };
  }

  async evaluate(
    sessionId: string,
    expression: string,
  ): Promise<unknown> {
    return await this.#evaluate(sessionId, expression, { awaitPromise: true });
  }

  async waitForSelector(
    sessionId: string,
    selector: string,
    timeoutMs = 10_000,
  ): Promise<boolean> {
    const js = `document.querySelector(${JSON.stringify(selector)}) !== null`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const found = await this.#evaluate(sessionId, js) as boolean;
      if (found) return true;
      await delay(200);
    }
    return false;
  }

  // ── Cookie management ────────────────────────

  async getCookies(
    sessionId: string,
    url?: string,
  ): Promise<Array<{ name: string; value: string; domain: string }>> {
    const cdpSessionId = this.#getCdpSessionId(sessionId);
    const result = (await this.#browserCdp!.send(
      "Network.getCookies",
      url ? { urls: [url] } : {},
      cdpSessionId,
    )) as { cookies: Array<{ name: string; value: string; domain: string }> };
    return result.cookies;
  }

  async setCookies(
    sessionId: string,
    cookies: Array<{ name: string; value: string; domain?: string; url?: string }>,
  ): Promise<void> {
    const cdpSessionId = this.#getCdpSessionId(sessionId);
    for (const cookie of cookies) {
      await this.#browserCdp!.send("Network.setCookie", cookie, cdpSessionId);
    }
  }

  // ── Status listeners ─────────────────────────

  onStatusChange(cb: StatusListener): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  stopReconnect(): void {
    this.#reconnectStopped = true;
    this.#reconnectActive = false;
  }

  // ── Private helpers ──────────────────────────

  async #connectCdp(): Promise<void> {
    if (!this.#options.cdpUrl) {
      throw new Error("CDP URL is not configured.");
    }

    this.#closeCdpClient();
    const wsUrl = await resolveCdpWsUrl(this.#options.cdpUrl);
    const transport = await this.#wsTransport(wsUrl);
    this.#browserCdp = new CdpClient(transport, {
      onClose: () => this.#handleUnexpectedCdpDisconnect(),
      onError: () => this.#handleUnexpectedCdpDisconnect(),
    });
  }

  #closeCdpClient(): void {
    if (!this.#browserCdp) return;
    this.#explicitDisconnect = true;
    try {
      this.#browserCdp.close();
    } finally {
      this.#browserCdp = null;
      this.#explicitDisconnect = false;
    }
  }

  #handleUnexpectedCdpDisconnect(): void {
    if (this.#explicitDisconnect || this.#reconnectStopped) return;
    this.#browserCdp = null;

    if (this.#status === "online") {
      this.#apply("healthcheck_failed");
    }
    this.#startReconnectLoop();
  }

  #startReconnectLoop(): void {
    if (
      !this.#autoReconnect ||
      !this.#options.cdpUrl ||
      this.#reconnectStopped ||
      this.#reconnectActive
    ) {
      return;
    }

    if (this.#status === "degraded") {
      this.#apply("healthcheck_failed");
    }
    if (this.#status !== "recovering") return;

    this.#reconnectActive = true;
    void this.#runReconnectLoop().catch(() => {
      // Status transitions inside the loop communicate recovery failure.
    });
  }

  async #runReconnectLoop(): Promise<void> {
    const startedAt = Date.now();
    let attempt = 0;

    try {
      while (!this.#reconnectStopped && this.#status === "recovering") {
        if (Date.now() - startedAt >= this.#giveUpAfterMs) {
          this.#apply("recover_failed");
          return;
        }

        const delayMs = Math.min(
          this.#baseDelayMs * 2 ** attempt,
          this.#maxDelayMs,
        ) + (this.#jitterMs > 0 ? Math.floor(Math.random() * this.#jitterMs) : 0);
        await delay(delayMs);
        if (this.#reconnectStopped || this.#status !== "recovering") return;

        try {
          await this.#connectCdp();
          await this.#reattachExistingTargets();
          if (this.#status === "recovering") {
            this.#apply("recover_success");
          }
          return;
        } catch {
          attempt++;
        }
      }
    } finally {
      this.#reconnectActive = false;
    }
  }

  async #reattachExistingTargets(): Promise<void> {
    if (!this.#browserCdp) return;
    for (const [sessionId, entry] of this.#tabs.listEntries()) {
      const targetId = entry.targetInfo?.targetId;
      if (!targetId) continue;
      try {
        const attachResult = (await this.#browserCdp.send(
          "Target.attachToTarget",
          { targetId, flatten: true },
        )) as { sessionId: string };
        this.#tabs.attach(sessionId, entry.tabId, {
          targetId,
          cdpSessionId: attachResult.sessionId,
        });
      } catch {
        this.#tabs.detach(sessionId);
      }
    }
  }

  #getCdpSessionId(sessionId: string): string {
    if (!this.#browserCdp) {
      throw new Error("CDP not connected. Provide cdpUrl in constructor and call connect().");
    }
    const info = this.#tabs.getTargetInfo(sessionId);
    if (!info?.cdpSessionId) {
      throw new Error(`No CDP session for ${sessionId}. Call createTab() first.`);
    }
    return info.cdpSessionId;
  }

  get browserCdp(): CdpClient | null {
    return this.#browserCdp;
  }

  async #evaluate(
    sessionId: string,
    expression: string,
    options?: { awaitPromise?: boolean },
  ): Promise<unknown> {
    const cdpSessionId = this.#getCdpSessionId(sessionId);
    const response = (await this.#browserCdp!.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: options?.awaitPromise ?? false,
      },
      cdpSessionId,
    )) as RuntimeEvaluateResponse;

    if (response.exceptionDetails) {
      throw new Error(
        `CDP Runtime.evaluate failed: ${formatRuntimeException(response.exceptionDetails)}`,
      );
    }
    return response.result?.value;
  }

  #apply(event: RuntimeStateEvent): void {
    this.#status = transitionRuntime(this.#status, event);
    for (const listener of this.#listeners) {
      listener(this.#status);
    }
  }
}

// ── Utilities ──────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRuntimeException(
  details: NonNullable<RuntimeEvaluateResponse["exceptionDetails"]>,
): string {
  const description = details.exception?.description;
  const value = details.exception?.value;
  const parts = [
    details.text,
    typeof description === "string" ? description : undefined,
    description === undefined && value !== undefined ? String(value) : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(": ") : "JavaScript exception";
}

function keyDescriptor(key: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
} {
  const normalized = key.length === 1 ? key : key.trim();
  const table: Record<string, { code: string; keyCode: number }> = {
    Enter: { code: "Enter", keyCode: 13 },
    Escape: { code: "Escape", keyCode: 27 },
    Tab: { code: "Tab", keyCode: 9 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
  };
  const known = table[normalized];
  if (known) {
    return {
      key: normalized,
      code: known.code,
      windowsVirtualKeyCode: known.keyCode,
      nativeVirtualKeyCode: known.keyCode,
    };
  }
  if (normalized.length !== 1) {
    throw new Error(`Unsupported key: ${key}. Supported named keys include Enter, Escape, Tab, Backspace, Delete, and Arrow keys.`);
  }
  const upper = normalized.toUpperCase();
  const keyCode = upper.charCodeAt(0);
  return {
    key: normalized,
    code: `Key${upper}`,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };
}

async function resolveCdpWsUrl(baseUrl: string): Promise<string> {
  const versionUrl = baseUrl.replace(/\/$/, "") + "/json/version";
  const resp = await fetch(versionUrl);
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch CDP version info: ${resp.status} ${resp.statusText}`,
    );
  }
  const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
  if (!data.webSocketDebuggerUrl) {
    throw new Error("No webSocketDebuggerUrl in /json/version response");
  }
  return data.webSocketDebuggerUrl;
}

async function defaultWsTransport(
  url: string,
): Promise<CdpTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connection timed out`));
    }, 10_000);

    const transport: CdpTransport = {
      send(data: string): void {
        ws.send(data);
      },
      close(): void {
        ws.close();
      },
      onMessage: null,
      onClose: null,
      onError: null,
    };

    ws.onopen = () => {
      clearTimeout(timer);
      // After open, delegate events to transport instead of rejecting
      ws.onerror = () => {
        transport.onError?.(new Error("WebSocket error"));
      };
      resolve(transport);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      transport.onMessage?.(event.data);
    };
    ws.onclose = () => {
      transport.onClose?.();
    };
  });
}
