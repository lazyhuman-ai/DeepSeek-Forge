import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuredToolOutput } from "../../src/tools/schemas.js";
import type { BrowserToolRuntime } from "../../src/tools/built-in/browser-shared.js";
import {
  clearBrowserRuntimesForTools,
  setDefaultBrowserRuntimeForTools,
  setBrowserRuntimeForTools,
} from "../../src/tools/built-in/browser-shared.js";
import {
  browserCreateTabTool,
  browserCurrentPageTool,
  browserExtractLinksTool,
  browserNavigateTool,
  browserWaitForSelectorTool,
} from "../../src/tools/built-in/browser-tools.js";

function fakeRuntime(overrides?: Partial<BrowserToolRuntime>): BrowserToolRuntime {
  return {
    createTab: vi.fn(async () => "tab_s1_test"),
    closeTab: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    typeText: vi.fn(async () => undefined),
    pressKey: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    scrollToBottom: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => true),
    extract: vi.fn(async () => "visible text"),
    extractLinks: vi.fn(async () => [{ href: "https://example.com/a", text: "A" }]),
    screenshot: vi.fn(async () => "abc123"),
    currentPage: vi.fn(async () => ({
      title: "Page",
      url: "https://example.com",
      textPreview: "Visible page preview",
    })),
    ...overrides,
  };
}

function expectToolError(value: unknown): StructuredToolOutput {
  expect(value).toMatchObject({ isError: true });
  return value as StructuredToolOutput;
}

describe("browser built-in tools", () => {
  afterEach(() => {
    clearBrowserRuntimesForTools();
  });

  it("returns a DeepSeek-Forge Webridge setup prompt when default browser runtime is not ready", async () => {
    const result = await browserNavigateTool.handler(
      { url: "https://example.com" },
      "s1",
    );

    const error = expectToolError(result);
    expect(String(error.output)).toContain("DeepSeek-Forge Webridge browser connection is not ready");
    expect(String(error.output)).toContain("Tool: browser_navigate");
    expect(String(error.output)).toContain("install or refresh the DeepSeek-Forge Webridge Chrome extension");
    expect(String(error.output)).toContain("runtime\":\"chrome");
  });

  it("defaults browser tools to DeepSeek-Forge Webridge even when another runtime is registered first", async () => {
    const chromeRuntime = fakeRuntime();
    const webridgeRuntime = fakeRuntime();
    setBrowserRuntimeForTools("chrome", chromeRuntime);
    setBrowserRuntimeForTools("webridge", webridgeRuntime);

    const created = await browserCreateTabTool.handler({}, "s1");
    const navigated = await browserNavigateTool.handler(
      { url: "https://example.com/search?q=wuyuan" },
      "s1",
    );
    const page = await browserCurrentPageTool.handler({}, "s1");
    const links = await browserExtractLinksTool.handler(
      { selector: "a.result" },
      "s1",
    );

    expect(created).toContain("tab_s1_test");
    expect(navigated).toContain("https://example.com/search");
    expect(page).toEqual({
      title: "Page",
      url: "https://example.com",
      textPreview: "Visible page preview",
    });
    expect(links).toEqual([{ href: "https://example.com/a", text: "A" }]);
    expect(webridgeRuntime.createTab).toHaveBeenCalledWith("s1");
    expect(webridgeRuntime.navigate).toHaveBeenCalledWith("s1", "https://example.com/search?q=wuyuan");
    expect(webridgeRuntime.extractLinks).toHaveBeenCalledWith("s1", "a.result");
    expect(chromeRuntime.createTab).not.toHaveBeenCalled();
  });

  it("can still use a non-default browser runtime explicitly", async () => {
    const runtime = fakeRuntime();
    setBrowserRuntimeForTools("chrome", runtime);

    const created = await browserCreateTabTool.handler({ runtime: "chrome" }, "s1");

    expect(created).toContain("tab_s1_test");
    expect(runtime.createTab).toHaveBeenCalledWith("s1");
  });

  it("allows custom default browser runtime names", async () => {
    const runtime = fakeRuntime();
    setBrowserRuntimeForTools("custom-webridge", runtime);
    setDefaultBrowserRuntimeForTools("custom-webridge");

    const created = await browserCreateTabTool.handler({}, "s1");

    expect(created).toContain("tab_s1_test");
    expect(runtime.createTab).toHaveBeenCalledWith("s1");
  });

  it("turns selector timeouts into agent-readable tool errors", async () => {
    const runtime = fakeRuntime({
      waitForSelector: vi.fn(async () => false),
    });
    setBrowserRuntimeForTools("webridge", runtime);

    const result = await browserWaitForSelectorTool.handler(
      { selector: ".note-card", timeout_ms: 123 },
      "s1",
    );

    const error = expectToolError(result);
    expect(String(error.output)).toContain("Browser selector was not found");
    expect(String(error.output)).toContain("Selector: .note-card");
    expect(String(error.output)).toContain("login/CAPTCHA/risk-control");
  });

  it("wraps runtime exceptions with action and recovery text", async () => {
    const runtime = fakeRuntime({
      navigate: vi.fn(async () => {
        throw new Error("No CDP session for s1. Call createTab() first.");
      }),
    });
    setBrowserRuntimeForTools("webridge", runtime);

    const result = await browserNavigateTool.handler(
      { url: "https://example.com" },
      "s1",
    );

    const error = expectToolError(result);
    expect(String(error.output)).toContain("Tool: browser_navigate");
    expect(String(error.output)).toContain("No CDP session for s1");
    expect(String(error.output)).toContain("Call browser_create_tab first");
  });

  it("rejects non-http navigation targets", async () => {
    const runtime = fakeRuntime();
    setBrowserRuntimeForTools("webridge", runtime);

    const result = await browserNavigateTool.handler(
      { url: "javascript:alert(1)" },
      "s1",
    );

    const error = expectToolError(result);
    expect(String(error.output)).toContain("Only http:// and https:// URLs are supported");
    expect(runtime.navigate).not.toHaveBeenCalled();
  });
});
