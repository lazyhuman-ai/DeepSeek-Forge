import type {
  ExecutableToolDefinition,
  StructuredToolOutput,
  ToolCapability,
  ToolParamSchema,
} from "../schemas.js";
import { buildTool } from "../schemas.js";
import {
  getBrowserRuntimeForTools,
  listBrowserRuntimeNamesForTools,
  type BrowserToolRuntime,
} from "./browser-shared.js";

type BrowserToolArgs = Record<string, unknown>;

const runtimeParam: ToolParamSchema = {
  type: "string",
  description: "Optional browser runtime name. Omit to use the default DeepSeek-Forge Webridge Chrome extension runtime.",
  optional: true,
};

const selectorParam: ToolParamSchema = {
  type: "string",
  description: "CSS selector in the current browser tab.",
};

const browserCapabilities: ToolCapability[] = ["runtime.browser"];
const browserNetworkCapabilities: ToolCapability[] = ["runtime.browser", "network.http"];

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolveRuntime(
  args: BrowserToolArgs,
  toolName: string,
  action: string,
): BrowserToolRuntime | StructuredToolOutput {
  const runtimeName = optionalString(args.runtime);
  const runtime = getBrowserRuntimeForTools(runtimeName);
  if (runtime) return runtime;
  const known = listBrowserRuntimeNamesForTools();
  return {
    isError: true,
    output: [
      "DeepSeek-Forge Webridge browser connection is not ready before execution.",
      `Tool: ${toolName}`,
      `Requested action: ${action}`,
      runtimeName ? `Requested runtime: ${runtimeName}` : "Requested runtime: default DeepSeek-Forge Webridge runtime",
      `Available runtimes: ${known.length > 0 ? known.join(", ") : "none"}`,
      "Reason: Browser tools default to the DeepSeek-Forge Webridge Chrome extension, but that runtime is not registered in this process.",
      "Recovery: Start the DeepSeek-Forge HTTP gateway, install or refresh the DeepSeek-Forge Webridge Chrome extension, pair it with the gateway, then retry. If you intentionally want CDP instead, pass an explicit runtime name such as {\"runtime\":\"chrome\"}.",
    ].join("\n"),
  };
}

function toolError(
  toolName: string,
  action: string,
  err: unknown,
  recovery: string,
): StructuredToolOutput {
  const reason = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    output: [
      "Browser tool failed during execution.",
      `Tool: ${toolName}`,
      `Requested action: ${action}`,
      `Reason: ${reason}`,
      `Recovery: ${recovery}`,
    ].join("\n"),
  };
}

function isStructuredToolOutput(value: unknown): value is StructuredToolOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    "output" in value
  );
}

function assertHttpUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http:// and https:// URLs are supported by browser_navigate. Received: ${url}`);
  }
}

async function withBrowser<T>(
  args: BrowserToolArgs,
  toolName: string,
  action: string,
  recovery: string,
  fn: (runtime: BrowserToolRuntime) => Promise<T>,
): Promise<T | StructuredToolOutput> {
  const runtime = resolveRuntime(args, toolName, action);
  if (isStructuredToolOutput(runtime)) return runtime;
  try {
    return await fn(runtime);
  } catch (err) {
    return toolError(toolName, action, err, recovery);
  }
}

export const browserCreateTabTool: ExecutableToolDefinition = buildTool({
  name: "browser_create_tab",
  description: [
    "Create and attach a browser tab for the current session.",
    "Use this before browser_navigate unless a tab is already attached.",
    "Operate through normal visible browser flows; if login, CAPTCHA, or risk-control UI appears, ask the user to handle it.",
  ].join(" "),
  params: {
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: false,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_create_tab",
    "runtime.browser.create_tab",
    "Retry after the browser runtime is online, or ask the user to configure a browser runtime.",
    async (runtime) => {
      const tabId = await runtime.createTab(sessionId);
      return `Browser tab created and attached. tabId=${tabId}`;
    },
  ),
});

export const browserCloseTabTool: ExecutableToolDefinition = buildTool({
  name: "browser_close_tab",
  description: "Close the current session's attached browser tab.",
  params: {
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: false,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_close_tab",
    "runtime.browser.close_tab",
    "If no tab is attached, call browser_create_tab before continuing browser work.",
    async (runtime) => {
      await runtime.closeTab(sessionId);
      return "Browser tab closed.";
    },
  ),
});

