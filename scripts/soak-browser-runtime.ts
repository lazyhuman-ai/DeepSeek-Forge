import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { BrowserRuntime } from "../src/runtimes/browser/browser-runtime.js";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { AnthropicProvider } from "../src/agent/anthropic-provider.js";
import { OpenAIProvider } from "../src/agent/openai-provider.js";
import { DeepSeekProvider } from "../src/agent/deepseek-provider.js";
import type { ModelMessage, ModelProvider, ModelResponse } from "../src/agent/model-provider.js";
import type { RuntimeEvent, SessionEvent } from "../src/streams/event-types.js";

type ScenarioResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string;
};

type ChromeHandle = {
  process: ChildProcessWithoutNullStreams;
  cdpUrl: string;
  port: number;
  profileDir: string;
  stderr: string[];
  exited: boolean;
};

const DATA_DIR = resolve(process.env.SOAK_BROWSER_DATA_DIR ?? ".forge-soak-browser");
const RUN_ID = `browser_${new Date().toISOString().replace(/[:.]/g, "-")}`;
const DEFAULT_WAIT_MS = Number(process.env.SOAK_BROWSER_WAIT_MS ?? "30000");
const AGENT_WAIT_MS = Number(process.env.SOAK_BROWSER_AGENT_WAIT_MS ?? "180000");
const PROVIDER_KIND = (process.env.SOAK_PROVIDER ?? "deepseek").toLowerCase();
const CHROME_PATH = resolveChromePath();