export const browserNavigateTool: ExecutableToolDefinition = buildTool({
  name: "browser_navigate",
  description: [
    "Navigate the current session's attached browser tab to an HTTP(S) URL.",
    "Preserve full URLs exactly as extracted, including query parameters, signed tokens, and source parameters; some sites route incorrectly if links are simplified.",
    "Use normal user-visible navigation. Do not attempt fingerprint cloaking, CAPTCHA bypass, or scraping at scale.",
  ].join(" "),
  params: {
    url: { type: "string", description: "HTTP(S) URL to navigate to." },
    runtime: runtimeParam,
  },
  capabilities: browserNetworkCapabilities,
  isConcurrencySafe: false,
  isReadOnly: false,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_navigate",
    "runtime.browser.navigate",
    "Call browser_create_tab first, use a valid http(s) URL, or ask the user to resolve browser/runtime setup.",
    async (runtime) => {
      const url = requireString(args.url, "url");
      assertHttpUrl(url);
      await runtime.navigate(sessionId, url);
      return `Navigated browser tab to ${url}`;
    },
  ),
});

export const browserCurrentPageTool: ExecutableToolDefinition = buildTool({
  name: "browser_current_page",
  description: "Return the current browser tab title, URL, and a short visible text preview.",
  params: {
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: true,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_current_page",
    "runtime.browser.current_page",
    "Call browser_create_tab and browser_navigate before reading the current page.",
    async (runtime) => await runtime.currentPage(sessionId),
  ),
});

export const browserWaitForSelectorTool: ExecutableToolDefinition = buildTool({
  name: "browser_wait_for_selector",
  description: "Wait until a CSS selector exists in the current browser tab.",
  params: {
    selector: selectorParam,
    timeout_ms: { type: "number", description: "Timeout in milliseconds. Default 10000.", optional: true },
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: true,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_wait_for_selector",
    "runtime.browser.wait_for_selector",
    "Verify the selector against visible page content, wait longer, navigate to the intended page, or ask the user if the page is blocked.",
    async (runtime) => {
      const selector = requireString(args.selector, "selector");
      const timeoutMs = optionalNumber(args.timeout_ms, 10_000);
      const found = await runtime.waitForSelector(sessionId, selector, timeoutMs);
      if (!found) {
        return {
          isError: true,
          output: [
            "Browser selector was not found before timeout.",
            "Tool: browser_wait_for_selector",
            "Requested action: runtime.browser.wait_for_selector",
            `Selector: ${selector}`,
            `Timeout: ${timeoutMs}ms`,
            "Reason: The selector did not appear in the current page.",
            "Recovery: Check the current page with browser_current_page or browser_extract, use a selector matching visible content, wait longer, or ask the user to handle login/CAPTCHA/risk-control UI.",
          ].join("\n"),
        };
      }
      return `Selector ${selector} found within ${timeoutMs}ms.`;
    },
  ),
});

export const browserTypeTextTool: ExecutableToolDefinition = buildTool({
  name: "browser_type_text",
  description: "Set text in an input, textarea, or contenteditable element matched by a CSS selector.",
  params: {
    selector: selectorParam,
    text: { type: "string", description: "Text to enter." },
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: false,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_type_text",
    "runtime.browser.type_text",
    "Use browser_extract or browser_current_page to find a correct editable selector, then retry.",
    async (runtime) => {
      const selector = requireString(args.selector, "selector");
      const text = requireString(args.text, "text");
      await runtime.typeText(sessionId, selector, text);
      return `Typed ${JSON.stringify(text)} into ${selector}.`;
    },
  ),
});

export const browserPressKeyTool: ExecutableToolDefinition = buildTool({
  name: "browser_press_key",
  description: "Press a keyboard key in the current browser tab, for example Enter after filling a search box.",
  params: {
    key: { type: "string", description: "Key to press, for example Enter, Escape, Tab, Backspace, or ArrowDown." },
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: false,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_press_key",
    "runtime.browser.press_key",
    "Focus the intended element with browser_click or browser_type_text before pressing the key.",
    async (runtime) => {
      const key = requireString(args.key, "key");
      await runtime.pressKey(sessionId, key);
      return `Pressed key ${key}.`;
    },
  ),
});