function now(): number {
  return Date.now();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function runScenario(name: string, fn: () => Promise<string>): Promise<ScenarioResult> {
  const started = now();
  try {
    const detail = await fn();
    return { name, ok: true, durationMs: now() - started, detail };
  } catch (err) {
    return {
      name,
      ok: false,
      durationMs: now() - started,
      detail: err instanceof Error ? err.stack ?? err.message : String(err),
    };
  }
}

async function scenarioRealPageOps(): Promise<string> {
  const chrome = await startChrome("page-ops");
  const browser = new BrowserRuntime({
    cdpUrl: chrome.cdpUrl,
    baseDelayMs: 250,
    maxDelayMs: 500,
    giveUpAfterMs: 10_000,
    jitterMs: 0,
  });

  try {
    await browser.connect();
    const sessionId = `${RUN_ID}_page_ops`;
    await browser.createTab(sessionId);
    await browser.navigate(sessionId, dataUrl([
      "<!doctype html>",
      "<html>",
      "<head><title>Forge Browser Soak</title></head>",
      "<body style='height:1800px'>",
      "<main id='ready'>ForgeAgent Browser Runtime Ready</main>",
      "<input id='name' />",
      "<button id='go' onclick=\"document.querySelector('#result').innerText = 'Hello ' + document.querySelector('#name').value\">Go</button>",
      "<div id='result'></div>",
      "<a class='nav' href='https://example.com/a'>Alpha Link</a>",
      "<a class='nav' href='https://example.com/b'>Beta Link</a>",
      "</body>",
      "</html>",
    ].join("")));

    assert(await browser.waitForSelector(sessionId, "#ready", 5_000), "Page did not expose #ready");
    assert((await browser.extract(sessionId, "#ready")).includes("Browser Runtime Ready"), "extract() missed page text");
    await browser.typeText(sessionId, "#name", "Forge");
    await browser.click(sessionId, "#go");
    assert((await browser.extract(sessionId, "#result")).includes("Hello Forge"), "click/typeText did not update #result");

    const links = await browser.extractLinks(sessionId, "a.nav");
    assert(links.length === 2, `Expected two links, got ${links.length}`);
    assert(links[0]?.href === "https://example.com/a", `Unexpected first href: ${links[0]?.href}`);

    await browser.scroll(sessionId, 300);
    await browser.scrollToBottom(sessionId);
    assert(await browser.getPageHeight(sessionId) >= 1000, "getPageHeight() returned an implausible value");
    assert(await browser.evaluate(sessionId, "document.title") === "Forge Browser Soak", "evaluate() returned wrong title");

    await browser.setCookies(sessionId, [{
      name: "forge_soak_cookie",
      value: "cookie-ok",
      url: "https://example.com/",
    }]);
    const cookies = await browser.getCookies(sessionId, "https://example.com/");
    assert(cookies.some((cookie) => cookie.name === "forge_soak_cookie" && cookie.value === "cookie-ok"), "Cookie roundtrip failed");

    const screenshot = await browser.screenshot(sessionId);
    assert(screenshot.length > 100, "Screenshot payload was too small");

    let missingSelectorError = "";
    try {
      await browser.click(sessionId, "#missing");
    } catch (err) {
      missingSelectorError = err instanceof Error ? err.message : String(err);
    }
    assert(missingSelectorError.includes("Element not found: #missing"), `Missing selector did not produce readable error: ${missingSelectorError}`);

    await browser.closeTab(sessionId);
    return `links=${links.length}; screenshotBytes=${Buffer.byteLength(screenshot, "base64")}; missingSelectorError=ok`;
  } finally {
    await browser.disconnect().catch(() => undefined);
    await stopChrome(chrome);
  }
}

async function scenarioRuntimeManagerAttachmentEvents(): Promise<string> {
  const chrome = await startChrome("attachment-events");
  const browser = new BrowserRuntime({
    cdpUrl: chrome.cdpUrl,
    baseDelayMs: 250,
    maxDelayMs: 500,
    giveUpAfterMs: 10_000,
    jitterMs: 0,
  });
  const api = makeRuntimeCore("attachment-events");

  try {
    api.initRuntimeManager();
    api.registerBrowserRuntime("chrome", browser);
    await api.startRuntimes();

    const session = api.createSession(`${RUN_ID} attachment events`);
    await browser.createTab(session.id);
    const attached = await waitForThreadEvent(api, session.id, (event) =>
      event.type === "runtime_event" && event.detail === "attached");
    assertRuntimePayload(attached, "attached");
    await browser.closeTab(session.id);
    const detached = await waitForThreadEvent(api, session.id, (event) =>
      event.type === "runtime_event" && event.detail === "detached");
    assertRuntimePayload(detached, "detached");
    api.flush();
    return threadTypes(api.getThread(session.id));
  } finally {
    await api.shutdown({ waitMs: 500 }).catch(() => undefined);
    await browser.disconnect().catch(() => undefined);
    await stopChrome(chrome);
  }
}

async function scenarioWebSocketReconnectReattach(): Promise<string> {
  const chrome = await startChrome("websocket-reconnect");
  const browser = new BrowserRuntime({
    cdpUrl: chrome.cdpUrl,
    baseDelayMs: 250,
    maxDelayMs: 500,
    giveUpAfterMs: 15_000,
    jitterMs: 0,
  });
  const api = makeRuntimeCore("websocket-reconnect");

  try {
    api.initRuntimeManager();
    api.registerBrowserRuntime("chrome", browser);
    await api.startRuntimes();
    const session = api.createSession(`${RUN_ID} websocket reconnect`);
    await browser.createTab(session.id);
    await browser.navigate(session.id, dataUrl("<main id='ready'>Reconnect target survived</main>"));
    assert(await browser.waitForSelector(session.id, "#ready", 5_000), "Initial page did not load");

    browser.browserCdp?.close();
    await waitForRuntimeStatus(browser, "online", 15_000);
    await waitForThreadEvent(api, session.id, (event) =>
      event.type === "runtime_event" && event.detail === "degraded");
    await waitForThreadEvent(api, session.id, (event) =>
      event.type === "runtime_event" && event.detail === "reattached");
    await waitForThreadEvent(api, session.id, (event) =>
      event.type === "runtime_event" && event.detail === "recovered");

    assert((await browser.extract(session.id, "#ready")).includes("Reconnect target survived"), "Reattached target was not usable");
    api.flush();
    return threadTypes(api.getThread(session.id));
  } finally {
    await api.shutdown({ waitMs: 500 }).catch(() => undefined);
    await browser.disconnect().catch(() => undefined);
    await stopChrome(chrome);
  }
}

async function scenarioChromeProcessRestartTargetLost(): Promise<string> {
  let chrome = await startChrome("process-restart");
  const browser = new BrowserRuntime({
    cdpUrl: chrome.cdpUrl,
    baseDelayMs: 250,
    maxDelayMs: 500,
    giveUpAfterMs: 20_000,
    jitterMs: 0,
  });
  const provider = new RuntimeRecoveryProvider();
  const api = makeRuntimeCore("process-restart", provider);

  try {
    api.initRuntimeManager();
    api.registerBrowserRuntime("chrome", browser);
    api.setModelProvider(provider);
    await api.startRuntimes();

    const session = api.createSession(`${RUN_ID} process restart target lost`);
    await browser.createTab(session.id);
    await browser.navigate(session.id, dataUrl("<main id='ready'>This target will disappear</main>"));
    assert(await browser.waitForSelector(session.id, "#ready", 5_000), "Initial restart page did not load");

    api.appendUserMessage(session.id, "After runtime recovery, reply with exactly SOAK_REAL_BROWSER_RECOVER_OK.");
    await provider.firstStarted;

    await stopChrome(chrome);
    chrome = await startChrome("process-restart", chrome.port, chrome.profileDir, { cleanProfile: false });

    await waitForThreadEvent(api, session.id, (event) =>
      event.type === "runtime_event" && event.detail === "degraded");
    await waitForThreadEvent(api, session.id, (event) =>
      event.type === "runtime_event" && event.detail === "detached");
    await waitForThreadEvent(api, session.id, (event) =>
      event.type === "runtime_event" && event.detail === "recovered");
    await waitForSessionStatus(api, session.id, "idle", 30_000);

    const events = api.getThread(session.id);
    assert(provider.aborted, "Runtime failure did not abort the active provider call");
    assert(lastAssistantText(events).includes("SOAK_REAL_BROWSER_RECOVER_OK"), `Unexpected recovery answer: ${lastAssistantText(events)}`);
    assert(!events.some((event) => event.type === "runtime_event" && event.detail === "failed"), "Runtime produced failed event during process restart recovery");
    assert(browser.tabs.getTab(session.id) === undefined, "Lost target remained attached after Chrome process restart");
    api.flush();
    return threadTypes(events);
  } finally {
    await api.shutdown({ waitMs: 500 }).catch(() => undefined);
    await browser.disconnect().catch(() => undefined);
    await stopChrome(chrome);
  }
}

async function scenarioForgeAgentBrowserTools(): Promise<string> {
  assertProviderConfigured();
  const pageServer = await startTestPageServer();
  const chrome = await startChrome("forge-agent-browser-tools");
  const browser = new BrowserRuntime({
    cdpUrl: chrome.cdpUrl,
    baseDelayMs: 250,
    maxDelayMs: 500,
    giveUpAfterMs: 20_000,
    jitterMs: 0,
  });
  const provider = makeProvider();
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir: join(DATA_DIR, "core", "forge-agent-browser-tools"),
    memoryDir: join(DATA_DIR, "core", "forge-agent-browser-tools", "memory"),
    artifactDir: join(DATA_DIR, "core", "forge-agent-browser-tools", "artifacts"),
  });

  try {
    api.registerBuiltInTools();
    api.initSupervisor(1);
    api.initRuntimeManager();
    api.registerBrowserRuntime("chrome", browser);
    api.initMemoryManager({ autoRun: false });
    api.initToolPolicy({
      projectRoot: process.cwd(),
      rules: [{
        id: "browser-soak-allow-runtime-tools",
        decision: "allow",
        capability: "runtime.browser",
        reason: "Browser soak explicitly allows runtime browser tools.",
      }],
    });
    api.setModelProvider(provider);
    await api.startRuntimes();

    const session = api.createSession(`${RUN_ID} forge agent browser tools`);
    api.appendUserMessage(session.id, [
      "This is an end-to-end browser tool test. You must operate the browser with tools, not by describing steps.",
      "Use these exact steps:",
      "1. Call browser_create_tab.",
      `2. Call browser_navigate with url="${pageServer.url}".`,
      "3. Call browser_wait_for_selector with selector=\"#ready\".",
      "4. Call browser_type_text with selector=\"#name\" and text=\"ForgeAgent\".",
      "5. Call browser_click with selector=\"#go\".",
      "6. Call browser_extract with selector=\"#result\".",
      "7. Call browser_extract_links with selector=\"a.nav\".",
      "8. Call browser_screenshot.",
      "Then answer with exact prefix SOAK_AGENT_BROWSER_OK and include the result text and the number of links.",
      "Do not ask the user for clarification.",
    ].join("\n"), {
      source: {
        kind: "cli",
        interactive: true,
        deviceId: "browser-soak-cli",
        deviceName: "Browser Soak Harness",
      },
    });

    await waitForSessionStatus(api, session.id, "idle", AGENT_WAIT_MS);
    const events = api.getThread(session.id);
    const toolNames = events
      .filter((event) => event.type === "tool_call")
      .map((event) => event.toolName);
    for (const expected of [
      "browser_create_tab",
      "browser_navigate",
      "browser_wait_for_selector",
      "browser_type_text",
      "browser_click",
      "browser_extract",
      "browser_extract_links",
      "browser_screenshot",
    ]) {
      assert(toolNames.includes(expected), `Agent did not call required browser tool: ${expected}. Called: ${toolNames.join(", ")}`);
    }

    assertToolResult(events, "browser_extract", "Hello ForgeAgent");
    assertToolResult(events, "browser_extract_links", "Alpha Link");
    assertToolResult(events, "browser_screenshot", "Screenshot captured");
    assert(lastAssistantText(events).includes("SOAK_AGENT_BROWSER_OK"), `Unexpected final assistant text: ${lastAssistantText(events)}`);
    assert(lastAssistantText(events).includes("Hello ForgeAgent"), "Final assistant text missed extracted page result");
    assert(events.some((event) => event.type === "runtime_event" && event.detail === "attached"), "Thread missing browser attached runtime_event");
    assert(events.some((event) => event.type === "usage_event"), "Thread missing provider usage_event");
    api.flush();
    return `${threadTypes(events)}; tools=${toolNames.join(",")}`;
  } finally {
    await api.shutdown({ waitMs: 1_000 }).catch(() => undefined);
    await browser.disconnect().catch(() => undefined);
    await stopChrome(chrome);
    await pageServer.close();
  }
}

class RuntimeRecoveryProvider implements ModelProvider {
  calls = 0;
  aborted = false;
  #resolveFirstStarted!: () => void;
  firstStarted = new Promise<void>((resolvePromise) => {
    this.#resolveFirstStarted = resolvePromise;
  });

  async generate(
    _messages: ModelMessage[],
    _tools?: unknown,
    callbacks?: { signal?: AbortSignal },
  ): Promise<ModelResponse> {
    this.calls++;
    if (this.calls === 1) {
      callbacks?.signal?.addEventListener("abort", () => {
        this.aborted = true;
      }, { once: true });
      this.#resolveFirstStarted();
      await new Promise(() => undefined);
    }
    return {
      text: "SOAK_REAL_BROWSER_RECOVER_OK",
      finishReason: "stop",
      rawUsage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    };
  }
}

function makeProvider(): ModelProvider {
  if (PROVIDER_KIND === "openai") {
    return new OpenAIProvider({
      requestTimeoutMs: Number(process.env.SOAK_PROVIDER_TIMEOUT_MS ?? "120000"),
      maxRetries: Number(process.env.SOAK_PROVIDER_RETRIES ?? "1"),
    });
  }
  if (PROVIDER_KIND === "anthropic") {
    return new AnthropicProvider({
      requestTimeoutMs: Number(process.env.SOAK_PROVIDER_TIMEOUT_MS ?? "120000"),
      maxRetries: Number(process.env.SOAK_PROVIDER_RETRIES ?? "1"),
    });
  }
  return new DeepSeekProvider({
    requestTimeoutMs: Number(process.env.SOAK_PROVIDER_TIMEOUT_MS ?? "120000"),
    maxRetries: Number(process.env.SOAK_PROVIDER_RETRIES ?? "1"),
  });
}