export const browserClickTool: ExecutableToolDefinition = buildTool({
  name: "browser_click",
  description: "Click an element matched by a CSS selector in the current browser tab.",
  params: {
    selector: selectorParam,
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: false,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_click",
    "runtime.browser.click",
    "Use browser_extract/browser_extract_links to find a valid selector, then retry. If the page shows login or CAPTCHA, ask the user to handle it.",
    async (runtime) => {
      const selector = requireString(args.selector, "selector");
      await runtime.click(sessionId, selector);
      return `Clicked ${selector}.`;
    },
  ),
});

export const browserScrollTool: ExecutableToolDefinition = buildTool({
  name: "browser_scroll",
  description: "Scroll the current browser tab by a vertical pixel delta, or to the bottom.",
  params: {
    delta_y: { type: "number", description: "Vertical scroll delta in pixels. Default 800.", optional: true },
    to_bottom: { type: "boolean", description: "When true, scroll to the bottom of the page.", optional: true },
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: false,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_scroll",
    "runtime.browser.scroll",
    "Call browser_create_tab and browser_navigate first, then retry scrolling.",
    async (runtime) => {
      if (args.to_bottom === true) {
        await runtime.scrollToBottom(sessionId);
        return "Scrolled browser tab to bottom.";
      }
      const deltaY = optionalNumber(args.delta_y, 800);
      await runtime.scroll(sessionId, deltaY);
      return `Scrolled browser tab by deltaY=${deltaY}.`;
    },
  ),
});

export const browserExtractTool: ExecutableToolDefinition = buildTool({
  name: "browser_extract",
  description: "Extract visible text from the current browser tab, optionally scoped to a CSS selector.",
  params: {
    selector: { ...selectorParam, description: "Optional CSS selector to scope visible text extraction.", optional: true },
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: true,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_extract",
    "runtime.browser.extract_text",
    "Use browser_current_page to confirm the page and selector, then retry with a visible selector.",
    async (runtime) => {
      const selector = optionalString(args.selector);
      return await runtime.extract(sessionId, selector);
    },
  ),
});

export const browserExtractLinksTool: ExecutableToolDefinition = buildTool({
  name: "browser_extract_links",
  description: "Extract links from the current browser tab using a CSS selector. Useful for collecting exact source URLs before opening a small number of pages. Keep returned URLs intact; do not strip query parameters or signed/source tokens.",
  params: {
    selector: { ...selectorParam, description: "CSS selector for links. Default a[href].", optional: true },
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: true,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_extract_links",
    "runtime.browser.extract_links",
    "Use a selector that matches visible links, such as a[href] or a[href*=\"/search_result/\"].",
    async (runtime) => {
      const selector = optionalString(args.selector);
      return await runtime.extractLinks(sessionId, selector);
    },
  ),
});

export const browserScreenshotTool: ExecutableToolDefinition = buildTool({
  name: "browser_screenshot",
  description: "Capture a screenshot of the current browser tab and return a compact readable summary.",
  params: {
    runtime: runtimeParam,
  },
  capabilities: browserCapabilities,
  isConcurrencySafe: false,
  isReadOnly: true,
  handler: async (args, sessionId) => await withBrowser(
    args,
    "browser_screenshot",
    "runtime.browser.screenshot",
    "Use browser_current_page or browser_extract if screenshot capture fails.",
    async (runtime) => {
      const data = await runtime.screenshot(sessionId);
      return `Screenshot captured. base64Length=${data.length} approxBytes=${Buffer.byteLength(data, "base64")}`;
    },
  ),
});

export const browserTools = [
  browserCreateTabTool,
  browserCloseTabTool,
  browserNavigateTool,
  browserCurrentPageTool,
  browserWaitForSelectorTool,
  browserTypeTextTool,
  browserPressKeyTool,
  browserClickTool,
  browserScrollTool,
  browserExtractTool,
  browserExtractLinksTool,
  browserScreenshotTool,
];