function makeRuntimeCore(name: string, provider?: ModelProvider): CoreAPI {
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir: join(DATA_DIR, "core", name),
    memoryDir: join(DATA_DIR, "core", name, "memory"),
    artifactDir: join(DATA_DIR, "core", name, "artifacts"),
  });
  api.registerBuiltInTools();
  api.initSupervisor(1);
  api.initMemoryManager({ autoRun: false });
  if (provider) api.setModelProvider(provider);
  return api;
}

async function startChrome(
  label: string,
  port?: number,
  profileDir?: string,
  options?: { cleanProfile?: boolean },
): Promise<ChromeHandle> {
  const resolvedPort = port ?? await getFreePort();
  const resolvedProfileDir = profileDir ?? join(DATA_DIR, "chrome-profiles", label);
  if (options?.cleanProfile !== false) {
    rmSync(resolvedProfileDir, { recursive: true, force: true });
  }
  mkdirSync(resolvedProfileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${resolvedPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${resolvedProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--window-size=1200,900",
    "about:blank",
  ];
  if (process.env.SOAK_BROWSER_HEADLESS === "1") {
    args.unshift("--headless=new");
  }

  const child = spawn(CHROME_PATH, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle: ChromeHandle = {
    process: child,
    cdpUrl: `http://127.0.0.1:${resolvedPort}`,
    port: resolvedPort,
    profileDir: resolvedProfileDir,
    stderr: [],
    exited: false,
  };

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    handle.stderr.push(text);
    if (handle.stderr.length > 25) handle.stderr.shift();
  });
  child.stdout.resume();
  child.on("exit", () => {
    handle.exited = true;
  });
  child.on("error", (err) => {
    handle.stderr.push(err.message);
  });

  await waitForCdp(handle);
  return handle;
}

async function stopChrome(handle: ChromeHandle): Promise<void> {
  if (handle.exited || handle.process.exitCode !== null || handle.process.killed) return;
  handle.process.kill("SIGTERM");
  const exited = await Promise.race([
    once(handle.process, "exit").then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!exited && !handle.process.killed) {
    handle.process.kill("SIGKILL");
    await Promise.race([
      once(handle.process, "exit").then(() => true),
      sleep(2_000).then(() => false),
    ]);
  }
}

async function waitForCdp(handle: ChromeHandle): Promise<void> {
  const started = now();
  while (now() - started < DEFAULT_WAIT_MS) {
    if (handle.exited) {
      throw new Error(`Chrome exited before CDP became ready. stderr=${handle.stderr.join("").slice(-2000)}`);
    }
    try {
      const version = await getJson<{ webSocketDebuggerUrl?: string }>(`${handle.cdpUrl}/json/version`);
      if (version.webSocketDebuggerUrl) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for Chrome CDP at ${handle.cdpUrl}. stderr=${handle.stderr.join("").slice(-2000)}`);
}

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const req = http.get(url, { timeout: 3_000 }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString();
      });
      res.on("end", () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(raw) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`GET ${url} timed out`));
    });
    req.on("error", reject);
  });
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "Could not allocate a TCP port");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function startTestPageServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url !== "/") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end([
      "<!doctype html>",
      "<html>",
      "<head><title>Forge Agent Browser Tool Soak</title></head>",
      "<body>",
      "<main id='ready'>ForgeAgent browser tool page ready</main>",
      "<input id='name' />",
      "<button id='go' onclick=\"document.querySelector('#result').innerText = 'Hello ' + document.querySelector('#name').value\">Go</button>",
      "<div id='result'></div>",
      "<a class='nav' href='/alpha'>Alpha Link</a>",
      "<a class='nav' href='/beta'>Beta Link</a>",
      "</body>",
      "</html>",
    ].join(""));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "Test page server did not expose a port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.close();
      await once(server, "close").catch(() => undefined);
    },
  };
}

async function waitForRuntimeStatus(
  browser: BrowserRuntime,
  status: string,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    if (browser.status === status) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for runtime status ${status}; current=${browser.status}`);
}

async function waitForSessionStatus(
  api: CoreAPI,
  sessionId: string,
  status: string,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    if (api.getSession(sessionId)?.status === status) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for session ${sessionId} status ${status}; current=${api.getSession(sessionId)?.status}`);
}

async function waitForThreadEvent(
  api: CoreAPI,
  sessionId: string,
  predicate: (event: SessionEvent) => boolean,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<SessionEvent> {
  const started = now();
  while (now() - started < timeoutMs) {
    const event = api.getThread(sessionId).find(predicate);
    if (event) return event;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for thread event in ${sessionId}. events=${threadTypes(api.getThread(sessionId))}`);
}

function assertRuntimePayload(event: SessionEvent, detail: RuntimeEvent["detail"]): void {
  assert(event.type === "runtime_event", `Expected runtime_event, got ${event.type}`);
  assert(event.detail === detail, `Expected detail ${detail}, got ${event.detail}`);
  assert(event.payload?.kind === "attachment", `Expected attachment payload for ${detail}`);
  assert(event.payload.tabId.length > 0, `Missing tabId in ${detail} payload`);
}

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function threadTypes(events: SessionEvent[]): string {
  return events.map((event) => event.type === "runtime_event" ? `${event.type}:${event.detail}` : event.type).join(" -> ");
}

function lastAssistantText(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "assistant_message") return event.text;
  }
  return "";
}

function assertToolResult(
  events: SessionEvent[],
  toolName: string,
  expectedText: string,
): void {
  const result = events.find((event) =>
    event.type === "tool_result" &&
    event.toolName === toolName &&
    serializeForAssertion(event.result).includes(expectedText)
  );
  assert(result, `Missing ${toolName} tool_result containing ${expectedText}. Thread=${threadTypes(events)}`);
  assert(result.type === "tool_result" && !result.isError, `${toolName} result was marked isError`);
}

function serializeForAssertion(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assertProviderConfigured(): void {
  const hasEnvFile = existsSync(".env");
  const hasKey = Boolean(process.env.API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
  assert(hasEnvFile || hasKey, "ForgeAgent browser tool soak requires .env or provider API key environment variables.");
}

function resolveChromePath(): string {
  const candidates = [
    process.env.SOAK_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME ?? ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Google Chrome binary not found. Set SOAK_CHROME_PATH to the Chrome executable path.`);
  }
  return found;
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const scenarios: Array<[string, () => Promise<string>]> = [
    ["real_page_ops", scenarioRealPageOps],
    ["runtime_manager_attachment_events", scenarioRuntimeManagerAttachmentEvents],
    ["websocket_reconnect_reattach", scenarioWebSocketReconnectReattach],
    ["chrome_process_restart_target_lost", scenarioChromeProcessRestartTargetLost],
    ["forge_agent_browser_tools", scenarioForgeAgentBrowserTools],
  ];
  const selected = process.env.SOAK_BROWSER_SCENARIOS
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const runList = selected && selected.length > 0
    ? scenarios.filter(([name]) => selected.includes(name))
    : scenarios;
  assert(runList.length > 0, `No browser soak scenarios selected. Available: ${scenarios.map(([name]) => name).join(", ")}`);

  console.log(`[browser-soak] run=${RUN_ID} chrome=${CHROME_PATH} dataDir=${DATA_DIR}`);
  const results: ScenarioResult[] = [];
  for (const [name, scenario] of runList) {
    const result = await runScenario(name, scenario);
    results.push(result);
    console.log(`[browser-soak] ${result.ok ? "PASS" : "FAIL"} ${result.name} ${result.durationMs}ms ${result.detail.split("\n")[0]}`);
    if (!result.ok && process.env.SOAK_CONTINUE_ON_FAILURE !== "1") break;
  }

  const failed = results.filter((result) => !result.ok);
  const reportPath = join(DATA_DIR, "browser-soak-report.json");
  writeFileSync(reportPath, JSON.stringify({
    runId: RUN_ID,
    chromePath: CHROME_PATH,
    results,
  }, null, 2), "utf-8");
  console.log(`[browser-soak] report=${reportPath}`);
  console.log(`[browser-soak] summary pass=${results.length - failed.length} fail=${failed.length}`);

  if (failed.length > 0) {
    for (const failure of failed) {
      console.error(`[browser-soak] failure ${failure.name}\n${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
